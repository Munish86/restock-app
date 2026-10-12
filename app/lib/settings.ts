// Store settings: forecast defaults, which locations count, purchase order details and alerts.
// Shared by the server (validation, forecasts) and the browser (settings form). No server-only code here.

export interface ForecastSettings {
  lookbackDays: number; // sales history used for the sales rate
  daysToCover: number; // an order should last this long after it arrives
  safetyDays: number; // extra stock, in days of sales, for late deliveries or a busy week
  leadTimeDays: number; // default days from ordering to stock arriving
  seasonal: boolean; // use last year's sales to raise or lower the forecast for the coming weeks
  countIncoming: boolean; // count Shopify's own incoming stock (transfers) as already on order
  countDrafts: boolean; // count draft purchase orders as already on order
  deadStockDays: number; // no sale for this long = dead stock
  overstockDays: number; // more stock than this many days of sales = overstock
}

export interface PoSettings {
  prefix: string; // "PO-" -> PO-0001
  receiveLocationId: string; // default location stock is received at; "" = the first counted location
  companyName: string; // printed on purchase orders; "" = the store name
  companyAddress: string;
  replyTo: string; // suppliers reply to this address; "" = the store email
  footer: string; // terms printed at the bottom of every purchase order
  updateCostOnReceive: boolean; // set Shopify's cost per item to the order's cost when stock is received
}

export interface AlertSettings {
  weekly: boolean;
  weeklyDay: number; // 0 = Sunday ... 6 = Saturday
  hour: number; // local hour the emails go out
  lowStock: boolean; // daily email when items newly need ordering
  recipients: string; // comma separated; "" = the store email
}

export interface Settings {
  forecast: ForecastSettings;
  locations: string[]; // location ids whose stock counts; [] = every active location (limited by the plan)
  po: PoSettings;
  alerts: AlertSettings;
}

export const DEFAULTS: Settings = {
  forecast: {
    lookbackDays: 90,
    daysToCover: 30,
    safetyDays: 7,
    leadTimeDays: 14,
    seasonal: true,
    countIncoming: true,
    countDrafts: false,
    deadStockDays: 90,
    overstockDays: 180,
  },
  locations: [],
  po: {
    prefix: "PO-",
    receiveLocationId: "",
    companyName: "",
    companyAddress: "",
    replyTo: "",
    footer: "",
    updateCostOnReceive: false,
  },
  alerts: { weekly: true, weeklyDay: 1, hour: 8, lowStock: true, recipients: "" },
};

// Allowed ranges, also used by the form
export const LIMITS = {
  lookbackDays: [14, 365],
  daysToCover: [1, 365],
  safetyDays: [0, 120],
  leadTimeDays: [0, 365],
  deadStockDays: [30, 730],
  overstockDays: [30, 1000],
} as const;

export class SettingsError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(" "));
  }
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
export const isEmail = (s: string) => EMAIL.test(s.trim());

