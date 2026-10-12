// Sync: copies the store's variants, stock per location and daily sales from Shopify into the app's database.
// Large reads use Shopify bulk operations (one export file instead of thousands of requests). The first sync
// reads up to two years of orders; later syncs re-read the last 35 days, which also picks up refunds and
// cancellations. Only daily totals per variant are kept: no orders, no customers.
import prisma from "../db.server";
import { addDays, localDay } from "../lib/dates";
import { planByKey } from "../lib/plans";
import { withDefaults } from "../lib/settings";
import { readJsonl, StopRequested, type Shopify } from "./core/shopify";
import type { JobContext, JobResult } from "./jobs/process";
import { sqlTime, upsertRows } from "./sql";

export const HISTORY_DAYS_ALL = 730; // with read_all_orders
export const HISTORY_DAYS_DEFAULT = 60; // what Shopify gives apps without read_all_orders
export const INCREMENTAL_DAYS = 35;

// ---------------------------------------------------------------------------------------------------------
// Bulk queries and their parsers (pure, tested on their own)
// ---------------------------------------------------------------------------------------------------------

export const VARIANTS_QUERY = `{
  productVariants {
    edges { node {
      id title sku barcode price requiresComponents
      product { id title vendor productType status createdAt featuredMedia { preview { image { url } } } }
      inventoryItem {
        id tracked unitCost { amount }
        inventoryLevels { edges { node { location { id } quantities(names: ["available", "on_hand", "incoming"]) { name quantity } } } }
      }
      productVariantComponents { edges { node { quantity productVariant { id } } } }
    } }
  }
}`;

// Orders created from `fromIso` on. Only what the forecast needs: when, whether cancelled or a test, and
// which variants in what quantity (after refunds and removals).
export const ordersQuery = (fromIso: string) => `{
  orders(query: "created_at:>='${fromIso}'") {
    edges { node {
      id createdAt cancelledAt test
      lineItems { edges { node { currentQuantity variant { id } originalUnitPriceSet { shopMoney { amount } } } } }
    } }
  }
}`;

export interface SyncedVariant {
  id: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  barcode: string;
  vendor: string;
  productType: string;
  status: string;
  imageUrl: string | null;
  price: number | null;
  unitCost: number | null;
  inventoryItemId: string;
  tracked: boolean;
  requiresComponents: boolean;
  productCreated: string | null;
}

export interface SyncedLevel {
  inventoryItemId: string;
  locationId: string;
  available: number;
  onHand: number;
  incoming: number;
}

export interface SyncedComponent {
  bundleVariantId: string;
  componentVariantId: string;
  quantity: number;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- bulk export lines, shaped by the queries above */
export class VariantCollector {
  variants = new Map<string, SyncedVariant>();
  levels: SyncedLevel[] = [];
  components: SyncedComponent[] = [];

  add(line: any) {
    if (line.__parentId) {
      const parent = this.variants.get(line.__parentId);
      if (!parent) return;
      if (line.location) {
        const q = (name: string) => Number(line.quantities?.find((x: any) => x.name === name)?.quantity ?? 0) || 0;
        this.levels.push({
          inventoryItemId: parent.inventoryItemId,
          locationId: line.location.id,
          available: q("available"),
          onHand: q("on_hand"),
          incoming: q("incoming"),
        });
      } else if (line.productVariant?.id && Number(line.quantity) > 0) {
        this.components.push({ bundleVariantId: parent.id, componentVariantId: line.productVariant.id, quantity: Number(line.quantity) });
      }
      return;
    }
    if (!line.id || !String(line.id).includes("ProductVariant")) return;
    const p = line.product || {};
    const title = String(line.title ?? "");
    this.variants.set(line.id, {
      id: line.id,
      productId: p.id || "",
      productTitle: String(p.title ?? ""),
      variantTitle: title === "Default Title" ? "" : title,
      sku: String(line.sku ?? "").trim(),
      barcode: String(line.barcode ?? "").trim(),
      vendor: String(p.vendor ?? ""),
      productType: String(p.productType ?? ""),
      status: String(p.status ?? "ACTIVE"),
      imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
      price: num(line.price),
      unitCost: num(line.inventoryItem?.unitCost?.amount),
      inventoryItemId: line.inventoryItem?.id ?? "",
      tracked: line.inventoryItem?.tracked !== false,
      requiresComponents: line.requiresComponents === true,
      productCreated: p.createdAt ?? null,
    });
  }
}

export interface DaySales {
  variantId: string;
  day: string;
  units: number;
  revenue: number;
}

// Adds up order lines into units per variant per day (in the store's time zone). Cancelled orders are left out,
// and test orders too unless `includeTest` (development stores only have test orders).
export class SalesCollector {
  private orders = new Map<string, string | null>(); // order id -> day, or null to skip
  private totals = new Map<string, DaySales>();
  orderCount = 0;
  firstDay: string | null = null;

