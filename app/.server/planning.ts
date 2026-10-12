// Builds the reorder list: every active variant with its stock, sales history, supplier terms and the
// merchant's own choices, run through the forecast (app/lib/forecast.ts). Sales are added up per week in
// SQL, so even a large store loads in well under a second.
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { addDays, daysBetween, fromDate, localDay } from "../lib/dates";
import { forecast, NEEDS_ORDER, type Forecast, type SalesHistory } from "../lib/forecast";
import { hasSeasonal, planByKey } from "../lib/plans";
import { withDefaults, type Settings } from "../lib/settings";
import { countedLocations } from "./sync";

export interface PlanRow {
  id: string;
  productId: string;
  title: string;
  variantTitle: string;
  sku: string;
  barcode: string;
  vendor: string;
  productType: string;
  imageUrl: string | null;
  price: number | null;
  unitCost: number | null; // the supplier's cost when set, else Shopify's cost per item
  shopifyCost: number | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierSku: string;
  leadTimeDays: number;
  leadFrom: "item" | "supplier" | "default";
  daysToCover: number;
  safetyDays: number;
  coverOverride: number | null; // the merchant's own value, when set
  safetyOverride: number | null;
  casePack: number | null;
  minOrderQty: number | null;
  available: number;
  onOrder: number;
  onOrderPos: { id: string; number: string }[];
  incoming: number;
  ignore: boolean;
  rateOverride: number | null;
  qtyOverride: number | null;
  note: string;
  isBundle: boolean;
  bundleOf: { id: string; quantity: number }[]; // a bundle's parts
  weeks: number[]; // units per week, newest first (for the small chart)
  lastSaleDay: string | null;
  outsidePlan: boolean; // beyond the plan's variant limit: shown, but without a suggestion
  f: Forecast;
}

export interface Planning {
  today: string;
  currency: string;
  timezone: string;
  settings: Settings;
  planKey: string;
  variantLimit: number | null;
  totalVariants: number;
  countedLocationIds: string[];
  locations: { id: string; name: string; isActive: boolean }[];
  syncedAt: string | null;
  ordersFrom: string | null;
  allOrders: boolean;
  seasonalUsed: boolean;
  rows: PlanRow[];
}

const n = (v: Prisma.Decimal | number | null | undefined): number | null => (v == null ? null : Number(v));

interface WeekRow {
  variantId: string;
  wk: number;
  units: bigint | number;
}

