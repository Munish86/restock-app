// The forecast maths: sales rate, seasonal change, rounding, statuses and the "why" lines
import { describe, expect, it } from "vitest";
import { forecast, fmt, roundOrder, salesRate, seasonalFactor, type ForecastInput } from "../app/lib/forecast";
import { addDays, daysBetween, localClock, localDay, shortDay } from "../app/lib/dates";
import { autoMapColumns } from "../app/lib/import-columns";
import { cleanSettings, DEFAULTS, parseEmails, parsePhones, SettingsError, withDefaults } from "../app/lib/settings";
import { planKeyFromName } from "../app/lib/plans";

const weeks = (n: number, perWeek: number) => Array(n).fill(perWeek);
const base = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  today: "2026-10-12",
  history: { weeks: weeks(13, 14), outDays: weeks(13, 0), bundleUnits: 0 },
  historyDays: 90,
  available: 50,
  onOrder: 0,
  incoming: 0,
  leadTimeDays: 14,
  daysToCover: 30,
  safetyDays: 7,
  seasonal: true,
  countIncoming: true,
  overstockDays: 180,
  ...over,
});

describe("sales rate", () => {
  it("is the daily average when sales are steady", () => {
    expect(salesRate({ weeks: weeks(13, 14), outDays: weeks(13, 0), bundleUnits: 0 }, 91).rate).toBeCloseTo(2, 6);
  });

  it("counts recent weeks more", () => {
    const rising = salesRate({ weeks: [28, 28, 7, 7, 7, 7, 7, 7], outDays: weeks(8, 0), bundleUnits: 0 }, 56).rate;
    const plain = (28 * 2 + 7 * 6) / 56;
    expect(rising).toBeGreaterThan(plain);
  });

  it("leaves out days out of stock, and weeks barely in stock", () => {
    // Week 0: sold 10 in the 5 days it was in stock -> 2/day, not 10/7
    const r = salesRate({ weeks: [10, 14, 0], outDays: [2, 0, 7], bundleUnits: 0 }, 21);
    expect(r.outDaysUsed).toBe(2);
    expect(r.skippedWeeks).toBe(1);
    expect(r.rate).toBeCloseTo(2, 6);
  });

  it("uses only the days there is history for", () => {
    const r = salesRate({ weeks: [7, 0, 0, 0], outDays: weeks(4, 0), bundleUnits: 0 }, 10);
    // One full week of history (7 sold), the partial second week is not used
    expect(r.usableDays).toBe(10);
    expect(r.rate).toBeCloseTo(1, 6);
    const tiny = salesRate({ weeks: [3, 0], outDays: [0, 0], bundleUnits: 0 }, 3);
    expect(tiny.rate).toBeCloseTo(1, 6);
  });

  it("is zero with no history", () => {
    expect(salesRate({ weeks: weeks(4, 0), outDays: weeks(4, 0), bundleUnits: 0 }, 0).rate).toBe(0);
  });
});

describe("seasonal change", () => {
  it("raises the forecast when last year's coming weeks sold more", () => {
    const s = seasonalFactor({ base: weeks(13, 7), ahead: [14, 14, 14, 14, 14, 14, 14] }, 13, 44);
    expect(s?.factor).toBeCloseTo(2, 6);
  });
  it("ignores small changes and thin data", () => {
    expect(seasonalFactor({ base: weeks(13, 7), ahead: weeks(7, 7.5) }, 13, 44)?.factor).toBe(1);
    expect(seasonalFactor({ base: weeks(13, 0.5), ahead: weeks(7, 10) }, 13, 44)).toBeNull();
    expect(seasonalFactor(null, 13, 44)).toBeNull();
  });
  it("is capped", () => {
    expect(seasonalFactor({ base: weeks(13, 7), ahead: weeks(7, 700) }, 13, 44)?.factor).toBe(3);
    expect(seasonalFactor({ base: weeks(13, 70), ahead: weeks(7, 1) }, 13, 44)?.factor).toBe(0.5);
  });
});

