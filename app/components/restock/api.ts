// Calls to the app's own endpoints, and the shapes they return. Inside Shopify Admin, App Bridge adds the
// session token to every fetch to the app's origin, so no auth code is needed here.
import type { Forecast } from "../../lib/forecast";
import type { ForecastSettings, Settings } from "../../lib/settings";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public problems?: string[],
  ) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      ...(json !== undefined
        ? { method: rest.method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) }
        : {}),
    });
  } catch {
    throw new ApiError("Could not reach the app. Check your connection and try again.", 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `Error ${res.status}`, res.status, body.problems);
  return body as T;
}

export const post = <T = unknown>(url: string, json: unknown) => api<T>(url, { json });

// Shown as a short message at the bottom of Shopify Admin (App Bridge); ignored outside Admin
export function toast(message: string, isError = false) {
  const s = (globalThis as { shopify?: { toast?: { show: (m: string, o?: { isError?: boolean }) => void } } }).shopify;
  s?.toast?.show(message, isError ? { isError: true } : undefined);
}

export interface JobInfo {
  id: string;
  command: "sync" | "import-plan" | "import";
  status: "queued" | "running" | "done" | "failed" | "stopped";
  options: Record<string, unknown> | null;
  progress: { done: number; total: number; step?: string } | null;
  counts: Record<string, number> | null;
  error: string | null;
  stopAsked: boolean;
  log?: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const isActive = (j?: JobInfo | null) => !!j && (j.status === "queued" || j.status === "running");

export interface Row {
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
  unitCost: number | null;
  shopifyCost: number | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierSku: string;
  leadTimeDays: number;
  leadFrom: "item" | "supplier" | "default";
  daysToCover: number;
  safetyDays: number;
  coverOverride: number | null;
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
  bundleOf: { id: string; quantity: number }[];
  weeks: number[];
  lastSaleDay: string | null;
  outsidePlan: boolean;
  f: Forecast;
}

export interface DeadRow extends Row {
  value: number | null;
  daysSinceSale: number | null;
}

export interface Summary {
  counts: Record<string, number>;
  needsOrder: number;
  stockValue: number;
  missingCost: number;
  toOrderUnits: number;
  toOrderValue: number;
  deadCount: number;
  deadValue: number;
  noSupplier: number;
}

export interface ReorderData {
  today: string;
  currency: string;
  planKey: string;
  variantLimit: number | null;
  totalVariants: number;
  syncedAt: string | null;
  ordersFrom: string | null;
  allOrders: boolean;
  seasonalUsed: boolean;
  settings: ForecastSettings;
  countedLocations: string[];
  suppliers: { id: string; name: string }[];
  activeJob: JobInfo | null;
  lastSync: JobInfo | null;
  summary: Summary;
  rows: Row[];
  csvUrl: string;
}

export interface DeadData extends Omit<ReorderData, "summary" | "rows"> {
  rows: DeadRow[];
}

export interface Supplier {
  id: string;
  name: string;
  email: string;
  ccEmails: string;
  contactName: string;
  phone: string;
  address: string;
  currency: string;
  leadTimeDays: number | null;
  minOrderValue: number | null;
  notes: string;
  items: number;
  openOrders: number;
}

export interface PoSummary {
  id: string;
  number: string;
  status: "draft" | "sent" | "partial" | "received" | "cancelled";
  closedShort: boolean;
  supplierId: string;
  supplier: string;
  currency: string;
  lines: number;
  units: number;
  received: number;
  total: number;
  expectedAt: string | null;
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
}

export interface PoLine {
  id: string;
  variantId: string;
  sku: string;
  title: string;
  supplierSku: string;
  quantity: number;
  received: number;
  unitCost: number;
  imageUrl: string | null;
  deleted: boolean;
  inStock: number | null;
}

export interface Receipt {
  id: string;
  status: "pending" | "done" | "failed" | "undone";
  error: string | null;
  undoOf: string | null;
  createdAt: string;
  units: number;
  lines: { lineId: string; title: string; quantity: number }[];
}

export interface PoDetail {
  id: string;
  number: string;
  status: PoSummary["status"];
  supplier: Omit<Supplier, "items" | "openOrders">;
  locationId: string;
  locationName: string;
  currency: string;
  shopCurrency: string;
  expectedAt: string | null;
  shippingCost: number;
  notes: string;
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  lines: PoLine[];
  receipts: Receipt[];
}

export interface PoResponse {
  po: PoDetail;
  locations: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  updateCostOnReceive: boolean;
  links: { pdf: string; csv: string; print: string };
  warnings?: string[];
  sent?: { status: string; to: string[]; cc: string[] };
}

export interface SettingsData {
  settings: Settings;
  shopEmail: string;
  shopName: string;
  currency: string;
  timezone: string;
  plan: { key: string; name: string; locations: number | null };
  locations: { id: string; name: string; isActive: boolean }[];
  emails: { kind: string; to: string; subject: string; status: string; error: string | null; at: string }[];
  emailLive: boolean;
}

export interface VariantHit {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  imageUrl: string | null;
  unitCost: number | null;
  isBundle: boolean;
}
