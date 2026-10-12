// Background worker: runs queued syncs and supplier imports from BullMQ, and the timed work (a sync for
// every store every few hours, alert emails) once a minute.
// Production: `npm run build && npm run worker` as its own service, next to the web server.
// Needs the same environment as the web server (DATABASE_URL, REDIS_URL, SHOPIFY_*, R2_*, RESEND_*).
import { Worker } from "bullmq";

// Check the environment before loading the app code, which fails with less clear errors without it
const missing = ["REDIS_URL", "DATABASE_URL", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"].filter(
  (k) => !process.env[k],
);
if (missing.length) {
  console.error(`The worker cannot start. Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const { productionDeps } = await import("./app/.server/jobs/deps");
const { processJob } = await import("./app/.server/jobs/process");
const { getQueue, QUEUE_NAME, redisConnection } = await import("./app/.server/jobs/queue");
const { cleanupOldData, sweepJobs } = await import("./app/.server/jobs/service");
const { tick } = await import("./app/.server/scheduler");

const connection = redisConnection()!;

// Jobs from different stores run side by side; each store has at most one job at a time
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 4));
let shuttingDown = false;
const deps = productionDeps({ queue: getQueue(), shuttingDown: () => shuttingDown });

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const outcome = await processJob(job.data.jobId, deps);
    console.log(`Job ${job.data.jobId}: ${outcome}`);
    return outcome;
  },
  {
    connection,
    concurrency,
    // A long sync must not be treated as stalled: the lock is renewed while the job runs
    lockDuration: 60_000,
  },
);
worker.on("error", (e) => console.error("Worker error:", e));

async function housekeeping() {
  try {
    const s = await sweepJobs();
    if (s.requeued || s.readded) console.log(`Sweep: ${s.requeued} interrupted jobs re-queued, ${s.readded} re-added`);
  } catch (e) {
    console.error("Sweep failed:", e);
  }
  if (!shuttingDown) await tick();
}
let lastCleanup = 0;
async function cleanup() {
  if (Date.now() - lastCleanup < 60 * 60 * 1000) return;
  lastCleanup = Date.now();
  try {
    const c = await cleanupOldData();
    if (c.files || c.jobs || c.emails || c.sales) {
      console.log(`Cleanup: ${c.files} files, ${c.jobs} jobs, ${c.emails} email log rows, ${c.sales} old sales rows deleted`);
    }
  } catch (e) {
    console.error("Cleanup failed:", e);
  }
}
void housekeeping();
const timer = setInterval(() => void housekeeping().then(cleanup), 60_000);

// On deploy or restart: running jobs stop at the next safe point and go back to the queue
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: finishing the work in progress, then stopping`);
  clearInterval(timer);
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`Worker started (${concurrency} jobs at a time)`);