  constructor(
    private tz: string,
    private fromDay: string,
    private includeTest = false,
  ) {}

  add(line: any) {
    if (!line.__parentId) {
      if (!String(line.id || "").includes("/Order/")) return;
      const day = localDay(new Date(line.createdAt), this.tz);
      const skip = !!line.cancelledAt || (line.test && !this.includeTest) || day < this.fromDay;
      this.orders.set(line.id, skip ? null : day);
      if (!skip) {
        this.orderCount++;
        if (!this.firstDay || day < this.firstDay) this.firstDay = day;
      }
      return;
    }
    const day = this.orders.get(line.__parentId);
    const variantId = line.variant?.id;
    const qty = Number(line.currentQuantity) || 0;
    if (!day || !variantId || qty <= 0) return;
    const key = `${variantId}|${day}`;
    const t = this.totals.get(key) || { variantId, day, units: 0, revenue: 0 };
    t.units += qty;
    t.revenue += qty * (num(line.originalUnitPriceSet?.shopMoney?.amount) || 0);
    this.totals.set(key, t);
  }

  result(): DaySales[] {
    return [...this.totals.values()];
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------------------------------------
// The sync job
// ---------------------------------------------------------------------------------------------------------

// Locations whose stock counts for this shop: the chosen ones (or all active ones), cut to the plan's limit
export function countedLocations(
  all: { id: string; isActive: boolean }[],
  chosen: string[],
  planKey: string,
): string[] {
  const plan = planByKey(planKey);
  // Oldest location first: usually the store's main one, so a one-location plan counts the right stock
  const idNum = (id: string) => Number(id.split("/").pop()) || 0;
  const active = all
    .filter((l) => l.isActive)
    .map((l) => l.id)
    .sort((a, b) => idNum(a) - idNum(b));
  let ids = chosen.length ? chosen.filter((id) => active.includes(id)) : active;
  if (!ids.length) ids = active;
  return plan.locations == null ? ids : ids.slice(0, plan.locations);
}

export interface SyncOptions {
  full?: boolean;
  pollMs?: number;
  now?: Date;
}

export async function syncShop(ctx: JobContext, shopify: Shopify, opts: SyncOptions = {}): Promise<JobResult> {
  const shop = ctx.job.shop;
  const started = opts.now ?? new Date();
  const total = 6;
  const step = (done: number, name: string) => {
    ctx.progress({ done, total, step: name });
    ctx.log(name);
  };
  const stopped = () => {
    if (ctx.shouldStop()) throw new StopRequested();
  };

  try {
    // 1. Store details and permissions
    step(0, "Reading store details");
    const [info, scopes, devStore] = await Promise.all([shopify.shopInfo(), shopify.scopes(), isDevStore(shopify)]);
    const allOrders = !!scopes?.includes("read_all_orders");
    const before = await prisma.shop.findUnique({ where: { shop } });
    if (!before) throw new Error("The store is not set up in the app. Open the app from Shopify Admin first.");
    await prisma.shop.update({
      where: { shop },
      data: {
        name: info.name,
        email: info.email || info.contactEmail || before.email,
        currency: info.currencyCode,
        timezone: info.ianaTimezone || "UTC",
        allOrders,
      },
    });
    const tz = info.ianaTimezone || "UTC";
    const today = localDay(started, tz);
    stopped();

    // 2. Locations
    step(1, "Reading locations");
    const locations = await shopify.locations();
    await prisma.$transaction([
      prisma.location.deleteMany({ where: { shop, id: { notIn: locations.map((l) => l.id) } } }),
      ...locations.map((l) =>
        prisma.location.upsert({
          where: { shop_id: { shop, id: l.id } },
          create: { shop, id: l.id, name: l.name, isActive: l.isActive },
          update: { name: l.name, isActive: l.isActive },
        }),
      ),
    ]);
    stopped();

    // 3 + 4. Variants and orders: both exports run on Shopify's side at the same time
    const full = !!opts.full || !before.syncedAt || (allOrders && !before.allOrders);
    const historyDays = allOrders ? HISTORY_DAYS_ALL : HISTORY_DAYS_DEFAULT;
    const fromDay = full ? addDays(today, -historyDays) : addDays(today, -INCREMENTAL_DAYS);
    // A day early in UTC, so no order of the first local day is missed; the collector drops the extras
    const fromIso = `${addDays(fromDay, -1)}T00:00:00Z`;
    step(2, full ? `Exporting products and ${historyDays} days of orders from Shopify` : "Exporting products and recent orders from Shopify");
    let variantObjects = 0;
    let orderObjects = 0;
    const wait = (set: (n: number) => void) => (n: number) => {
      set(n);
      ctx.progress({ done: 2, total, step: `Shopify is preparing the export (${variantObjects + orderObjects} records so far)` });
      return !ctx.shouldStop();
    };
    const [variantsUrl, ordersUrl] = await Promise.all([
      shopify.runBulkQuery(VARIANTS_QUERY, { pollMs: opts.pollMs, onWait: wait((n) => (variantObjects = n)) }),
      shopify.runBulkQuery(ordersQuery(fromIso), { pollMs: opts.pollMs, onWait: wait((n) => (orderObjects = n)) }),
    ]);

    step(3, "Reading products and stock");
    const vc = new VariantCollector();
    if (variantsUrl) for await (const line of readJsonl(variantsUrl)) vc.add(line);
    stopped();
    const manual = await prisma.bundleComponent.findMany({ where: { shop, source: "manual" }, select: { bundleVariantId: true } });
    const bundleIds = new Set([...vc.components.map((c) => c.bundleVariantId), ...manual.map((m) => m.bundleVariantId)]);
    const now = sqlTime(started);
    await prisma.$transaction(
      async (tx) => {
        await upsertRows(
          tx,
          "Variant",
          [
            { name: "shop", type: "text" },
            { name: "id", type: "text" },
            { name: "productId", type: "text" },
            { name: "productTitle", type: "text" },
            { name: "variantTitle", type: "text" },
            { name: "sku", type: "text" },
            { name: "barcode", type: "text" },
            { name: "vendor", type: "text" },
            { name: "productType", type: "text" },
            { name: "status", type: "text" },
            { name: "imageUrl", type: "text" },
            { name: "price", type: "numeric" },
            { name: "unitCost", type: "numeric" },
            { name: "inventoryItemId", type: "text" },
            { name: "tracked", type: "bool" },
            { name: "isBundle", type: "bool" },
            { name: "productCreated", type: "timestamp" },
            { name: "deletedAt", type: "timestamp" },
            { name: "syncedAt", type: "timestamp" },
          ],
          [...vc.variants.values()].map((v) => [
            shop,
            v.id,
            v.productId,
            v.productTitle,
            v.variantTitle,
            v.sku,
            v.barcode,
            v.vendor,
            v.productType,
            v.status,
            v.imageUrl,
            v.price,
            v.unitCost,
            v.inventoryItemId,
            v.tracked,
            bundleIds.has(v.id) || v.requiresComponents,
            v.productCreated ? sqlTime(new Date(v.productCreated)) : null,
            null,
            now,
          ]),
          {
            key: ["shop", "id"],
            update: [
              "productId", "productTitle", "variantTitle", "sku", "barcode", "vendor", "productType", "status",
              "imageUrl", "price", "unitCost", "inventoryItemId", "tracked", "isBundle", "productCreated", "deletedAt", "syncedAt",
            ],
          },
        );
        // Variants no longer in Shopify: kept for purchase orders, but out of forecasts
        await tx.variant.updateMany({ where: { shop, syncedAt: { lt: started }, deletedAt: null }, data: { deletedAt: started } });

        await upsertRows(
          tx,
          "InventoryLevel",
          [
            { name: "shop", type: "text" },
            { name: "inventoryItemId", type: "text" },
            { name: "locationId", type: "text" },
            { name: "available", type: "int" },
            { name: "onHand", type: "int" },
            { name: "incoming", type: "int" },
            { name: "updatedAt", type: "timestamp" },
          ],
          vc.levels.map((l) => [shop, l.inventoryItemId, l.locationId, l.available, l.onHand, l.incoming, now]),
          { key: ["shop", "inventoryItemId", "locationId"], update: ["available", "onHand", "incoming", "updatedAt"] },
        );
        await tx.inventoryLevel.deleteMany({ where: { shop, updatedAt: { lt: started } } });

        await tx.bundleComponent.deleteMany({ where: { shop, source: "shopify" } });
        await upsertRows(
          tx,
          "BundleComponent",
          [
            { name: "shop", type: "text" },
            { name: "bundleVariantId", type: "text" },
            { name: "componentVariantId", type: "text" },
            { name: "quantity", type: "int" },
            { name: "source", type: "text" },
          ],
          vc.components.map((c) => [shop, c.bundleVariantId, c.componentVariantId, c.quantity, "shopify"]),
          // A component set up by hand for the same pair is replaced by Shopify's own definition
          { key: ["shop", "bundleVariantId", "componentVariantId"], update: ["quantity", "source"] },
        );
      },
      { timeout: 5 * 60 * 1000, maxWait: 30_000 },
    );
    ctx.log(`${vc.variants.size} variants, ${vc.levels.length} stock levels, ${vc.components.length} bundle parts.`);
    stopped();

    step(4, "Reading sales");
    const sc = new SalesCollector(tz, fromDay, devStore);
    if (ordersUrl) for await (const line of readJsonl(ordersUrl)) sc.add(line);
    const sales = sc.result();
    stopped();
    await prisma.$transaction(
      async (tx) => {
        await tx.salesDay.deleteMany({ where: { shop, day: { gte: new Date(`${fromDay}T00:00:00Z`) } } });
        await upsertRows(
          tx,
          "SalesDay",
          [
            { name: "shop", type: "text" },
            { name: "variantId", type: "text" },
            { name: "day", type: "date" },
            { name: "units", type: "int" },
            { name: "revenue", type: "numeric" },
          ],
          sales.map((s) => [shop, s.variantId, s.day, s.units, Math.round(s.revenue * 100) / 100]),
          { key: ["shop", "variantId", "day"], update: ["units", "revenue"] },
        );
      },
      { timeout: 5 * 60 * 1000, maxWait: 30_000 },
    );
    ctx.log(
      `${sc.orderCount} orders since ${fromDay}${devStore ? " (test orders included: development store)" : ""}.` +
        (allOrders ? "" : " Shopify gives the app only the last 60 days of orders until it approves access to older orders."),
    );

    // 5. Today's stock-outs, so those days do not lower the sales rate later
    step(5, "Saving");
    const settings = withDefaults(before.settings);
    const counted = countedLocations(locations, settings.locations, before.plan);
    const stock = new Map<string, number>();
    for (const l of vc.levels) {
      if (counted.includes(l.locationId)) stock.set(l.inventoryItemId, (stock.get(l.inventoryItemId) || 0) + l.available);
    }
    const outRows = [...vc.variants.values()]
      .filter((v) => v.tracked && !bundleIds.has(v.id) && !v.requiresComponents && v.status === "ACTIVE" && (stock.get(v.inventoryItemId) ?? 0) <= 0)
      .map((v) => [shop, v.id, today]);
    await upsertRows(
      prisma,
      "OutOfStockDay",
      [
        { name: "shop", type: "text" },
        { name: "variantId", type: "text" },
        { name: "day", type: "date" },
      ],
      outRows,
      { key: ["shop", "variantId", "day"], update: [] },
    );

    const ordersFrom = full ? (allOrders ? fromDay : addDays(today, -HISTORY_DAYS_DEFAULT)) : null;
    await prisma.shop.update({
      where: { shop },
      data: {
        syncedAt: started,
        ...(ordersFrom ? { ordersFrom: new Date(`${ordersFrom}T00:00:00Z`) } : before.ordersFrom ? {} : { ordersFrom: new Date(`${fromDay}T00:00:00Z`) }),
      },
    });
    ctx.progress({ done: total, total, step: "Done" });
    ctx.log("Sync finished.");
    return {
      counts: { Variants: vc.variants.size, Locations: locations.length, Orders: sc.orderCount, "Out of stock": outRows.length },
    };
  } catch (e) {
    if (e instanceof StopRequested) return { stopped: true };
    throw e;
  }
}

async function isDevStore(shopify: Shopify): Promise<boolean> {
  try {
    const d = await shopify.gql(`{ shop { plan { partnerDevelopment } } }`);
    return d.shop?.plan?.partnerDevelopment === true;
  } catch {
    return false;
  }
}
