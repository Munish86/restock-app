// Timed work, run every minute by the worker (and by the web server in local development):
// a sync for every store every few hours, and the alert emails that are due.
import prisma from "../db.server";
import { runDueAlerts } from "./alerts";
import { ACTIVE, enqueueJob, JobError } from "./jobs/service";

export const SYNC_EVERY_HOURS = Number(process.env.SYNC_EVERY_HOURS || 6);
const HOUR = 3600 * 1000;

// Stores whose data is older than SYNC_EVERY_HOURS get a sync. A store whose last sync failed waits an hour
// before the next try, so a store that keeps failing (uninstalled, frozen) is not hammered.
export async function queueDueSyncs(now = new Date(), take = 20) {
  const due = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      OR: [{ syncedAt: null }, { syncedAt: { lt: new Date(now.getTime() - SYNC_EVERY_HOURS * HOUR) } }],
      jobs: {
        none: {
          OR: [
            { status: { in: ACTIVE } },
            { command: "sync", status: "failed", finishedAt: { gt: new Date(now.getTime() - HOUR) } },
            // A first sync is started by the app when it opens; leave it a few minutes
            { command: "sync", createdAt: { gt: new Date(now.getTime() - 10 * 60 * 1000) } },
          ],
        },
      },
      // Has a working session (offline token) to sync with
      installedAt: { lt: new Date(now.getTime() - 5 * 60 * 1000) },
    },
    select: { shop: true },
    orderBy: { syncedAt: { sort: "asc", nulls: "first" } },
    take,
  });
  let queued = 0;
  for (const { shop } of due) {
    const hasSession = await prisma.session.count({ where: { shop, isOnline: false } });
    if (!hasSession) continue;
    try {
      await enqueueJob(shop, "sync", {});
      queued++;
    } catch (e) {
      if (!(e instanceof JobError)) console.error(`Could not queue a sync for ${shop}:`, e);
    }
  }
  return queued;
}

let running = false;

export async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const synced = await queueDueSyncs(now).catch((e) => {
      console.error("Scheduled syncs failed:", e);
      return 0;
    });
    const emails = await runDueAlerts(now).catch((e) => {
      console.error("Alerts failed:", e);
      return 0;
    });
    if (synced || emails) console.log(`Scheduler: ${synced} syncs queued, ${emails} alert checks`);
  } finally {
    running = false;
  }
}
