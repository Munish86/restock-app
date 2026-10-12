// The forecast for one variant: sales per day, days of stock left, the stock-out date and the quantity to
// order, each with a one-line reason the merchant can check. Pure maths: no database, no Shopify, so it is
// the same on the server and in the browser, and easy to test.
//
//   suggested = (lead time + days to cover) x sales per day + safety stock - in stock - already on order
//   rounded up to the case pack, and to at least the minimum order.

import { addDays, shortDay } from "./dates";

export interface SalesHistory {
  // Units sold per week, newest first: [0] = the 7 days before today, [1] = the 7 before that, ...
  // Bundle sales are already counted in their components.
  weeks: number[];
  outDays: number[]; // days out of stock in each of those weeks (same index)
  bundleUnits: number; // of the units in `weeks`, how many came from bundles
  // The same weeks one year earlier: `base` mirrors `weeks` (the weeks before the same date last year,
  // newest first), `ahead` is the weeks after that date (oldest first). Only when there is that much history.
  lastYear?: { base: number[]; ahead: number[] } | null;
}

export interface ForecastInput {
  today: string; // "YYYY-MM-DD" in the store's time zone
  history: SalesHistory;
  historyDays: number; // days of usable history: shorter for a new product or a store with little data
  available: number; // at the counted locations; can be negative when oversold
  onOrder: number; // still to arrive on the app's purchase orders
  incoming: number; // Shopify's own incoming stock (transfers)
  leadTimeDays: number;
  daysToCover: number;
  safetyDays: number;
  casePack?: number | null;
  minOrderQty?: number | null;
  rateOverride?: number | null;
  qtyOverride?: number | null;
  ignore?: boolean;
  ignoreReason?: string; // why it is not reordered, when that is not the merchant's own choice
  isBundle?: boolean;
  seasonal: boolean;
  countIncoming: boolean;
  overstockDays: number;
}

export type Status = "out" | "order-now" | "order-soon" | "ok" | "overstock" | "no-sales" | "ignored" | "bundle";

export const STATUS_LABEL: Record<Status, string> = {
  out: "Out of stock",
  "order-now": "Order now",
  "order-soon": "Order soon",
  ok: "OK",
  overstock: "Overstock",
  "no-sales": "No recent sales",
  ignored: "Not reordered",
  bundle: "Bundle",
};

// Statuses that mean "look at this"; the reorder list shows these first
export const NEEDS_ORDER: Status[] = ["out", "order-now", "order-soon"];

export interface Forecast {
  status: Status;
  rate: number; // units per day used for the suggestion (after the seasonal change or the merchant's override)
  historyRate: number; // units per day from sales history alone
  seasonalFactor: number; // 1 = no change
  confidence: "none" | "low" | "ok";
  sold7: number;
  sold28: number;
  soldTotal: number; // in the whole history window
  daysLeft: number | null; // null = not selling
  stockoutDay: string | null;
  reorderByDay: string | null; // order by this day so stock arrives before it runs out (safety stock included)
  position: number; // in stock + on order (+ incoming)
  need: number; // stock wanted at the moment of ordering
  suggested: number; // units to order now
  why: string[];
  warnings: string[];
}

// Recent weeks count more: each week back counts 0.85 times the week after it
export const WEEK_WEIGHT = 0.85;
// A week with fewer days than this in stock says little about demand and is left out
const MIN_DAYS_IN_STOCK = 2;
// A seasonal change smaller than this is treated as no change
const SEASONAL_MIN_CHANGE = 0.15;
const SEASONAL_MIN_UNITS = 10;
export const SOON_DAYS = 14; // "order soon" = would need ordering within two weeks

// 0.04 -> "0.04", 2.345 -> "2.3", 12.6 -> "13"
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 10 || Number.isInteger(n)) return String(Math.round(n));
  if (a >= 1) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 100) / 100);
}

const sum = (a: number[]) => a.reduce((s, x) => s + (x || 0), 0);
const plural = (n: number, one: string, many = one + "s") => `${fmt(n)} ${n === 1 ? one : many}`;

export interface RateResult {
  rate: number;
  usableDays: number;
  sold7: number;
  sold28: number;
  soldTotal: number;
  outDaysUsed: number;
  skippedWeeks: number;
}