describe("rounding", () => {
  it("rounds up to case packs and the minimum order", () => {
    expect(roundOrder(13.2, 12, null).qty).toBe(24);
    expect(roundOrder(5, null, 20).qty).toBe(20);
    expect(roundOrder(5, 12, 20).qty).toBe(24);
    expect(roundOrder(0, 12, 20).qty).toBe(0);
    expect(roundOrder(12, 12, null)).toEqual({ qty: 12, note: "" });
  });
});

describe("forecast", () => {
  it("suggests (lead + cover) x rate + safety - stock - on order", () => {
    // 2/day: need = 44*2 + 7*2 = 102; stock 50 -> 52
    const f = forecast(base());
    expect(f.rate).toBeCloseTo(2, 6);
    expect(f.suggested).toBe(52);
    expect(f.why.join(" ")).toContain("Order 52");
    expect(f.daysLeft).toBe(25);
    expect(f.stockoutDay).toBe("2026-11-06");
  });

  it("counts stock on order and Shopify's incoming stock", () => {
    expect(forecast(base({ onOrder: 30, incoming: 10 })).suggested).toBe(12);
    expect(forecast(base({ onOrder: 30, incoming: 10, countIncoming: false })).suggested).toBe(22);
  });

  it("gives the right status", () => {
    expect(forecast(base({ available: 0 })).status).toBe("out");
    expect(forecast(base({ available: 20 })).status).toBe("order-now"); // reorder point = 2*(14+7) = 42
    expect(forecast(base({ available: 60 })).status).toBe("order-soon"); // within 14 more days
    expect(forecast(base({ available: 100 })).status).toBe("ok");
    expect(forecast(base({ available: 1000 })).status).toBe("overstock");
    expect(forecast(base({ history: { weeks: weeks(13, 0), outDays: weeks(13, 0), bundleUnits: 0 } })).status).toBe("no-sales");
    expect(forecast(base({ ignore: true })).status).toBe("ignored");
    expect(forecast(base({ ignore: true })).suggested).toBe(0);
    expect(forecast(base({ isBundle: true })).status).toBe("bundle");
  });

  it("uses the merchant's overrides", () => {
    const f = forecast(base({ rateOverride: 1 }));
    expect(f.rate).toBe(1);
    expect(f.historyRate).toBeCloseTo(2, 6);
    expect(f.why.join(" ")).toContain("You set the sales rate to 1 a day");
    expect(forecast(base({ qtyOverride: 7 })).suggested).toBe(7);
  });

  it("applies last year's season unless the rate is overridden", () => {
    const lastYear = { base: weeks(13, 14), ahead: weeks(7, 28) };
    const f = forecast(base({ history: { weeks: weeks(13, 14), outDays: weeks(13, 0), bundleUnits: 0, lastYear } }));
    expect(f.seasonalFactor).toBe(2);
    expect(f.rate).toBeCloseTo(4, 6);
    expect(f.why.join(" ")).toContain("Last year");
    const off = forecast(base({ seasonal: false, history: { weeks: weeks(13, 14), outDays: weeks(13, 0), bundleUnits: 0, lastYear } }));
    expect(off.rate).toBeCloseTo(2, 6);
  });

  it("warns when history is thin", () => {
    const f = forecast(base({ historyDays: 10, history: { weeks: [7, 3, ...weeks(11, 0)], outDays: weeks(13, 0), bundleUnits: 0 } }));
    expect(f.confidence).toBe("low");
    expect(f.warnings.join(" ")).toContain("Only 10 days");
  });

  it("explains bundles and oversold stock", () => {
    const f = forecast(base({ available: -3, history: { weeks: weeks(13, 14), outDays: weeks(13, 0), bundleUnits: 20 } }));
    expect(f.why.join(" ")).toContain("20 units sold inside bundles");
    expect(f.warnings.join(" ")).toContain("more was sold than was in stock");
    expect(f.daysLeft).toBe(0);
  });

  it("rounds to the case pack in the explanation", () => {
    const f = forecast(base({ casePack: 24 }));
    expect(f.suggested).toBe(72);
    expect(f.why.join(" ")).toContain("rounded up to whole packs of 24");
  });
});

