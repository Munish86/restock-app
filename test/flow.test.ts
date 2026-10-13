// The whole app against a real Postgres (PGlite) and a simulated Shopify store: sync, forecasts, bundles,
// dead stock, supplier import, purchase orders, emailing, receiving (with retries and undo) and alerts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localDay } from "../app/lib/dates";
import { startDb, shopifyEnv } from "./db";
import { startMock, type MockOrder, type MockState } from "./mock-shopify";
import type { JobContext } from "../app/.server/jobs/process";

shopifyEnv();
const SHOP = "test-store.myshopify.com";
const today = localDay(new Date(), "UTC");
const at = (daysAgo: number) => `${addDays(today, -daysAgo)}T10:00:00Z`;

const orders: MockOrder[] = [];
for (let d = 1; d <= 120; d++) orders.push({ id: d, createdAt: at(d), lines: [{ variantId: 1, quantity: 2 }, { variantId: 2, quantity: 1 }] });
orders.push({ id: 900, createdAt: at(3), cancelled: true, lines: [{ variantId: 4, quantity: 5 }] });
orders.push({ id: 901, createdAt: at(4), test: true, lines: [{ variantId: 4, quantity: 1 }] });
orders.push({ id: 902, createdAt: at(5), lines: [{ variantId: null, quantity: 3 }] }); // a custom item: no variant

const state: MockState = {
  shop: { name: "Test Store", email: "owner@test-store.com", currencyCode: "USD", ianaTimezone: "UTC" },
  scopes: ["read_products", "write_inventory", "read_locations", "read_orders", "read_all_orders"],
  locations: [
    { id: 2, name: "Shop front", isActive: true },
    { id: 1, name: "Warehouse", isActive: true },
    { id: 3, name: "Closed store", isActive: false },
  ],
  variants: [
    { id: 1, productId: 10, productTitle: "Oslo Mug", title: "Default Title", sku: "MUG-1", price: "12.00", cost: "4.00", createdAt: at(800), levels: { 1: 20, 2: 5 } },
    {
      id: 2, productId: 20, productTitle: "Tea Set", title: "Default Title", sku: "SET-1", price: "30.00", cost: null, createdAt: at(800),
      requiresComponents: true, components: [{ variantId: 1, quantity: 2 }, { variantId: 3, quantity: 1 }], levels: {},
    },
    { id: 3, productId: 30, productTitle: "Saucer", title: "Blue", sku: "SAU-1", price: "5.00", cost: "1.50", createdAt: at(800), levels: { 1: 100 } },
    { id: 4, productId: 40, productTitle: "Old Lamp", title: "Default Title", sku: "LAMP-1", price: "80.00", cost: "30.00", vendor: "Lumen", createdAt: at(400), levels: { 1: 10 } },
    { id: 5, productId: 50, productTitle: "Gift card", title: "$25", sku: "", price: "25.00", cost: null, tracked: false, createdAt: at(800), levels: {} },
  ],
  orders,
};

let mock: Awaited<ReturnType<typeof startMock>>;
let stopDb: () => Promise<void>;
// Modules that read DATABASE_URL on import are loaded after the database starts
let prisma: typeof import("../app/db.server").default;
let sync: typeof import("../app/.server/sync");
let planning: typeof import("../app/.server/planning");
let pos: typeof import("../app/.server/purchase-orders");
let suppliers: typeof import("../app/.server/suppliers");
let alerts: typeof import("../app/.server/alerts");
let email: typeof import("../app/.server/email");
let shopifyLib: typeof import("../app/.server/core/shopify");
let mailer: InstanceType<typeof import("../app/.server/email").LogMailer>;

const client = () => new shopifyLib.Shopify({ shop: SHOP, apiVersion: "2026-10", accessToken: async () => "token", endpoint: mock.endpoint });
const ctx = (command: string, options: Record<string, unknown> = {}): JobContext & { lines: string[] } => {
  const lines: string[] = [];
  return { job: { id: "job1", shop: SHOP, command, options, attempts: 1 }, log: (m) => lines.push(m), progress: () => {}, shouldStop: () => false, lines };
};
const row = async (variant: number) => (await planning.loadPlanning(SHOP)).rows.find((r) => r.id === `gid://shopify/ProductVariant/${variant}`)!;