export async function loadPlanning(shop: string, opts: { now?: Date; variantIds?: string[] } = {}): Promise<Planning> {
  const s = await prisma.shop.findUnique({ where: { shop } });
  if (!s) throw new Error("Store not found.");
  const settings = withDefaults(s.settings);
  const plan = planByKey(s.plan);
  const tz = s.timezone || "UTC";
  const today = localDay(opts.now ?? new Date(), tz);
  const fs = settings.forecast;
  const K = Math.ceil(fs.lookbackDays / 7);
  const fromDay = addDays(today, -7 * K);
  const only = opts.variantIds?.length ? { id: { in: opts.variantIds } } : {};

  const [locations, variants, suppliersItems, plans, components] = await Promise.all([
    prisma.location.findMany({ where: { shop }, orderBy: { name: "asc" } }),
    prisma.variant.findMany({ where: { shop, deletedAt: null, status: "ACTIVE", ...only }, orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }] }),
    prisma.supplierItem.findMany({ where: { shop }, include: { supplier: true } }),
    prisma.variantPlan.findMany({ where: { shop } }),
    prisma.bundleComponent.findMany({ where: { shop } }),
  ]);
  const counted = countedLocations(locations, settings.locations, s.plan);

  const [levels, weekRows, outRows, lastSales, poLines] = await Promise.all([
    prisma.inventoryLevel.groupBy({
      by: ["inventoryItemId"],
      where: { shop, locationId: { in: counted.length ? counted : ["-"] } },
      _sum: { available: true, incoming: true },
    }),
    prisma.$queryRaw<WeekRow[]>`
      SELECT "variantId", ((${today}::date - "day") - 1) / 7 AS wk, SUM("units") AS units
      FROM "SalesDay" WHERE "shop" = ${shop} AND "day" >= ${fromDay}::date AND "day" < ${today}::date
      GROUP BY 1, 2`,
    prisma.$queryRaw<WeekRow[]>`
      SELECT "variantId", ((${today}::date - "day") - 1) / 7 AS wk, COUNT(*) AS units
      FROM "OutOfStockDay" WHERE "shop" = ${shop} AND "day" >= ${fromDay}::date AND "day" < ${today}::date
      GROUP BY 1, 2`,
    prisma.salesDay.groupBy({ by: ["variantId"], where: { shop, units: { gt: 0 } }, _max: { day: true } }),
    prisma.purchaseOrderLine.findMany({
      where: { po: { shop, status: { in: fs.countDrafts ? ["draft", "sent", "partial"] : ["sent", "partial"] } } },
      select: { variantId: true, quantity: true, received: true, po: { select: { id: true, number: true } } },
    }),
  ]);

  // Last year's weeks around the same date (52 weeks back keeps the weekdays aligned)
  const ordersFrom = s.ordersFrom ? fromDate(s.ordersFrom) : null;
  const anchor = addDays(today, -364);
  const maxHorizon = Math.min(
    26 * 7,
    Math.max(fs.leadTimeDays, ...suppliersItems.map((i) => i.leadTimeDays ?? i.supplier.leadTimeDays ?? 0)) + fs.daysToCover,
  );
  const A = Math.ceil(maxHorizon / 7);
  const seasonalUsed = fs.seasonal && hasSeasonal(plan) && !!ordersFrom && ordersFrom <= addDays(anchor, -28);
  const lyRows = seasonalUsed
    ? await prisma.$queryRaw<WeekRow[]>`
        SELECT "variantId",
          CASE WHEN "day" < ${anchor}::date THEN -1 - ((${anchor}::date - "day") - 1) / 7 ELSE ("day" - ${anchor}::date) / 7 END AS wk,
          SUM("units") AS units
        FROM "SalesDay" WHERE "shop" = ${shop}
          AND "day" >= ${addDays(anchor, -7 * K)}::date AND "day" < ${addDays(anchor, 7 * A)}::date
        GROUP BY 1, 2`
    : [];

  // ---- Index everything by variant ----
  const stock = new Map(levels.map((l) => [l.inventoryItemId, { available: l._sum.available ?? 0, incoming: l._sum.incoming ?? 0 }]));
  const own = new Map<string, number[]>();
  const put = (m: Map<string, number[]>, id: string, wk: number, units: number, len: number) => {
    if (wk < 0 || wk >= len) return;
    const a = m.get(id) ?? Array(len).fill(0);
    a[wk] += units;
    m.set(id, a);
  };
  for (const r of weekRows) put(own, r.variantId, Number(r.wk), Number(r.units), K);
  const outs = new Map<string, number[]>();
  for (const r of outRows) put(outs, r.variantId, Number(r.wk), Number(r.units), K);
  const lyBase = new Map<string, number[]>();
  const lyAhead = new Map<string, number[]>();
  for (const r of lyRows) {
    const wk = Number(r.wk);
    if (wk < 0) put(lyBase, r.variantId, -1 - wk, Number(r.units), K);
    else put(lyAhead, r.variantId, wk, Number(r.units), A);
  }
  const last = new Map(lastSales.map((l) => [l.variantId, l._max.day ? fromDate(l._max.day) : null]));
  // A part sold inside a bundle has sold too
  for (const c of components) {
    const b = last.get(c.bundleVariantId);
    const own = last.get(c.componentVariantId);
    if (b && (!own || b > own)) last.set(c.componentVariantId, b);
  }
  const items = new Map(suppliersItems.map((i) => [i.variantId, i]));
  const planOf = new Map(plans.map((p) => [p.variantId, p]));
  const onOrder = new Map<string, { qty: number; pos: Map<string, string> }>();
  for (const l of poLines) {
    const left = Math.max(0, l.quantity - l.received);
    if (!left) continue;
    const o = onOrder.get(l.variantId) ?? { qty: 0, pos: new Map() };
    o.qty += left;
    o.pos.set(l.po.id, `${settings.po.prefix}${String(l.po.number).padStart(4, "0")}`);
    onOrder.set(l.variantId, o);
  }

  // Bundles: each bundle sale counts as `quantity` sales of each part, in the same week
  const partsOf = new Map<string, { id: string; quantity: number }[]>();
  for (const c of components) {
    const list = partsOf.get(c.bundleVariantId) ?? [];
    list.push({ id: c.componentVariantId, quantity: c.quantity });
    partsOf.set(c.bundleVariantId, list);
  }
  const demand = new Map<string, number[]>([...own].map(([k, v]) => [k, [...v]]));
  const fromBundles = new Map<string, number>();
  const lyBaseAll = new Map<string, number[]>([...lyBase].map(([k, v]) => [k, [...v]]));
  const lyAheadAll = new Map<string, number[]>([...lyAhead].map(([k, v]) => [k, [...v]]));
  for (const [bundle, parts] of partsOf) {
    for (const p of parts) {
      const add = (src: Map<string, number[]>, dst: Map<string, number[]>, len: number) => {
        const b = src.get(bundle);
        if (!b) return 0;
        const a = dst.get(p.id) ?? Array(len).fill(0);
        let added = 0;
        b.forEach((u, i) => {
          a[i] += u * p.quantity;
          added += u * p.quantity;
        });
        dst.set(p.id, a);
        return added;
      };
      const added = add(own, demand, K);
      if (added) fromBundles.set(p.id, (fromBundles.get(p.id) ?? 0) + added);
      add(lyBase, lyBaseAll, K);
      add(lyAhead, lyAheadAll, A);
    }
  }

  // ---- Plan limit: the best sellers get forecasts first ----
  const limit = plan.variants;
  const eligible = variants.filter((v) => !v.isBundle);
  let inPlan: Set<string> | null = null;
  if (limit != null && eligible.length > limit) {
    const score = (id: string, price: number) => (demand.get(id) ?? []).reduce((s2, u) => s2 + u, 0) * Math.max(price, 0.01);
    const ranked = [...eligible].sort((a, b) => score(b.id, n(b.price) ?? 0) - score(a.id, n(a.price) ?? 0) || a.id.localeCompare(b.id));
    inPlan = new Set(ranked.slice(0, limit).map((v) => v.id));
  }

  const rows: PlanRow[] = variants.map((v) => {
    const item = items.get(v.id);
    const vp = planOf.get(v.id);
    const st = stock.get(v.inventoryItemId) ?? { available: 0, incoming: 0 };
    const lead = item?.leadTimeDays ?? item?.supplier.leadTimeDays ?? null;
    const leadTimeDays = lead ?? fs.leadTimeDays;
    const leadFrom: PlanRow["leadFrom"] = item?.leadTimeDays != null ? "item" : item?.supplier.leadTimeDays != null ? "supplier" : "default";
    const daysToCover = vp?.daysToCover ?? fs.daysToCover;
    const safetyDays = vp?.safetyDays ?? fs.safetyDays;
    const weeks = demand.get(v.id) ?? Array(K).fill(0);
    const startDay = [ordersFrom, v.productCreated ? localDay(v.productCreated, tz) : null].filter(Boolean).sort().at(-1) as string | undefined;
    const historyDays = startDay ? Math.max(0, Math.min(fs.lookbackDays, daysBetween(startDay, today))) : 0;
    const history: SalesHistory = {
      weeks,
      outDays: outs.get(v.id) ?? Array(K).fill(0),
      bundleUnits: fromBundles.get(v.id) ?? 0,
      lastYear: seasonalUsed ? { base: lyBaseAll.get(v.id) ?? Array(K).fill(0), ahead: lyAheadAll.get(v.id) ?? Array(A).fill(0) } : null,
    };
    const outsidePlan = !!inPlan && !v.isBundle && !inPlan.has(v.id);
    const oo = onOrder.get(v.id);
    const untracked = !v.tracked;
    const f = forecast({
      today,
      history,
      historyDays,
      available: st.available,
      onOrder: oo?.qty ?? 0,
      incoming: st.incoming,
      leadTimeDays,
      daysToCover,
      safetyDays,
      casePack: item?.casePack,
      minOrderQty: item?.minOrderQty,
      rateOverride: n(vp?.rateOverride),
      qtyOverride: vp?.qtyOverride,
      ignore: vp?.ignore || outsidePlan || untracked,
      ignoreReason: outsidePlan
        ? `Outside your plan's ${limit} best-selling variants: upgrade the plan to get a suggestion for it.`
        : untracked && !vp?.ignore
          ? "Shopify does not track this item's stock, so it is not reordered."
          : undefined,
      isBundle: v.isBundle,
      seasonal: seasonalUsed,
      countIncoming: fs.countIncoming,
      overstockDays: fs.overstockDays,
    });
    return {
      id: v.id,
      productId: v.productId,
      title: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      barcode: v.barcode,
      vendor: v.vendor,
      productType: v.productType,
      imageUrl: v.imageUrl,
      price: n(v.price),
      unitCost: n(item?.cost) ?? n(v.unitCost),
      shopifyCost: n(v.unitCost),
      supplierId: item?.supplierId ?? null,
      supplierName: item?.supplier.name ?? null,
      supplierSku: item?.supplierSku ?? "",
      leadTimeDays,
      leadFrom,
      daysToCover,
      safetyDays,
      coverOverride: vp?.daysToCover ?? null,
      safetyOverride: vp?.safetyDays ?? null,
      casePack: item?.casePack ?? null,
      minOrderQty: item?.minOrderQty ?? null,
      available: st.available,
      onOrder: oo?.qty ?? 0,
      onOrderPos: oo ? [...oo.pos].map(([id, number]) => ({ id, number })) : [],
      incoming: st.incoming,
      ignore: !!vp?.ignore,
      rateOverride: n(vp?.rateOverride),
      qtyOverride: vp?.qtyOverride ?? null,
      note: vp?.note ?? "",
      isBundle: v.isBundle,
      bundleOf: partsOf.get(v.id) ?? [],
      weeks: weeks.slice(0, 13),
      lastSaleDay: last.get(v.id) ?? null,
      outsidePlan,
      f,
    };
  });

  return {
    today,
    currency: s.currency,
    timezone: tz,
    settings,
    planKey: plan.key,
    variantLimit: limit,
    totalVariants: eligible.length,
    countedLocationIds: counted,
    locations: locations.map((l) => ({ id: l.id, name: l.name, isActive: l.isActive })),
    syncedAt: s.syncedAt?.toISOString() ?? null,
    ordersFrom,
    allOrders: s.allOrders,
    seasonalUsed,
    rows,
  };
}

