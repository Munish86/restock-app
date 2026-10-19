// Renders the real Restock pages with a fake API, for checking them in a real browser.
// The reorder rows are made with the real forecast code, so what the page shows is what the app would show.
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { forecast } from "../../app/lib/forecast";
import { DEFAULTS } from "../../app/lib/settings";
import { ReorderList } from "../../app/components/restock/ReorderList";
import { PurchaseOrders } from "../../app/components/restock/PurchaseOrders";
import { PurchaseOrderEditor } from "../../app/components/restock/PurchaseOrderEditor";
import { Suppliers } from "../../app/components/restock/Suppliers";
import { DeadStock } from "../../app/components/restock/DeadStock";
import { SettingsForm } from "../../app/components/restock/SettingsForm";
import type { Row } from "../../app/components/restock/api";

const w = window as unknown as Record<string, unknown>;
const calls: { method: string; url: string; body?: unknown }[] = [];
w.__calls = calls;
w.__nav = [];
const today = new Date().toISOString().slice(0, 10);
const img = (c: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${c}"/></svg>`)}`;

function row(id: number, o: Partial<Row> & { weekly: number; available: number; onOrder?: number; casePack?: number | null }): Row {
  const weeks = Array(13).fill(o.weekly);
  const f = forecast({
    today,
    history: { weeks, outDays: Array(13).fill(0), bundleUnits: id === 1 ? 20 : 0 },
    historyDays: 90,
    available: o.available,
    onOrder: o.onOrder ?? 0,
    incoming: 0,
    leadTimeDays: 14,
    daysToCover: 30,
    safetyDays: 7,
    casePack: o.casePack ?? null,
    seasonal: false,
    countIncoming: true,
    overstockDays: 180,
    ignore: o.ignore,
    isBundle: o.isBundle,
  });
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    productId: `gid://shopify/Product/${id}0`,
    title: "Item",
    variantTitle: "",
    sku: `SKU-${id}`,
    barcode: "",
    vendor: "Acme",
    productType: "",
    imageUrl: img(["#5c6ac4", "#47c1bf", "#f49342", "#de3618", "#50b83c"][id % 5]),
    price: 20,
    unitCost: 8,
    shopifyCost: 8,
    supplierId: "s1",
    supplierName: "Acme Ceramics",
    supplierSku: "",
    leadTimeDays: 14,
    leadFrom: "default",
    daysToCover: 30,
    safetyDays: 7,
    coverOverride: null,
    safetyOverride: null,
    casePack: null,
    minOrderQty: null,
    onOrder: o.onOrder ?? 0,
    onOrderPos: o.onOrder ? [{ id: "po1", number: "PO-0001" }] : [],
    incoming: 0,
    ignore: false,
    rateOverride: null,
    qtyOverride: null,
    note: "",
    isBundle: false,
    bundleOf: [],
    weeks,
    lastSaleDay: o.weekly ? today : null,
    outsidePlan: false,
    ...o,
    f,
  } as Row;
}

const rows: Row[] = [
  row(1, { title: "Oslo Mug", variantTitle: "White", weekly: 28, available: 10 }),
  row(2, { title: "Oslo Mug", variantTitle: "Black", weekly: 14, available: 0, onOrder: 20 }),
  row(3, { title: "Saucer", weekly: 7, available: 30, casePack: 12, supplierId: null, supplierName: null }),
  row(4, { title: "Teapot", weekly: 7, available: 70 }),
  row(5, { title: "Old Lamp", weekly: 0, available: 12, unitCost: 30, lastSaleDay: null }),
  row(6, { title: "Tea Set", weekly: 3, available: 0, isBundle: true, bundleOf: [{ id: "gid://shopify/ProductVariant/1", quantity: 2 }] }),
];

const reorder = {
  today,
  currency: "USD",
  planKey: "free",
  variantLimit: 50,
  totalVariants: 5,
  syncedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  ordersFrom: "2024-10-12",
  allOrders: true,
  seasonalUsed: false,
  settings: DEFAULTS.forecast,
  countedLocations: ["Warehouse"],
  suppliers: [
    { id: "s1", name: "Acme Ceramics" },
    { id: "s2", name: "Lumen" },
  ],
  activeJob: null,
  lastSync: null,
  summary: { counts: {}, needsOrder: 3, stockValue: 1056, missingCost: 0, toOrderUnits: 300, toOrderValue: 2400, deadCount: 1, deadValue: 360, noSupplier: 1 },
  rows,
  csvUrl: "#csv",
};

