// Starting, stopping and reading jobs, plus the worker's housekeeping. Database side of the job system.
import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { FileMissingError, getStorage } from "../storage";
import type { ClaimedJob, JobRepo } from "./process";
import { getQueue, type JobQueue } from "./queue";
import { parseImportOptions, type ImportOptions } from "../imports";

export const ACTIVE = ["queued", "running"];

export class JobError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const JOB_COMMANDS = ["sync", "import-plan", "import"] as const;
export type JobCommand = (typeof JOB_COMMANDS)[number];

export type JobOptions = { full?: boolean } | ImportOptions;

// Checks what the browser sent. Never trust it to be well-formed.
export function parseJobRequest(body: unknown): { command: JobCommand; options: JobOptions } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!JOB_COMMANDS.includes(b.command as JobCommand)) throw new JobError('command must be "sync", "import-plan" or "import".');
  const command = b.command as JobCommand;
  if (command === "sync") return { command, options: b.full === true ? { full: true } : {} };
  try {
    return { command, options: parseImportOptions(b.options) };
  } catch (e) {
    throw new JobError((e as Error).message);
  }
}

// One active job per shop. The Shop row is locked while checking, so two clicks cannot start two runs.
export async function enqueueJob(shop: string, command: JobCommand, options: JobOptions, queue: JobQueue = getQueue()) {
  const job = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Shop" WHERE "shop" = ${shop} FOR UPDATE`;
    const active = await tx.job.findFirst({ where: { shop, status: { in: ACTIVE } }, select: { id: true, command: true } });
    if (active) {
      throw new JobError(
        active.command === "sync"
          ? "A sync with Shopify is running. Wait for it to finish (it usually takes a minute or two)."
          : "An import is running. Wait for it to finish or stop it first.",
        409,
      );
    }
    return tx.job.create({ data: { shop, command, options: options as Prisma.InputJsonValue } });
  });
  try {
    await queue.add(job.id, job.id);
  } catch (e) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "failed", error: "The run could not be started. Try again in a minute.", finishedAt: new Date() },
    });
    throw e;
  }
  return job;
}

// A queued job stops at once; a running job stops at the next safe point
export async function requestStop(shop: string, jobId: string) {
  await prisma.job.updateMany({
    where: { id: jobId, shop, status: "queued" },
    data: { status: "stopped", stopAsked: true, finishedAt: new Date() },
  });
  const r = await prisma.job.updateMany({ where: { id: jobId, shop, status: "running" }, data: { stopAsked: true } });
  return r.count > 0;
}

