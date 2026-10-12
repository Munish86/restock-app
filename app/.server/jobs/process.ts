// Runs one queued job: claims it, runs the handler for its command (sync, supplier import) and keeps the Job
// row up to date (progress, log, stop requests) while it runs. Everything it touches comes in through `deps`,
// so the same code runs in the worker, in the in-process dev queue and in tests.
import type { FileStorage } from "../storage";
import { reportKey } from "../storage";

export interface ClaimedJob {
  id: string;
  shop: string;
  command: string;
  options: Record<string, unknown> | null;
  attempts: number;
}

export interface Progress {
  done: number;
  total: number;
  step?: string;
}

export type FinalStatus = "done" | "failed" | "stopped";

export interface JobRepo {
  // queued -> running (attempts + 1). null if the job is not queued (already taken, stopped, deleted).
  claim(jobId: string): Promise<ClaimedJob | null>;
  // Saves progress and the latest log; tells whether the merchant asked to stop
  heartbeat(jobId: string, data: { progress?: Progress; log: string }): Promise<{ stopAsked: boolean }>;
  finish(
    jobId: string,
    data: { status: FinalStatus; log: string; progress?: Progress; counts?: Record<string, number>; reportKey?: string; error?: string },
  ): Promise<void>;
  // Back to queued, for a job cut off by a server restart
  requeue(jobId: string, log: string): Promise<void>;
}

export interface JobContext {
  job: ClaimedJob;
  log: (message: string) => void;
  progress: (p: Progress) => void;
  shouldStop: () => boolean;
}

export interface JobResult {
  counts?: Record<string, number>;
  report?: unknown; // saved to file storage when present
  stopped?: boolean;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export interface ProcessDeps {
  repo: JobRepo;
  storage: FileStorage;
  handlers: Record<string, JobHandler>;
  heartbeatMs?: number;
  // True when the worker is shutting down: the job stops at the next safe point and is re-queued
  shuttingDown?: () => boolean;
}

export const MAX_ATTEMPTS = 3;
const LOG_KEEP = 100_000; // characters of log kept on the Job row

export type ProcessOutcome = FinalStatus | "requeued" | "skipped";

export async function processJob(jobId: string, deps: ProcessDeps): Promise<ProcessOutcome> {
  const job = await deps.repo.claim(jobId);
  if (!job) return "skipped";

  const lines: string[] = [];
  let logSize = 0;
  const log = (m: string) => {
    const line = `${new Date().toISOString().slice(11, 19)}  ${m}`;
    lines.push(line);
    logSize += line.length + 1;
    while (logSize > LOG_KEEP * 2 && lines.length > 1) logSize -= lines.shift()!.length + 1;
  };
  const logText = () => {
    const all = lines.join("\n");
    return all.length > LOG_KEEP ? "...\n" + all.slice(-LOG_KEEP) : all;
  };

  if (job.attempts > MAX_ATTEMPTS) {
    log(`This run was interrupted ${MAX_ATTEMPTS} times, so it was not started again.`);
    await deps.repo.finish(jobId, {
      status: "failed",
      log: logText(),
      error: "The run kept stopping unexpectedly. Try again later, or contact support.",
    });
    return "failed";
  }
  if (job.attempts > 1) log(`Started again after an interruption (attempt ${job.attempts}).`);

  let progress: Progress | undefined;
  let stopAsked = false;
  const shuttingDown = deps.shuttingDown || (() => false);

  let beating: Promise<void> | null = null;
  const beat = () => {
    beating ??= deps.repo
      .heartbeat(jobId, { progress, log: logText() })
      .then((r) => {
        if (r.stopAsked) stopAsked = true;
      })
      .catch((e) => console.error(`Heartbeat failed for job ${jobId}:`, e))
      .finally(() => {
        beating = null;
      });
    return beating;
  };
  const timer = setInterval(beat, deps.heartbeatMs ?? 2000);

  try {
    const handler = deps.handlers[job.command];
    if (!handler) throw new Error(`Unknown command "${job.command}".`);
    const result = await handler({
      job,
      log,
      progress: (p) => (progress = p),
      shouldStop: () => stopAsked || shuttingDown(),
    });

    clearInterval(timer);
    await beating;
    if (result.stopped && !stopAsked && shuttingDown()) {
      log("The server is restarting. This run will continue shortly.");
      await deps.repo.requeue(jobId, logText());
      return "requeued";
    }

    let key: string | undefined;
    if (result.report !== undefined) {
      key = reportKey(job.shop, jobId);
      await deps.storage.put(key, Buffer.from(JSON.stringify(result.report)), "application/json");
    }
    const status: FinalStatus = result.stopped ? "stopped" : "done";
    if (result.stopped) log("Stopped.");
    await deps.repo.finish(jobId, { status, log: logText(), progress, counts: result.counts, reportKey: key });
    return status;
  } catch (e) {
    clearInterval(timer);
    await beating;
    const message = (e as Error).message || String(e);
    log(`ERROR: ${message}`);
    if (!(e instanceof Error) || !message) console.error(e);
    await deps.repo.finish(jobId, { status: "failed", log: logText(), progress, error: message });
    return "failed";
  }
}