beforeAll(async () => {
  const db = await startDb();
  stopDb = db.stop;
  mock = await startMock(state);
  prisma = (await import("../app/db.server")).default;
  sync = await import("../app/.server/sync");
  planning = await import("../app/.server/planning");
  pos = await import("../app/.server/purchase-orders");
  suppliers = await import("../app/.server/suppliers");
  alerts = await import("../app/.server/alerts");
  email = await import("../app/.server/email");
  shopifyLib = await import("../app/.server/core/shopify");
  mailer = new email.LogMailer();
  email.setMailer(mailer);
  await prisma.shop.create({ data: { shop: SHOP } });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await mock?.close();
  await stopDb?.();
});

describe("sync", () => {
  it("copies variants, stock, bundles and two years of daily sales", async () => {
    const c = ctx("sync");
    const r = await sync.syncShop(c, client(), { pollMs: 1 });
    // 120 days of orders, plus one with only a custom item (counted as an order, adds no sales)
    expect(r.counts).toMatchObject({ Variants: 5, Locations: 3, Orders: 121 });
    const s = await prisma.shop.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(s).toMatchObject({ name: "Test Store", email: "owner@test-store.com", currency: "USD", allOrders: true });
    expect(s.ordersFrom?.toISOString().slice(0, 10)).toBe(addDays(today, -730));
    expect(await prisma.salesDay.count({ where: { shop: SHOP, variantId: "gid://shopify/ProductVariant/1" } })).toBe(120);
    // Cancelled and test orders are not sales; a custom line without a variant is skipped
    expect(await prisma.salesDay.count({ where: { shop: SHOP, variantId: "gid://shopify/ProductVariant/4" } })).toBe(0);
    expect(await prisma.inventoryLevel.count({ where: { shop: SHOP } })).toBe(4);
    expect(await prisma.bundleComponent.count({ where: { shop: SHOP, source: "shopify" } })).toBe(2);
    const set = await prisma.variant.findUniqueOrThrow({ where: { shop_id: { shop: SHOP, id: "gid://shopify/ProductVariant/2" } } });
    expect(set.isBundle).toBe(true);
    // Both exports ran at the same time on Shopify's side
    expect(mock.calls.filter((x) => x.query.includes("bulkOperationRunQuery")).length).toBe(2);
  });

  it("re-reads only recent orders next time, keeping older history", async () => {
    const before = await prisma.salesDay.aggregate({ where: { shop: SHOP }, _sum: { units: true } });
    const c = ctx("sync");
    const r = await sync.syncShop(c, client(), { pollMs: 1 });
    expect(r.counts?.Orders).toBe(36); // 35 days + the custom-item order
    const after = await prisma.salesDay.aggregate({ where: { shop: SHOP }, _sum: { units: true } });
    expect(after._sum.units).toBe(before._sum.units);
    const q = mock.calls.filter((x) => x.query.includes("bulkOperationRunQuery")).at(-1)!.variables.q as string;
    expect(q).toContain(addDays(today, -36));
  });

  it("marks variants deleted in Shopify, and keeps them", async () => {
    state.variants.push({ id: 6, productId: 60, productTitle: "Temp", title: "Default Title", sku: "TMP", price: "1", cost: null, createdAt: at(10), levels: {} });
    await sync.syncShop(ctx("sync"), client(), { pollMs: 1 });
    state.variants.pop();
    await sync.syncShop(ctx("sync"), client(), { pollMs: 1 });
    const v = await prisma.variant.findUniqueOrThrow({ where: { shop_id: { shop: SHOP, id: "gid://shopify/ProductVariant/6" } } });
    expect(v.deletedAt).not.toBeNull();
    expect((await planning.loadPlanning(SHOP)).rows.some((r) => r.id.endsWith("/6"))).toBe(false);
  });

  it("records today's stock-outs", async () => {
    state.variants[2].levels[1] = 0;
    await sync.syncShop(ctx("sync"), client(), { pollMs: 1 });
    expect(await prisma.outOfStockDay.count({ where: { shop: SHOP, variantId: "gid://shopify/ProductVariant/3" } })).toBe(1);
    state.variants[2].levels[1] = 100;
    await sync.syncShop(ctx("sync"), client(), { pollMs: 1 });
  });
});