let po = {
  id: "po1",
  number: "PO-0001",
  status: "sent",
  supplier: { id: "s1", name: "Acme Ceramics", email: "orders@acme.test", ccEmails: "", contactName: "", phone: "", address: "", currency: "", leadTimeDays: 10, minOrderValue: 500, notes: "" },
  locationId: "gid://shopify/Location/1",
  locationName: "Warehouse",
  currency: "USD",
  shopCurrency: "USD",
  expectedAt: today,
  shippingCost: 0,
  notes: "",
  createdAt: new Date().toISOString(),
  sentAt: new Date().toISOString(),
  receivedAt: null,
  cancelledAt: null,
  lines: [
    { id: "l1", variantId: rows[0].id, sku: "SKU-1", title: "Oslo Mug - White", supplierSku: "AC-1", quantity: 48, received: 0, unitCost: 3.5, imageUrl: rows[0].imageUrl, deleted: false, inStock: 10 },
    { id: "l2", variantId: rows[1].id, sku: "SKU-2", title: "Oslo Mug - Black", supplierSku: "AC-2", quantity: 24, received: 0, unitCost: 3.5, imageUrl: rows[1].imageUrl, deleted: false, inStock: 0 },
  ],
  receipts: [] as { id: string; status: string; error: null; undoOf: string | null; createdAt: string; units: number; lines: { lineId: string; title: string; quantity: number }[] }[],
};
const poResponse = () => ({ po, locations: [{ id: "gid://shopify/Location/1", name: "Warehouse" }], suppliers: reorder.suppliers, updateCostOnReceive: false, links: { pdf: "#pdf", csv: "#csv", print: "#print" } });

