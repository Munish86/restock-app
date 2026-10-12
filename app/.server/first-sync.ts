// Starts the very first sync of a store (after install, or when the app opens and has never synced).
import prisma from "../db.server";
import { enqueueJob, JobError } from "./jobs/service";

export async function startFirstSync(shop: string) {
  const s = await prisma.shop.findUnique({ where: { shop }, select: { syncedAt: true } });
  if (s?.syncedAt) return;
  const tried = await prisma.job.findFirst({
    where: { shop, command: "sync", OR: [{ status: { in: ["queued", "running"] } }, { createdAt: { gt: new Date(Date.now() - 10 * 60 * 1000) } }] },
  });
  if (tried) return;
  try {
    await enqueueJob(shop, "sync", { full: true });
  } catch (e) {
    if (!(e instanceof JobError)) console.error(`First sync for ${shop} could not start:`, e);
  }
}