describe("reorder list", () => {
  it("counts bundle sales in their parts, and only the plan's locations", async () => {
    const mug = await row(1);
    // 2 a day sold alone + 1 tea set a day x 2 mugs
    expect(mug.f.rate).toBeCloseTo(4, 6);
    expect(mug.f.why.join(" ")).toContain("sold inside bundles");
    expect(mug.available).toBe(20); // Free plan: one location, the oldest (Warehouse)
    expect(mug.f.status).toBe("order-now");
    expect(mug.f.suggested).toBe(4 * (14 + 30) + 4 * 7 - 20);
    const saucer = await row(3);
    expect(saucer.f.rate).toBeCloseTo(1, 6);
    expect((await row(2)).f.status).toBe("bundle");
    const gift = await row(5);
    expect(gift.f.status).toBe("ignored");
    expect(gift.f.why[0]).toContain("does not track");
  });

  it("counts every chosen location on Pro", async () => {
    await prisma.shop.update({ where: { shop: SHOP }, data: { plan: "pro" } });
    expect((await row(1)).available).toBe(25);
    await prisma.shop.update({ where: { shop: SHOP }, data: { plan: "free", settings: { locations: ["gid://shopify/Location/2"] } } });
    expect((await row(1)).available).toBe(5);
    await prisma.shop.update({ where: { shop: SHOP }, data: { settings: {} } });
  });

  it("limits forecasts to the plan's best sellers", async () => {
    const free = await planning.loadPlanning(SHOP);
    expect(free.totalVariants).toBe(4);
    await prisma.shop.update({ where: { shop: SHOP }, data: { plan: "free" } });
    const PLANS = (await import("../app/lib/plans")).PLANS;
    const old = PLANS[0].variants;
    PLANS[0].variants = 2;
    try {
      const p = await planning.loadPlanning(SHOP);
      const outside = p.rows.filter((r) => r.outsidePlan).map((r) => r.sku);
      expect(outside.sort()).toEqual(["", "LAMP-1"]);
      expect(p.rows.find((r) => r.sku === "LAMP-1")!.f.why[0]).toContain("Outside your plan");
    } finally {
      PLANS[0].variants = old;
    }
  });

  it("lists dead stock with the money in it", async () => {
    const p = await planning.loadPlanning(SHOP);
    const dead = planning.deadStock(p);
    expect(dead.map((d) => d.sku)).toEqual(["LAMP-1"]);
    expect(dead[0].value).toBe(300);
    const s = planning.summary(p);
    expect(s.deadValue).toBe(300);
    expect(s.needsOrder).toBeGreaterThanOrEqual(1);
  });

  it("applies the merchant's choices", async () => {
    await suppliers.updatePlans(SHOP, ["gid://shopify/ProductVariant/3"], { rateOverride: "3", daysToCover: 10 });
    const s = await row(3);
    expect(s.f.rate).toBe(3);
    expect(s.daysToCover).toBe(10);
    await suppliers.updatePlans(SHOP, ["gid://shopify/ProductVariant/3"], { rateOverride: "", daysToCover: "" });
    expect((await row(3)).f.rate).toBeCloseTo(1, 6);
    await expect(suppliers.updatePlans(SHOP, ["gid://shopify/ProductVariant/999"], { ignore: true })).rejects.toThrow("not found");
  });
});