// Sales per day from weekly sales: a weighted average of each week's daily rate, leaving out days the
// variant was out of stock, and weeks it was barely in stock at all.
export function salesRate(history: SalesHistory, historyDays: number): RateResult {
  const weeks = history.weeks;
  const usableDays = Math.max(0, Math.min(historyDays, weeks.length * 7));
  const fullWeeks = Math.floor(usableDays / 7);
  const sold7 = weeks[0] || 0;
  const sold28 = sum(weeks.slice(0, 4));
  const soldTotal = sum(weeks.slice(0, Math.max(1, Math.ceil(usableDays / 7))));
  const base = { usableDays, sold7, sold28, soldTotal };
  if (usableDays <= 0) return { ...base, rate: 0, outDaysUsed: 0, skippedWeeks: 0 };
  if (fullWeeks === 0) {
    // Less than a week of history: everything sold so far over the days there were
    const inStock = Math.max(1, usableDays - Math.min(usableDays, history.outDays[0] || 0));
    return { ...base, rate: sold7 / inStock, outDaysUsed: Math.min(usableDays, history.outDays[0] || 0), skippedWeeks: 0 };
  }
  let num = 0;
  let den = 0;
  let outDaysUsed = 0;
  let skippedWeeks = 0;
  for (let k = 0; k < fullWeeks; k++) {
    const out = Math.min(7, Math.max(0, history.outDays[k] || 0));
    const inStock = 7 - out;
    if (inStock < MIN_DAYS_IN_STOCK) {
      skippedWeeks++;
      continue;
    }
    outDaysUsed += out;
    const w = WEEK_WEIGHT ** k;
    num += (w * (weeks[k] || 0)) / inStock;
    den += w;
  }
  // Out of stock nearly the whole time: the plain average is all there is (and is likely too low)
  const rate = den > 0 ? num / den : soldTotal / usableDays;
  return { ...base, rate, outDaysUsed, skippedWeeks };
}

// How much last year's sales rose or fell in the coming weeks compared with the weeks before.
// Returns 1 when there is no clear pattern or not enough data.
export function seasonalFactor(
  lastYear: SalesHistory["lastYear"],
  baseWeeks: number,
  horizonDays: number,
): { factor: number; lyBase: number; lyAhead: number } | null {
  if (!lastYear) return null;
  const b = lastYear.base.slice(0, Math.max(1, baseWeeks));
  const aheadWeeks = Math.max(1, Math.min(lastYear.ahead.length, Math.ceil(horizonDays / 7)));
  const a = lastYear.ahead.slice(0, aheadWeeks);
  const lyBase = sum(b);
  const lyAhead = sum(a);
  if (lyBase < SEASONAL_MIN_UNITS || !b.length || !a.length) return null;
  const ratio = lyAhead / a.length / (lyBase / b.length);
  const factor = Math.min(3, Math.max(0.5, ratio));
  return { factor: Math.abs(factor - 1) < SEASONAL_MIN_CHANGE ? 1 : factor, lyBase, lyAhead };
}

// Rounds a quantity up to whole case packs, then up to the minimum order (itself in whole packs)
export function roundOrder(raw: number, casePack?: number | null, minOrderQty?: number | null): { qty: number; note: string } {
  if (raw <= 0) return { qty: 0, note: "" };
  let qty = Math.ceil(raw - 1e-9);
  const notes: string[] = [];
  const pack = casePack && casePack > 1 ? casePack : 0;
  if (pack && qty % pack) {
    qty = Math.ceil(qty / pack) * pack;
    notes.push(`rounded up to whole packs of ${pack}`);
  }
  if (minOrderQty && qty < minOrderQty) {
    qty = pack ? Math.ceil(minOrderQty / pack) * pack : minOrderQty;
    notes.push(`raised to the minimum order of ${minOrderQty}`);
  }
  return { qty, note: notes.join(", ") };
}

