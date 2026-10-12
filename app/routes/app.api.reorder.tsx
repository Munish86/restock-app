// GET /app/api/reorder            the reorder list: every active variant with its forecast, plus totals
// GET /app/api/reorder?view=dead  the dead stock list
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { apiError } from "../.server/http";
import { deadStock, loadPlanning, summary } from "../.server/planning";
import { activeJob, listJobs } from "../.server/jobs/service";
import { signedUrl } from "../.server/signed";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const view = new URL(request.url).searchParams.get("view");
    const [p, suppliers, job, lastSync] = await Promise.all([
      loadPlanning(shop),
      prisma.supplier.findMany({ where: { shop }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      activeJob(shop),
      listJobs(shop, 1, "sync"),
    ]);
    const meta = {
      today: p.today,
      currency: p.currency,
      planKey: p.planKey,
      variantLimit: p.variantLimit,
      totalVariants: p.totalVariants,
      syncedAt: p.syncedAt,
      ordersFrom: p.ordersFrom,
      allOrders: p.allOrders,
      seasonalUsed: p.seasonalUsed,
      settings: p.settings.forecast,
      countedLocations: p.locations.filter((l) => p.countedLocationIds.includes(l.id)).map((l) => l.name),
      suppliers,
      activeJob: job,
      lastSync: lastSync[0] ?? null,
    };
    if (view === "dead") {
      return Response.json({ ...meta, rows: deadStock(p), csvUrl: signedUrl("dead-csv", shop, "all") });
    }
    return Response.json({ ...meta, summary: summary(p), rows: p.rows, csvUrl: signedUrl("reorder-csv", shop, "all") });
  } catch (e) {
    return apiError(e);
  }
};