describe("suppliers", () => {
  it("imports suppliers and terms from a sheet, preview first", async () => {
    const { saveSheet } = await import("../app/.server/files");
    const csv = [
      "SKU,Supplier,Supplier code,Cost price,Case pack,Lead time,Supplier email",
      "MUG-1,Acme Ceramics,AC-MUG,3.50,12,10,orders@acme.test",
      "SAU-1,Acme Ceramics,AC-SAU,\"1,20\",,,",
      "LAMP-1,Lumen,,30,,abc,",
      "NOPE-9,Acme Ceramics,,,,,",
      ",Acme Ceramics,,,,,",
    ].join("\n");
    const file = await saveSheet(SHOP, "suppliers.csv", Buffer.from(csv));
    const { runImport } = await import("../app/.server/imports");
    const options = {
      source: "file",
      fileId: file.id,
      matchBy: "sku",
      columns: { sku: "SKU", supplier: "Supplier", supplierSku: "Supplier code", cost: "Cost price", casePack: "Case pack", leadTimeDays: "Lead time", supplierEmail: "Supplier email" },
    };
    const plan = await runImport(ctx("import-plan", options), false);
    expect(plan.counts).toMatchObject({ "Will link": 3, "Not found": 1, Skipped: 1, "New suppliers to create": 2 });
    expect(await prisma.supplier.count({ where: { shop: SHOP } })).toBe(0);
    const done = await runImport(ctx("import", options), true);
    expect(done.counts).toMatchObject({ Linked: 3 });
    const acme = await prisma.supplier.findFirstOrThrow({ where: { shop: SHOP, name: "Acme Ceramics" } });
    expect(acme.email).toBe("orders@acme.test");
    const item = await prisma.supplierItem.findUniqueOrThrow({ where: { shop_variantId: { shop: SHOP, variantId: "gid://shopify/ProductVariant/1" } } });
    expect(item).toMatchObject({ supplierSku: "AC-MUG", casePack: 12, leadTimeDays: 10 });
    expect(Number(item.cost)).toBe(3.5);
    // "1,20" is read as 1.20 (European decimal comma)
    const sau = await prisma.supplierItem.findUniqueOrThrow({ where: { shop_variantId: { shop: SHOP, variantId: "gid://shopify/ProductVariant/3" } } });
    expect(Number(sau.cost)).toBe(1.2);
    const lampRow = (done.report as { rows: { key: string; warnings: string }[] }).rows.find((r) => r.key === "LAMP-1")!;
    expect(lampRow.warnings).toContain('Lead time "abc" is not valid');
    // Importing again changes nothing
    const again = await runImport(ctx("import", options), true);
    expect(again.counts).toMatchObject({ "No change": 3 });
  });

  it("uses supplier terms in the suggestion", async () => {
    const mug = await row(1);
    expect(mug.supplierName).toBe("Acme Ceramics");
    expect(mug.leadTimeDays).toBe(10);
    // 4 x (10 + 30) + 28 - 20 = 168 = 14 packs of 12
    expect(mug.f.suggested).toBe(168);
    expect(mug.unitCost).toBe(3.5);
  });

  it("creates suppliers from vendors and refuses duplicates", async () => {
    await expect(suppliers.createSupplier(SHOP, { name: " lumen " })).rejects.toThrow("already exists");
    await expect(suppliers.createSupplier(SHOP, { name: "X", email: "bad" })).rejects.toThrow("not valid");
    const r = await suppliers.suppliersFromVendors(SHOP);
    // Tea Set and Gift card have vendor Acme and no supplier yet
    expect(r).toEqual({ created: 1, assigned: 2 });
  });

  it("sets up a bundle by hand", async () => {
    await expect(suppliers.setBundle(SHOP, "gid://shopify/ProductVariant/2", [])).rejects.toThrow("set up in Shopify");
    await suppliers.setBundle(SHOP, "gid://shopify/ProductVariant/4", [{ variantId: "gid://shopify/ProductVariant/3", quantity: 2 }]);
    expect((await row(4)).f.status).toBe("bundle");
    await expect(suppliers.setBundle(SHOP, "gid://shopify/ProductVariant/4", [{ variantId: "gid://shopify/ProductVariant/2", quantity: 1 }])).rejects.toThrow(
      "another bundle",
    );
    await suppliers.setBundle(SHOP, "gid://shopify/ProductVariant/4", []);
    expect((await row(4)).f.status).not.toBe("bundle");
  });
});