const JOB_FIELDS = {
  id: true,
  command: true,
  status: true,
  options: true,
  progress: true,
  counts: true,
  error: true,
  stopAsked: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.JobSelect;

export async function getJob(shop: string, jobId: string, { withLog = false } = {}) {
  return prisma.job.findFirst({ where: { id: jobId, shop }, select: { ...JOB_FIELDS, log: withLog } });
}

export async function listJobs(shop: string, take = 20, command?: string | string[]) {
  return prisma.job.findMany({
    where: { shop, ...(command ? { command: { in: Array.isArray(command) ? command : [command] } } : {}) },
    select: JOB_FIELDS,
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function activeJob(shop: string) {
  return prisma.job.findFirst({ where: { shop, status: { in: ACTIVE } }, select: JOB_FIELDS, orderBy: { createdAt: "desc" } });
}

export async function readReport<T = unknown>(shop: string, jobId: string): Promise<T | null> {
  const job = await prisma.job.findFirst({ where: { id: jobId, shop }, select: { reportKey: true } });
  if (!job?.reportKey) return null;
  try {
    return JSON.parse((await getStorage().get(job.reportKey)).toString("utf8")) as T;
  } catch (e) {
    if (e instanceof FileMissingError) return null;
    throw e;
  }
}

// ---- Used by the worker ----

export function prismaJobRepo(queue: JobQueue = getQueue()): JobRepo {
  return {
    async claim(jobId) {
      const now = new Date();
      const r = await prisma.job.updateMany({
        where: { id: jobId, status: "queued", stopAsked: false },
        data: { status: "running", startedAt: now, heartbeatAt: now, attempts: { increment: 1 } },
      });
      if (!r.count) return null;
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, shop: true, command: true, options: true, attempts: true },
      });
      return job as ClaimedJob | null;
    },
    async heartbeat(jobId, { progress, log }) {
      try {
        return await prisma.job.update({
          where: { id: jobId },
          data: { progress: progress as Prisma.InputJsonValue | undefined, log, heartbeatAt: new Date() },
          select: { stopAsked: true },
        });
      } catch (e) {
        // The job row is gone (the store's data was deleted): stop
        if ((e as { code?: string }).code === "P2025") return { stopAsked: true };
        throw e;
      }
    },
    async finish(jobId, d) {
      await prisma.job.updateMany({
        where: { id: jobId, status: "running" },
        data: {
          status: d.status,
          log: d.log,
          progress: d.progress as Prisma.InputJsonValue | undefined,
          counts: d.counts as Prisma.InputJsonValue | undefined,
          reportKey: d.reportKey,
          error: d.error,
          finishedAt: new Date(),
        },
      });
    },
    async requeue(jobId, log) {
      const r = await prisma.job.updateMany({
        where: { id: jobId, status: "running" },
        data: { status: "queued", log, startedAt: null, heartbeatAt: null },
      });
      if (r.count) await queue.add(jobId, `${jobId}-${Date.now()}`);
    },
  };
}

const STALE_MS = 2 * 60 * 1000;

// Jobs whose worker died (no heartbeat) go back to the queue; queued jobs missing from the queue
// (for example after Redis was emptied) are added again.
export async function sweepJobs(queue: JobQueue = getQueue()) {
  const stale = await prisma.job.findMany({
    where: { status: "running", heartbeatAt: { lt: new Date(Date.now() - STALE_MS) } },
    select: { id: true },
  });
  for (const { id } of stale) {
    const r = await prisma.job.updateMany({
      where: { id, status: "running" },
      data: { status: "queued", startedAt: null, heartbeatAt: null },
    });
    if (r.count) await queue.add(id, `${id}-${Date.now()}`);
  }
  const waiting = await prisma.job.findMany({
    where: { status: "queued", stopAsked: false, createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
    select: { id: true },
  });
  for (const { id } of waiting) await queue.add(id, id);
  return { requeued: stale.length, readded: waiting.length };
}

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION = {
  fileDays: Number(process.env.FILE_RETENTION_DAYS || 7),
  jobDays: 90,
  emailDays: 180,
  // Sales kept: two years for the forecast and last year's comparison, plus a little
  salesDays: 800,
};

// Deletes old uploads, reports, jobs, email log rows and sales older than the forecast can use
export async function cleanupOldData() {
  const storage = getStorage();
  const busy = (await prisma.job.findMany({ where: { status: { in: ACTIVE } }, select: { shop: true } })).map((j) => j.shop);

  const files = await prisma.storedFile.findMany({
    where: { createdAt: { lt: new Date(Date.now() - RETENTION.fileDays * DAY) }, shop: { notIn: busy } },
    select: { id: true, storageKey: true },
    take: 5000,
  });
  for (const f of files) {
    if (f.storageKey) await storage.delete(f.storageKey);
    await prisma.storedFile.delete({ where: { id: f.id } });
  }

  const jobs = await prisma.job.findMany({
    where: { createdAt: { lt: new Date(Date.now() - RETENTION.jobDays * DAY) }, status: { notIn: ACTIVE } },
    select: { id: true, reportKey: true },
    take: 5000,
  });
  for (const j of jobs) {
    if (j.reportKey) await storage.delete(j.reportKey);
    await prisma.job.delete({ where: { id: j.id } });
  }

  const emails = await prisma.emailLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - RETENTION.emailDays * DAY) } } });
  const old = new Date(Date.now() - RETENTION.salesDays * DAY);
  const sales = await prisma.salesDay.deleteMany({ where: { day: { lt: old } } });
  const outDays = await prisma.outOfStockDay.deleteMany({ where: { day: { lt: old } } });
  return { files: files.length, jobs: jobs.length, emails: emails.count, sales: sales.count + outDays.count };
}
