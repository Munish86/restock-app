// The job queue. With REDIS_URL set, jobs go to BullMQ and a separate worker process runs them
// (worker.ts). Without it (local development), jobs run inside the web process.
import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const QUEUE_NAME = "restock-jobs";

export interface JobQueue {
  // dedupeId: a job already waiting with this id is not added twice
  add(jobId: string, dedupeId?: string): Promise<void>;
}

// A new Redis client from REDIS_URL (redis:// or rediss:// for TLS), or null when it is not set.
// BullMQ needs a ready-made client in an ES module app, and a separate one for each Queue / Worker.
export function redisConnection(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return new Redis(url, {
    // Required by BullMQ workers: commands wait for a reconnect instead of failing
    maxRetriesPerRequest: null,
    // Railway's private network is IPv6 only; 0 = try both
    family: 0,
  });
}

class BullQueue implements JobQueue {
  private q: Queue;
  constructor(connection: Redis) {
    this.q = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: 1000 },
    });
  }
  async add(jobId: string, dedupeId?: string) {
    await this.q.add("run", { jobId }, dedupeId ? { jobId: dedupeId } : {});
  }
}

// Runs jobs in this process, a few at a time. For local development without Redis.
export class InProcessQueue implements JobQueue {
  private waiting: string[] = [];
  private active = 0;
  constructor(
    private run: (jobId: string) => Promise<unknown>,
    private concurrency = 2,
  ) {}
  async add(jobId: string, dedupeId?: string) {
    if (dedupeId && this.waiting.includes(jobId)) return;
    this.waiting.push(jobId);
    this.next();
  }
  private next() {
    while (this.active < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift()!;
      this.active++;
      this.run(id)
        .catch((e) => console.error(`Job ${id} failed to run:`, e))
        .finally(() => {
          this.active--;
          this.next();
        });
    }
  }
  // For tests: resolves when nothing is waiting or running
  async idle() {
    while (this.active || this.waiting.length) await new Promise((r) => setTimeout(r, 10));
  }
}

let queue: JobQueue | null = null;

export function getQueue(): JobQueue {
  if (queue) return queue;
  const connection = redisConnection();
  if (connection) {
    queue = new BullQueue(connection);
  } else {
    if (process.env.NODE_ENV === "production") {
      console.warn("REDIS_URL is not set: jobs run inside the web server and stop when it restarts.");
    }
    queue = new InProcessQueue(async (jobId) => {
      const { processJob } = await import("./process");
      const { productionDeps } = await import("./deps");
      return processJob(jobId, productionDeps());
    });
    // No worker process either: run the timed work (scheduled syncs, alert emails) here
    if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
      const timer = setInterval(() => {
        void import("../scheduler").then((m) => m.tick()).catch((e) => console.error("Scheduler failed:", e));
      }, 60_000);
      timer.unref?.();
    }
  }
  return queue;
}

export function setQueue(q: JobQueue | null) {
  queue = q;
}