describe("purchase orders", () => {
  let poId = "";

  it("creates one draft per supplier from the reorder list", async () => {
    await expect(pos.createFromSuggestions(SHOP, { items: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 0 }] })).rejects.toThrow("at least one");
    const created = await pos.createFromSuggestions(SHOP, {
      items: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 168 },
        { variantId: "gid://shopify/ProductVariant/3", quantity: 24 },
        { variantId: "gid://shopify/ProductVariant/4", quantity: 5 },
      ],
    });
    expect(created.map((c) => c.supplier).sort()).toEqual(["Acme Ceramics", "Lumen"]);
    expect(created.map((c) => c.number).sort()).toEqual(["PO-0001", "PO-0002"]);
    poId = created.find((c) => c.supplier === "Acme Ceramics")!.id;
    const po = (await pos.getPo(SHOP, poId))!;
    expect(po.lines.map((l) => [l.sku, l.quantity, l.unitCost, l.supplierSku])).toEqual([
      ["MUG-1", 168, 3.5, "AC-MUG"],
      ["SAU-1", 24, 1.2, "AC-SAU"],
    ]);
    expect(po.locationName).toBe("Warehouse");
    expect(po.expectedAt).toBe(addDays(today, 14));
    // Drafts are not counted as on order (default setting)
    expect((await row(1)).onOrder).toBe(0);
    // Again: lands on the same draft instead of a new one
    const again = await pos.createFromSuggestions(SHOP, { items: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 180 }] });
    expect(again[0]).toMatchObject({ id: poId, merged: true });
    expect((await pos.getPo(SHOP, poId))!.lines[0].quantity).toBe(180);
  });

  it("refuses items without a supplier", async () => {
    await prisma.supplierItem.delete({ where: { shop_variantId: { shop: SHOP, variantId: "gid://shopify/ProductVariant/5" } } });
    await expect(pos.createFromSuggestions(SHOP, { items: [{ variantId: "gid://shopify/ProductVariant/5", quantity: 1 }] })).rejects.toThrow(
      "Choose a supplier first for: Gift card - $25",
    );
  });

  it("edits lines and checks them", async () => {
    const po = (await pos.getPo(SHOP, poId))!;
    await pos.savePo(SHOP, poId, {
      shippingCost: "25",
      notes: "Deliver to back door",
      lines: [...po.lines.map((l) => ({ id: l.id, variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost, supplierSku: l.supplierSku }))],
    });
    await expect(pos.savePo(SHOP, poId, { lines: [{ variantId: po.lines[0].variantId, quantity: 1 }, { variantId: po.lines[0].variantId, quantity: 1 }] })).rejects.toThrow("twice");
    await expect(pos.savePo(SHOP, poId, { lines: [{ id: po.lines[0].id, variantId: po.lines[0].variantId, quantity: -1 }] })).rejects.toThrow("0 or more");
    const list = await pos.listPos(SHOP, { status: "open" });
    const mine = list.find((x) => x.id === poId)!;
    expect(mine.total).toBeCloseTo(180 * 3.5 + 24 * 1.2 + 25, 6);
  });

  it("emails the supplier with the PDF and CSV, and marks it sent", async () => {
    const r = await alerts.emailPo(SHOP, poId, { message: "Thanks!" });
    expect(r.to).toEqual(["orders@acme.test"]);
    const m = mailer.sent.at(-1)!;
    expect(m.subject).toBe("Purchase order PO-0001 from Test Store");
    expect(m.replyTo).toBe("owner@test-store.com");
    expect(m.attachments!.map((a) => a.filename)).toEqual(["PO-0001.pdf", "PO-0001.csv"]);
    expect(m.attachments![0].content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(m.attachments![1].content.toString()).toContain("AC-MUG");
    expect((await pos.getPo(SHOP, poId))!.status).toBe("sent");
    // Sent orders count as on order
    expect((await row(1)).onOrder).toBe(180);
    expect((await row(1)).onOrderPos[0].number).toBe("PO-0001");
    const log = await prisma.emailLog.findFirstOrThrow({ where: { shop: SHOP, kind: "purchase-order" } });
    expect(log.status).toBe("skipped"); // development: logged, not sent
  });

  it("receives part of the order: adds the stock in Shopify once, even when retried", async () => {
    const po = (await pos.getPo(SHOP, poId))!;
    const mugLine = po.lines.find((l) => l.sku === "MUG-1")!;
    const before = mock.level(1, 1);
    const receipt = await pos.createReceipt(SHOP, poId, { lines: [{ lineId: mugLine.id, quantity: 100 }], updateCost: true });
    await pos.applyReceipt(SHOP, receipt.id, client());
    expect(mock.level(1, 1)).toBe(before + 100);
    expect(mock.adjustments.at(-1)).toMatchObject({ reason: "received", reference: `gid://restock-app/PurchaseOrder/${poId}` });
    // Retry of the same receipt (a double click, or a timeout): nothing more is added anywhere
    await pos.applyReceipt(SHOP, receipt.id, client());
    expect(mock.level(1, 1)).toBe(before + 100);
    const after = (await pos.getPo(SHOP, poId))!;
    expect(after.status).toBe("partial");
    expect(after.lines.find((l) => l.sku === "MUG-1")!.received).toBe(100);
    expect((await row(1)).onOrder).toBe(80);
    expect((await row(1)).available).toBe(120);
    // Cost per item updated in Shopify
    expect(mock.costs.get("gid://shopify/InventoryItem/1")).toBe(3.5);
  });

  it("does not count a receipt Shopify refused, and lets it be retried", async () => {
    const po = (await pos.getPo(SHOP, poId))!;
    const line = po.lines.find((l) => l.sku === "SAU-1")!;
    const r = await pos.createReceipt(SHOP, poId, { lines: [{ lineId: line.id, quantity: 4 }] });
    const broken = new shopifyLib.Shopify({ shop: SHOP, apiVersion: "2026-10", accessToken: async () => "t", endpoint: "http://127.0.0.1:1/graphql" });
    broken.gql = async () => {
      throw new Error("network down");
    };
    await expect(pos.applyReceipt(SHOP, r.id, broken)).rejects.toThrow("network down");
    expect((await pos.getPo(SHOP, poId))!.lines.find((l) => l.sku === "SAU-1")!.received).toBe(0);
    await pos.applyReceipt(SHOP, r.id, client());
    expect((await pos.getPo(SHOP, poId))!.lines.find((l) => l.sku === "SAU-1")!.received).toBe(4);
  });

  it("undoes a receipt", async () => {
    const po = (await pos.getPo(SHOP, poId))!;
    const last = po.receipts.find((r) => r.status === "done" && r.units === 4)!;
    const before = mock.level(3, 1);
    const undo = await pos.createUndo(SHOP, last.id);
    await pos.applyReceipt(SHOP, undo.id, client());
    expect(mock.level(3, 1)).toBe(before - 4);
    const after = (await pos.getPo(SHOP, poId))!;
    expect(after.lines.find((l) => l.sku === "SAU-1")!.received).toBe(0);
    expect(after.receipts.find((r) => r.id === last.id)!.status).toBe("undone");
    await expect(pos.createUndo(SHOP, last.id)).rejects.toThrow("once");
  });

  it("guards status changes", async () => {
    await expect(pos.setStatus(SHOP, poId, "cancel")).rejects.toThrow("Close it instead");
    await expect(pos.deletePo(SHOP, poId)).rejects.toThrow("Only drafts");
    await expect(suppliers.deleteSupplier(SHOP, (await prisma.supplier.findFirstOrThrow({ where: { name: "Acme Ceramics" } })).id)).rejects.toThrow(
      "cannot be deleted",
    );
    const lines = await pos.receiveAllLines(SHOP, poId);
    const r = await pos.createReceipt(SHOP, poId, { lines });
    await pos.applyReceipt(SHOP, r.id, client());
    const done = (await pos.getPo(SHOP, poId))!;
    expect(done.status).toBe("received");
    expect(done.lines.every((l) => l.received === l.quantity)).toBe(true);
    await expect(pos.savePo(SHOP, poId, { notes: "x" })).rejects.toThrow("closed");
  });

  it("makes a PDF with every line, over several pages", async () => {
    const { poPdf, wrap, encode } = await import("../app/.server/pdf");
    const d = (await pos.poDocument(SHOP, poId))!;
    const many = { ...d, lines: Array.from({ length: 90 }, (_, i) => ({ ...d.lines[0], title: `Item ${i} with a long name ₹ 東京 (test)` })) };
    const pdf = poPdf(many).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect((pdf.match(/\/Type \/Page /g) || []).length).toBeGreaterThan(1);
    expect(pdf).toContain("Item 89");
    expect(pdf).toContain("Rs.");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(encode("é€?")).toEqual([0xe9, 0x80, 0x3f]);
    expect(wrap("a b c", 5, 10).length).toBe(3);
  });
});