// Items not selling: in stock, no sale for `deadStockDays` (and the product is older than that)
export function deadStock(p: Planning) {
  const days = p.settings.forecast.deadStockDays;
  const cutoff = addDays(p.today, -days);
  return p.rows
    .filter((r) => !r.isBundle && r.available > 0 && (!r.lastSaleDay || r.lastSaleDay < cutoff))
    .filter((r) => !p.ordersFrom || p.ordersFrom <= cutoff || !!r.lastSaleDay) // too little history to judge otherwise
    .map((r) => ({
      ...r,
      value: r.unitCost != null ? r.available * r.unitCost : null,
      daysSinceSale: r.lastSaleDay ? daysBetween(r.lastSaleDay, p.today) : null,
    }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
}

export function summary(p: Planning) {
  const counts: Record<string, number> = {};
  let stockValue = 0;
  let missingCost = 0;
  let toOrderValue = 0;
  let toOrderUnits = 0;
  for (const r of p.rows) {
    counts[r.f.status] = (counts[r.f.status] ?? 0) + 1;
    if (r.available > 0 && !r.isBundle) {
      if (r.unitCost != null) stockValue += r.available * r.unitCost;
      else missingCost++;
    }
    if (NEEDS_ORDER.includes(r.f.status) && r.f.suggested > 0) {
      toOrderUnits += r.f.suggested;
      toOrderValue += r.f.suggested * (r.unitCost ?? 0);
    }
  }
  const dead = deadStock(p);
  return {
    counts,
    needsOrder: NEEDS_ORDER.reduce((s2, k) => s2 + (counts[k] ?? 0), 0),
    stockValue,
    missingCost,
    toOrderUnits,
    toOrderValue,
    deadCount: dead.length,
    deadValue: dead.reduce((s2, d) => s2 + (d.value ?? 0), 0),
    noSupplier: p.rows.filter((r) => !r.isBundle && !r.supplierId && NEEDS_ORDER.includes(r.f.status)).length,
  };
}