let jobPolls = 0;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method || "GET";
  let body: unknown;
  if (typeof init?.body === "string") body = JSON.parse(init.body);
  calls.push({ method, url, body });
  await new Promise((r) => setTimeout(r, 20));
  const b = body as Record<string, unknown>;

  if (url.startsWith("/app/api/reorder")) {
    if (url.includes("view=dead")) return json({ ...reorder, rows: [{ ...rows[4], value: 360, daysSinceSale: null }], csvUrl: "#dead" });
    return json(reorder);
  }
  if (url === "/app/api/purchase-orders" && method === "POST") {
    return json({ created: [{ id: "po9", number: "PO-0009", supplier: "Acme Ceramics", lines: (b.items as unknown[]).length, merged: false }] }, 201);
  }
  if (url.startsWith("/app/api/purchase-orders?")) {
    return json({
      orders: [{ id: "po1", number: "PO-0001", status: "sent", closedShort: false, supplierId: "s1", supplier: "Acme Ceramics", currency: "USD", lines: 2, units: 72, received: 0, total: 252, expectedAt: "2020-01-01", createdAt: new Date().toISOString(), sentAt: null, receivedAt: null }],
      suppliers: reorder.suppliers,
    });
  }
  if (url === "/app/api/purchase-orders/po1") {
    if (method === "GET") return json(poResponse());
    if (b.action === "save") {
      po = { ...po, lines: po.lines.map((l) => ({ ...l, ...((b.lines as { id: string; quantity: number }[]).find((x) => x.id === l.id) ?? {}) })) };
      return json(poResponse());
    }
    if (b.action === "receive") {
      const got = b.lines as { lineId: string; quantity: number }[];
      po = {
        ...po,
        status: "partial",
        lines: po.lines.map((l) => ({ ...l, received: l.received + (got.find((g) => g.lineId === l.id)?.quantity ?? 0) })),
        receipts: [{ id: "r1", status: "done", error: null, undoOf: null, createdAt: new Date().toISOString(), units: got.reduce((s, g) => s + g.quantity, 0), lines: got.map((g) => ({ lineId: g.lineId, title: "Oslo Mug", quantity: g.quantity })) }],
      };
      return json({ ...poResponse(), warnings: [] });
    }
    if (b.action === "undo-receipt") {
      po = { ...po, status: "sent", lines: po.lines.map((l) => ({ ...l, received: 0 })), receipts: [{ ...po.receipts[0], status: "undone" }] };
      return json(poResponse());
    }
    if (b.action === "send") return json({ ...poResponse(), sent: { status: "sent", to: [b.to], cc: [] } });
    return json(poResponse());
  }
  if (url.startsWith("/app/api/variants") && method === "GET") {
    return json({ variants: [{ id: "gid://shopify/ProductVariant/4", productTitle: "Teapot", variantTitle: "", sku: "SKU-4", imageUrl: null, unitCost: 12, isBundle: false }] });
  }
  if (url === "/app/api/variants") return json({ updated: 1, ok: true });
  if (url === "/app/api/suppliers" && method === "GET") {
    return json({
      suppliers: [{ id: "s1", name: "Acme Ceramics", email: "orders@acme.test", ccEmails: "", contactName: "Ann", phone: "", address: "", currency: "", leadTimeDays: 10, minOrderValue: 500, notes: "", items: 3, openOrders: 1 }],
      unassigned: 4,
      vendorsWithout: 2,
    });
  }
  if (url === "/app/api/suppliers") return json(b.action === "from-vendors" ? { created: 2, assigned: 4 } : { ok: true }, b.action === "create" ? 201 : 200);
  if (url.startsWith("/app/api/sheet")) {
    return json({
      sheet: {
        name: "Google Sheet",
        worksheets: ["Suppliers"],
        headers: ["Variant SKU", "Supplier", "Supplier code", "Cost price", "Notes"],
        headerRow: 1,
        rowCount: 3,
        preview: [{ "Variant SKU": "SKU-1", Supplier: "Acme Ceramics", "Supplier code": "AC-1", "Cost price": "3.50" }],
        suggested: { sku: "Variant SKU", supplier: "Supplier", supplierSku: "Supplier code", cost: "Cost price" },
      },
    });
  }
  if (url === "/app/api/jobs" && method === "POST") return json({ job: { id: b.command === "import" ? "j-import" : "j-plan", status: "queued", command: b.command } }, 201);
  if (url.startsWith("/app/api/jobs/j-")) {
    const id = url.split("/")[4].split("?")[0];
    const command = id === "j-import" ? "import" : "import-plan";
    if (url.includes("report=json")) {
      return json({
        rows: [
          { row: 2, key: "SKU-1", item: "Oslo Mug - White", supplier: "Acme Ceramics", action: command === "import" ? "Linked" : "Will link", changes: "supplier Acme Ceramics, cost 3.5", warnings: "" },
          { row: 3, key: "NOPE", item: "", supplier: "", action: "Not found", changes: "", warnings: 'No item in Shopify has SKU "NOPE".' },
        ],
        newSuppliers: [],
        csvUrl: "#report",
      });
    }
    jobPolls++;
    const done = jobPolls % 2 === 0;
    return json({
      job: {
        id,
        command,
        status: done ? "done" : "running",
        options: null,
        progress: { done: done ? 3 : 1, total: 3, step: done ? "Done" : "Matching items" },
        counts: done ? (command === "import" ? { Linked: 1, "Not found": 1 } : { "Will link": 1, "Not found": 1 }) : null,
        error: null,
        stopAsked: false,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      },
    });
  }
  if (url === "/app/api/settings") {
    const pro = new URLSearchParams(location.search).get("plan") === "pro";
    if (method === "POST" && b.action === "test-message") w.__testMessage = true;
    const state = {
      settings: method === "POST" && b.settings ? b.settings : DEFAULTS,
      shopEmail: "owner@store.test",
      shopName: "Test Store",
      currency: "USD",
      timezone: "Asia/Kolkata",
      plan: pro ? { key: "pro", name: "Pro", locations: null, messages: 100 } : { key: "free", name: "Free", locations: 1, messages: 0 },
      locations: [
        { id: "gid://shopify/Location/1", name: "Warehouse", isActive: true },
        { id: "gid://shopify/Location/2", name: "Shop front", isActive: true },
      ],
      emails: [],
      emailLive: false,
      messages: w.__testMessage
        ? [{ kind: "test", channel: "sms", to: "+15550102000", text: "Reorder Desk: test message for Test Store.", status: "sent", error: null, at: "2026-10-19T09:00:00Z" }]
        : [],
      messagesUsed: w.__testMessage ? 1 : 0,
      textLive: { sms: true, whatsapp: false },
    };
    w.__settings = state.settings;
    if (method === "POST" && b.action === "test-message") return json({ ...state, result: { status: "sent", sent: 1, to: ["+15550102000"] } });
    if (method === "POST" && b.action) return json({ ...state, result: { status: "skipped", to: ["owner@store.test"] } });
    return json(state);
  }
  return json({ error: `Fake API has no ${method} ${url}` }, 404);
};

const page = new URLSearchParams(location.search).get("page") || "reorder";
const go = (p: string) => (w.__nav as string[]).push(p);
const el =
  page === "po"
    ? createElement(PurchaseOrders, { go })
    : page === "po-edit"
      ? createElement(PurchaseOrderEditor, { id: "po1", go })
      : page === "suppliers"
        ? createElement(Suppliers, { currency: "USD" })
        : page === "dead"
          ? createElement(DeadStock)
          : page === "settings"
            ? createElement(SettingsForm, { googleEmail: "restock@project.iam.gserviceaccount.com" })
            : createElement(ReorderList, { go });
createRoot(document.getElementById("root")!).render(el);