describe("alerts", () => {
  it("sends the weekly email only when something needs ordering, and marks urgent items", async () => {
    // Everything was just received: nothing to order
    expect((await alerts.sendWeekly(SHOP)).error).toBe("Nothing to order this week.");
    // The mug sells out in Shopify (as a stock webhook would report)
    await prisma.inventoryLevel.updateMany({ where: { shop: SHOP, inventoryItemId: "gid://shopify/InventoryItem/1" }, data: { available: 3 } });
    await prisma.variant.updateMany({ where: { shop: SHOP }, data: { lowAlertAt: null } });
    const r = await alerts.sendWeekly(SHOP);
    expect(r.status).toBe("skipped"); // logged only in development
    const m = mailer.sent.at(-1)!;
    expect(m.to).toEqual(["owner@test-store.com"]);
    expect(m.subject).toMatch(/^Reorder Desk: order \d+ items? this week$/);
    expect(m.unsubscribeUrl).toContain("/dl/alerts-off/weekly?");
    expect(m.html).toContain("Oslo Mug");
    expect(m.html).not.toContain("<script");
    // The weekly email counts as the alert for urgent items
    const mug = await prisma.variant.findUniqueOrThrow({ where: { shop_id: { shop: SHOP, id: "gid://shopify/ProductVariant/1" } } });
    expect(mug.lowAlertAt).not.toBeNull();
  });

  it("alerts low stock once per episode", async () => {
    const n = mailer.sent.length;
    await alerts.sendLowStock(SHOP);
    expect(mailer.sent.length).toBe(n); // already in the weekly email
    await prisma.variant.updateMany({ where: { shop: SHOP }, data: { lowAlertAt: null } });
    await alerts.sendLowStock(SHOP);
    expect(mailer.sent.length).toBe(n + 1);
    expect(mailer.sent.at(-1)!.subject).toMatch(/to order now$/);
    await alerts.sendLowStock(SHOP);
    expect(mailer.sent.length).toBe(n + 1); // nothing new
    // Stock arrives: the item is fine again, so a later drop alerts again
    await prisma.inventoryLevel.updateMany({ where: { shop: SHOP, inventoryItemId: "gid://shopify/InventoryItem/1" }, data: { available: 500 } });
    await alerts.sendLowStock(SHOP);
    const mug = await prisma.variant.findUniqueOrThrow({ where: { shop_id: { shop: SHOP, id: "gid://shopify/ProductVariant/1" } } });
    expect(mug.lowAlertAt).toBeNull();
  });

  it("sends due emails at the store's hour, once", async () => {
    await prisma.shop.update({ where: { shop: SHOP }, data: { weeklySentAt: null, dailyCheckAt: null, settings: { alerts: { weeklyDay: 1, hour: 8 } } } });
    const monday9 = new Date("2026-10-12T09:00:00Z"); // a Monday, store in UTC
    const sunday9 = new Date("2026-10-11T09:00:00Z");
    expect(await alerts.runDueAlerts(new Date("2026-10-12T07:00:00Z"))).toBe(0);
    expect(await alerts.runDueAlerts(sunday9)).toBe(1); // the daily check only
    expect(await alerts.runDueAlerts(monday9)).toBe(2); // weekly + daily
    expect(await alerts.runDueAlerts(new Date("2026-10-12T10:00:00Z"))).toBe(0);
  });
});