export function forecast(i: ForecastInput): Forecast {
  const why: string[] = [];
  const warnings: string[] = [];
  const r = salesRate(i.history, i.historyDays);
  const lead = Math.max(0, i.leadTimeDays);
  const cover = Math.max(0, i.daysToCover);
  const safetyDays = Math.max(0, i.safetyDays);

  // ---- Sales rate ----
  let confidence: Forecast["confidence"] = "ok";
  if (r.soldTotal <= 0) confidence = "none";
  else if (r.usableDays < 28 || r.soldTotal < 5) confidence = "low";

  if (r.soldTotal > 0) {
    why.push(
      `Sells ${fmt(r.rate)} a day: ${fmt(r.sold7)} sold in the last 7 days, ${fmt(r.sold28)} in the last 28` +
        (r.usableDays > 28 ? `, ${fmt(r.soldTotal)} in ${r.usableDays} days` : "") +
        (r.usableDays > 7 ? "; recent weeks count more." : "."),
    );
  } else if (r.usableDays > 0) {
    why.push(`No sales in the last ${r.usableDays} days.`);
  } else {
    why.push("No sales history yet.");
  }
  if (r.outDaysUsed > 0 || r.skippedWeeks > 0) {
    const parts = [];
    if (r.outDaysUsed) parts.push(`${plural(r.outDaysUsed, "day")} out of stock`);
    if (r.skippedWeeks) parts.push(`${plural(r.skippedWeeks, "week")} almost fully out of stock`);
    why.push(`Left out of the rate: ${parts.join(" and ")}, so missed sales do not lower it.`);
  }
  if (i.history.bundleUnits > 0) why.push(`Includes ${plural(i.history.bundleUnits, "unit")} sold inside bundles.`);
  if (r.usableDays > 0 && r.usableDays < 28) {
    warnings.push(`Only ${plural(r.usableDays, "day")} of sales history: treat this forecast as a rough guide.`);
  } else if (confidence === "low") {
    warnings.push("Very few sales so far: treat this forecast as a rough guide.");
  }

  let rate = r.rate;
  let factor = 1;
  if (i.rateOverride != null && i.rateOverride >= 0) {
    rate = i.rateOverride;
    why.push(`You set the sales rate to ${fmt(rate)} a day (history says ${fmt(r.rate)}).`);
  } else if (i.seasonal && r.rate > 0) {
    const s = seasonalFactor(i.history.lastYear, Math.floor(r.usableDays / 7), lead + cover);
    if (s && s.factor !== 1) {
      factor = s.factor;
      rate = r.rate * factor;
      why.push(
        `Last year, sales in the ${lead + cover} days ahead were ${fmt(factor)}× the weeks before, so the forecast is ${fmt(rate)} a day.`,
      );
    }
  }

  // ---- Stock ----
  const counted = i.available + i.onOrder + (i.countIncoming ? i.incoming : 0);
  const position = counted;
  const stockParts = [`${fmt(i.available)} in stock`];
  if (i.onOrder) stockParts.push(`${fmt(i.onOrder)} on order`);
  if (i.incoming) stockParts.push(`${fmt(i.incoming)} incoming in Shopify${i.countIncoming ? "" : " (not counted)"}`);
  why.push(`${stockParts.join(", ")}.`);
  if (i.available < 0) warnings.push(`Stock is ${i.available}: more was sold than was in stock.`);

  const daysLeft = rate > 0 ? Math.max(0, i.available) / rate : null;
  const stockoutDay = daysLeft != null ? addDays(i.today, Math.floor(daysLeft)) : null;
  if (daysLeft != null) {
    why.push(i.available > 0 ? `Lasts about ${fmt(Math.floor(daysLeft))} days: runs out around ${shortDay(stockoutDay, i.today)}.` : "Already out of stock.");
  }

  // Reorder point: stock that covers the lead time plus the safety stock
  const safety = rate * safetyDays;
  const rop = rate * lead + safety;
  const reorderByDay = rate > 0 ? addDays(i.today, Math.max(0, Math.floor((position - rop) / rate))) : null;

  // ---- Quantity ----
  const need = rate * (lead + cover) + safety;
  const raw = need - position;
  let suggested = 0;
  if (i.isBundle || i.ignore) {
    suggested = 0;
  } else if (i.qtyOverride != null && i.qtyOverride >= 0) {
    suggested = i.qtyOverride;
    why.push(`Order ${fmt(suggested)}: the quantity you set.`);
  } else if (rate > 0) {
    const rounded = roundOrder(raw, i.casePack, i.minOrderQty);
    suggested = rounded.qty;
    const calc =
      `(${lead} days lead time + ${cover} days to cover) × ${fmt(rate)}` +
      (safetyDays ? ` + ${fmt(safety)} safety stock (${safetyDays} days)` : "") +
      ` − ${fmt(position)} in stock and on order = ${fmt(raw)}`;
    why.push(
      raw > 0
        ? `Order ${fmt(suggested)} = ${calc}${rounded.note ? `, ${rounded.note}` : ""}.`
        : `Nothing to order: ${calc}.`,
    );
  }

  // ---- Status ----
  let status: Status;
  if (i.isBundle) {
    status = "bundle";
    why.unshift("A bundle: its sales are counted in the products it is made of, which are reordered instead.");
  } else if (i.ignore) {
    status = "ignored";
    why.unshift(i.ignoreReason ?? "You chose not to reorder this item.");
  } else if (rate <= 0) {
    status = "no-sales";
  } else if (i.available <= 0) {
    status = "out";
  } else if (position <= rop) {
    status = "order-now";
  } else if (position <= rop + rate * SOON_DAYS) {
    status = "order-soon";
  } else if (daysLeft != null && daysLeft > i.overstockDays) {
    status = "overstock";
  } else {
    status = "ok";
  }
  if (status === "order-now" && reorderByDay) {
    why.push(`Stock on hand and on order will not last the ${lead}-day lead time plus safety stock: order now.`);
  } else if ((status === "order-soon" || status === "ok" || status === "overstock") && reorderByDay) {
    why.push(`Order by ${shortDay(reorderByDay, i.today)} to keep the safety stock.`);
  }
  if (status === "overstock") why.push(`More than ${i.overstockDays} days of stock.`);

  return {
    status,
    rate,
    historyRate: r.rate,
    seasonalFactor: factor,
    confidence,
    sold7: r.sold7,
    sold28: r.sold28,
    soldTotal: r.soldTotal,
    daysLeft,
    stockoutDay,
    reorderByDay,
    position,
    need,
    suggested,
    why,
    warnings,
  };
}