describe("helpers", () => {
  it("formats numbers for people", () => {
    expect(fmt(2.345)).toBe("2.3");
    expect(fmt(0.044)).toBe("0.04");
    expect(fmt(12.6)).toBe("13");
    expect(fmt(5)).toBe("5");
  });

  it("works in the store's time zone", () => {
    const d = new Date("2026-10-11T20:00:00Z");
    expect(localDay(d, "Asia/Kolkata")).toBe("2026-10-12");
    expect(localDay(d, "America/New_York")).toBe("2026-10-11");
    expect(localDay(d, "Not/AZone")).toBe("2026-10-11");
    expect(localClock(d, "Asia/Kolkata")).toEqual({ hour: 1, weekday: 1, day: "2026-10-12" });
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(daysBetween("2026-10-01", "2026-10-12")).toBe(11);
    expect(shortDay("2026-10-27", "2026-10-12")).toBe("27 Oct");
    expect(shortDay("2027-01-02", "2026-10-12")).toBe("2 Jan 2027");
  });

  it("recognises Stocky, Shopify and supplier sheet columns", () => {
    expect(autoMapColumns(["Variant SKU", "Supplier", "Supplier code", "Cost price", "Case pack", "MOQ", "Lead time (days)", "Variant Price"])).toEqual({
      sku: "Variant SKU",
      supplier: "Supplier",
      supplierSku: "Supplier code",
      cost: "Cost price",
      casePack: "Case pack",
      minOrderQty: "MOQ",
      leadTimeDays: "Lead time (days)",
    });
    expect(autoMapColumns(["Handle", "Vendor", "Variant Barcode", "Cost per item"])).toEqual({ supplier: "Vendor", barcode: "Variant Barcode", cost: "Cost per item" });
  });

  it("checks settings", () => {
    expect(withDefaults(null)).toEqual(DEFAULTS);
    expect(withDefaults({ forecast: { daysToCover: 45 } }).forecast.daysToCover).toBe(45);
    const ok = cleanSettings({ ...DEFAULTS, alerts: { ...DEFAULTS.alerts, recipients: "A@x.com, b@y.org" }, extra: 1 });
    expect(ok.alerts.recipients).toBe("a@x.com, b@y.org");
    expect(ok).not.toHaveProperty("extra");
    try {
      cleanSettings({ forecast: { daysToCover: 0, leadTimeDays: "x" }, alerts: { recipients: "nope", hour: 30 }, po: { prefix: "<b>" } });
      throw new Error("should fail");
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError);
      expect((e as SettingsError).problems.length).toBe(5);
    }
    expect(cleanSettings({ __proto__: { polluted: true } } as unknown)).not.toHaveProperty("polluted");
    expect(parseEmails("a@b.co; bad, c@d.io")).toEqual({ list: ["a@b.co", "c@d.io"], bad: ["bad"] });
  });

  it("checks phone numbers for text alerts", () => {
    expect(parsePhones("+1 (555) 010-2000, 0044 7700 900123; 98765 43210, +15550102000")).toEqual({
      list: ["+15550102000", "+447700900123"],
      bad: ["98765 43210"], // no country code
    });
    const ok = cleanSettings({ alerts: { phones: "+91 98765 43210", phoneChannel: "whatsapp", phoneWeekly: true } });
    expect(ok.alerts).toMatchObject({ phones: "+919876543210", phoneChannel: "whatsapp", phoneLowStock: true, phoneWeekly: true });
    expect(cleanSettings({ alerts: { phoneChannel: "pigeon" } }).alerts.phoneChannel).toBe("sms");
    expect(() => cleanSettings({ alerts: { phones: "+15550100001, +15550100002, +15550100003, +15550100004" } })).toThrow(/at most 3 numbers/);
    expect(() => cleanSettings({ alerts: { phones: "call me" } })).toThrow(/country code/);
  });

  it("reads plan names", () => {
    expect(planKeyFromName("Pro plan")).toBe("pro");
    expect(planKeyFromName("PRO")).toBe("pro");
    expect(planKeyFromName("Growth")).toBe("free");
    expect(planKeyFromName("Professional")).toBe("free");
    expect(planKeyFromName(null)).toBe("free");
  });
});