describe("job queue", () => {
  it("allows one active job per store", async () => {
    const { enqueueJob } = await import("../app/.server/jobs/service");
    const q = { added: [] as string[], add: async (id: string) => void q.added.push(id) };
    const job = await enqueueJob(SHOP, "sync", {}, q);
    await expect(enqueueJob(SHOP, "sync", {}, q)).rejects.toThrow("A sync with Shopify is running");
    expect(q.added).toEqual([job.id]);
    await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
  });

  it("runs a job through the worker code and saves the outcome", async () => {
    const { processJob } = await import("../app/.server/jobs/process");
    const { enqueueJob, prismaJobRepo, getJob } = await import("../app/.server/jobs/service");
    const { getStorage } = await import("../app/.server/storage");
    const q = { add: async () => {} };
    const job = await enqueueJob(SHOP, "sync", {}, q);
    const outcome = await processJob(job.id, {
      repo: prismaJobRepo(q),
      storage: getStorage(),
      handlers: { sync: (c) => sync.syncShop(c, client(), { pollMs: 1 }) },
      heartbeatMs: 20,
    });
    expect(outcome).toBe("done");
    const saved = await getJob(SHOP, job.id, { withLog: true });
    expect(saved?.status).toBe("done");
    expect(saved?.log).toContain("Sync finished.");
  });
});