// "a@x.com, b@y.com" -> ["a@x.com", "b@y.com"]; invalid entries are returned in `bad`
export function parseEmails(s: string): { list: string[]; bad: string[] } {
  const parts = String(s || "")
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return { list: [...new Set(parts.filter(isEmail).map((x) => x.toLowerCase()))], bad: parts.filter((x) => !isEmail(x)) };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

// Fills in anything missing, so settings saved by an older version still work
export function withDefaults(raw: unknown): Settings {
  const r = obj(raw);
  return {
    forecast: { ...DEFAULTS.forecast, ...(obj(r.forecast) as Partial<ForecastSettings>) },
    locations: Array.isArray(r.locations) ? (r.locations as unknown[]).filter((x): x is string => typeof x === "string") : [],
    po: { ...DEFAULTS.po, ...(obj(r.po) as Partial<PoSettings>) },
    alerts: { ...DEFAULTS.alerts, ...(obj(r.alerts) as Partial<AlertSettings>) },
  };
}

// Checks settings sent by the browser. Only known fields are kept, every number is range-checked and text is
// cut to a sane length. Throws SettingsError listing every problem at once.
export function cleanSettings(raw: unknown): Settings {
  const r = obj(raw);
  const problems: string[] = [];
  const f = obj(r.forecast);
  const po = obj(r.po);
  const al = obj(r.alerts);

  const int = (v: unknown, key: keyof typeof LIMITS, label: string): number => {
    const [min, max] = LIMITS[key];
    const n = Number(v);
    if (v === "" || v == null || !Number.isInteger(n) || n < min || n > max) {
      problems.push(`${label} must be a whole number from ${min} to ${max}.`);
      return DEFAULTS.forecast[key];
    }
    return n;
  };
  const text = (v: unknown, max: number) => String(v ?? "").slice(0, max);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

  const forecast: ForecastSettings = {
    lookbackDays: int(f.lookbackDays ?? DEFAULTS.forecast.lookbackDays, "lookbackDays", "Sales history"),
    daysToCover: int(f.daysToCover ?? DEFAULTS.forecast.daysToCover, "daysToCover", "Days to cover"),
    safetyDays: int(f.safetyDays ?? DEFAULTS.forecast.safetyDays, "safetyDays", "Safety stock days"),
    leadTimeDays: int(f.leadTimeDays ?? DEFAULTS.forecast.leadTimeDays, "leadTimeDays", "Lead time"),
    seasonal: bool(f.seasonal, DEFAULTS.forecast.seasonal),
    countIncoming: bool(f.countIncoming, DEFAULTS.forecast.countIncoming),
    countDrafts: bool(f.countDrafts, DEFAULTS.forecast.countDrafts),
    deadStockDays: int(f.deadStockDays ?? DEFAULTS.forecast.deadStockDays, "deadStockDays", "Dead stock after"),
    overstockDays: int(f.overstockDays ?? DEFAULTS.forecast.overstockDays, "overstockDays", "Overstock above"),
  };

  const locations = Array.isArray(r.locations)
    ? [...new Set((r.locations as unknown[]).filter((x): x is string => typeof x === "string" && /^gid:\/\/shopify\/Location\/\d+$/.test(x)))].slice(0, 200)
    : [];

  const replyTo = text(po.replyTo, 200).trim();
  if (replyTo && !isEmail(replyTo)) problems.push("Reply-to must be one email address.");
  const prefix = text(po.prefix ?? DEFAULTS.po.prefix, 12);
  if (/[^\w\-/#. ]/.test(prefix)) problems.push("The order number prefix may only use letters, digits and - / # .");
  const receiveLocationId = text(po.receiveLocationId, 100);
  if (receiveLocationId && !/^gid:\/\/shopify\/Location\/\d+$/.test(receiveLocationId)) problems.push("Choose a location to receive stock at.");

  const recipients = text(al.recipients, 1000);
  const { list, bad } = parseEmails(recipients);
  if (bad.length) problems.push(`Not an email address: ${bad.slice(0, 3).join(", ")}.`);
  if (list.length > 10) problems.push("Alerts can go to at most 10 addresses.");
  const weeklyDay = Number(al.weeklyDay ?? DEFAULTS.alerts.weeklyDay);
  if (!Number.isInteger(weeklyDay) || weeklyDay < 0 || weeklyDay > 6) problems.push("Choose a day for the weekly email.");
  const hour = Number(al.hour ?? DEFAULTS.alerts.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) problems.push("Choose an hour for the emails.");

  if (problems.length) throw new SettingsError(problems);
  return {
    forecast,
    locations,
    po: {
      prefix,
      receiveLocationId,
      companyName: text(po.companyName, 200),
      companyAddress: text(po.companyAddress, 1000),
      replyTo,
      footer: text(po.footer, 2000),
      updateCostOnReceive: bool(po.updateCostOnReceive, DEFAULTS.po.updateCostOnReceive),
    },
    alerts: {
      weekly: bool(al.weekly, DEFAULTS.alerts.weekly),
      weeklyDay,
      hour,
      lowStock: bool(al.lowStock, DEFAULTS.alerts.lowStock),
      recipients: list.join(", "),
    },
  };
}

// "PO-" + 7 -> "PO-0007"
export const poNumber = (prefix: string, n: number) => `${prefix}${String(n).padStart(4, "0")}`;
