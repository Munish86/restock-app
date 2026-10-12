// Purchase orders: created from the reorder list (one per supplier) or by hand, edited, sent, and received.
// Receiving adds the stock in Shopify. Each receipt is saved before Shopify is called and its id is the
// idempotency key, so a retry after a timeout can never add the stock twice.
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { addDays, localDay } from "../lib/dates";
import { poNumber, withDefaults } from "../lib/settings";
import { poReference, STOCK_CHANGES_PER_CALL, type Shopify } from "./core/shopify";
import { InputError } from "./suppliers";
import { countedLocations } from "./sync";

export const OPEN = ["draft", "sent", "partial"];
const MAX_LINES = 1000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));

function qtyOf(v: unknown, label = "Quantity"): number {
  const q = Number(v);
  if (!Number.isInteger(q) || q < 0 || q > 10_000_000) throw new InputError(`${label} must be a whole number of 0 or more.`);
  return q;
}
function costOf(v: unknown): number {
  if (v === "" || v == null) return 0;
  const c = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(c) || c < 0 || c > 1e9) throw new InputError("Cost must be an amount of 0 or more.");
  return Math.round(c * 10000) / 10000;
}

async function shopContext(shop: string) {
  const s = await prisma.shop.findUnique({ where: { shop } });
  if (!s) throw new InputError("Store not found.", 404);
  const settings = withDefaults(s.settings);
  const locations = await prisma.location.findMany({ where: { shop } });
  const counted = countedLocations(locations, settings.locations, s.plan);
  const defaultLocation =
    (settings.po.receiveLocationId && locations.find((l) => l.id === settings.po.receiveLocationId && l.isActive)?.id) ||
    counted[0] ||
    locations.find((l) => l.isActive)?.id ||
    "";
  return { s, settings, locations, defaultLocation, today: localDay(new Date(), s.timezone) };
}

async function nextNumber(tx: Prisma.TransactionClient, shop: string) {
  const r = await tx.shop.update({ where: { shop }, data: { poCounter: { increment: 1 } }, select: { poCounter: true } });
  return r.poCounter;
}

// ---- Create ----

export interface SuggestionItem {
  variantId: string;
  quantity: number;
}

// One draft per supplier from the chosen reorder-list items. If the supplier already has a draft, the items go
// on it (an item already there gets the new quantity), so repeated clicks do not pile up drafts.
export async function createFromSuggestions(shop: string, raw: unknown) {
  const items: SuggestionItem[] = (Array.isArray(obj(raw).items) ? (obj(raw).items as unknown[]) : []).map((x) => {
    const o = obj(x);
    if (typeof o.variantId !== "string") throw new InputError("Choose items to order.");
    return { variantId: o.variantId, quantity: qtyOf(o.quantity) };
  });
  const wanted = items.filter((i) => i.quantity > 0);
  if (!wanted.length) throw new InputError("Choose at least one item with a quantity above 0.");
  if (wanted.length > MAX_LINES) throw new InputError(`At most ${MAX_LINES} items at once.`);
  const mergeDrafts = obj(raw).mergeDrafts !== false;

  const ctx = await shopContext(shop);
  if (!ctx.defaultLocation) throw new InputError("Shopify has no active location to receive stock at. Sync with Shopify first.");
  const ids = [...new Set(wanted.map((w) => w.variantId))];
  const [variants, links] = await Promise.all([
    prisma.variant.findMany({ where: { shop, id: { in: ids } } }),
    prisma.supplierItem.findMany({ where: { shop, variantId: { in: ids } }, include: { supplier: true } }),
  ]);
  const vById = new Map(variants.map((v) => [v.id, v]));
  const linkOf = new Map(links.map((l) => [l.variantId, l]));
  const missing = ids.filter((id) => !vById.has(id));
  if (missing.length) throw new InputError("Some items were not found. Sync with Shopify and try again.", 404);
  const noSupplier = ids.filter((id) => !linkOf.has(id));
  if (noSupplier.length) {
    const names = noSupplier.slice(0, 5).map((id) => label(vById.get(id)!));
    throw new InputError(
      `Choose a supplier first for: ${names.join(", ")}${noSupplier.length > 5 ? ` and ${noSupplier.length - 5} more` : ""}.`,
    );
  }

  const bySupplier = new Map<string, SuggestionItem[]>();
  for (const w of wanted) {
    const sid = linkOf.get(w.variantId)!.supplierId;
    const list = bySupplier.get(sid) ?? [];
    if (!list.some((x) => x.variantId === w.variantId)) list.push(w);
    bySupplier.set(sid, list);
  }

  const created: { id: string; number: string; supplier: string; lines: number; merged: boolean }[] = [];
  await prisma.$transaction(
    async (tx) => {
      for (const [supplierId, list] of bySupplier) {
        const supplier = linkOf.get(list[0].variantId)!.supplier;
        const lead = Math.max(...list.map((w) => linkOf.get(w.variantId)!.leadTimeDays ?? supplier.leadTimeDays ?? ctx.settings.forecast.leadTimeDays));
        const draft = mergeDrafts
          ? await tx.purchaseOrder.findFirst({ where: { shop, supplierId, status: "draft" }, orderBy: { createdAt: "desc" }, include: { lines: true } })
          : null;
        const po =
          draft ??
          (await tx.purchaseOrder.create({
            data: {
              shop,
              number: await nextNumber(tx, shop),
              supplierId,
              status: "draft",
              locationId: ctx.defaultLocation,
              currency: supplier.currency || ctx.s.currency,
              expectedAt: new Date(`${addDays(ctx.today, lead)}T00:00:00Z`),
            },
            include: { lines: true },
          }));
        let pos = po.lines.length;
        for (const w of list) {
          const v = vById.get(w.variantId)!;
          const link = linkOf.get(w.variantId)!;
          const existing = po.lines.find((l) => l.variantId === w.variantId);
          if (existing) {
            await tx.purchaseOrderLine.update({ where: { id: existing.id }, data: { quantity: Math.max(w.quantity, existing.received) } });
          } else {
            await tx.purchaseOrderLine.create({
              data: {
                poId: po.id,
                variantId: v.id,
                sku: v.sku,
                title: label(v),
                supplierSku: link.supplierSku,
                quantity: w.quantity,
                unitCost: link.cost ?? v.unitCost ?? 0,
                position: pos++,
              },
            });
          }
        }
        created.push({ id: po.id, number: poNumber(ctx.settings.po.prefix, po.number), supplier: supplier.name, lines: list.length, merged: !!draft });
      }
      // A quantity the merchant set by hand was for this order: it is used up now
      await tx.variantPlan.updateMany({ where: { shop, variantId: { in: ids }, qtyOverride: { not: null } }, data: { qtyOverride: null } });
    },
    { timeout: 60_000 },
  );
  return created;
}

const label = (v: { productTitle: string; variantTitle: string }) => (v.variantTitle ? `${v.productTitle} - ${v.variantTitle}` : v.productTitle);

export async function createEmpty(shop: string, supplierId: unknown) {
  if (typeof supplierId !== "string") throw new InputError("Choose a supplier.");
  const supplier = await prisma.supplier.findFirst({ where: { shop, id: supplierId } });
  if (!supplier) throw new InputError("Supplier not found.", 404);
  const ctx = await shopContext(shop);
  if (!ctx.defaultLocation) throw new InputError("Shopify has no active location to receive stock at. Sync with Shopify first.");
  return prisma.$transaction(async (tx) =>
    tx.purchaseOrder.create({
      data: {
        shop,
        number: await nextNumber(tx, shop),
        supplierId,
        locationId: ctx.defaultLocation,
        currency: supplier.currency || ctx.s.currency,
        expectedAt: new Date(`${addDays(ctx.today, supplier.leadTimeDays ?? ctx.settings.forecast.leadTimeDays)}T00:00:00Z`),
      },
    }),
  );
}

// ---- Read ----

export async function listPos(shop: string, opts: { status?: string; supplierId?: string; take?: number } = {}) {
  const s = await prisma.shop.findUnique({ where: { shop }, select: { settings: true } });
  const prefix = withDefaults(s?.settings).po.prefix;
  const where: Prisma.PurchaseOrderWhereInput = { shop };
  if (opts.status === "open") where.status = { in: OPEN };
  else if (opts.status && opts.status !== "all") where.status = opts.status;
  if (opts.supplierId) where.supplierId = opts.supplierId;
  const pos = await prisma.purchaseOrder.findMany({
    where,
    orderBy: { number: "desc" },
    take: Math.min(opts.take ?? 200, 500),
    include: { supplier: { select: { name: true } }, lines: { select: { quantity: true, received: true, unitCost: true } } },
  });
  return pos.map((p) => ({
    id: p.id,
    number: poNumber(prefix, p.number),
    status: p.status,
    closedShort: p.status === "received" && p.lines.some((l) => l.received < l.quantity),
    supplierId: p.supplierId,
    supplier: p.supplier.name,
    currency: p.currency,
    lines: p.lines.length,
    units: p.lines.reduce((a, l) => a + l.quantity, 0),
    received: p.lines.reduce((a, l) => a + Math.min(l.received, l.quantity), 0),
    total: p.lines.reduce((a, l) => a + l.quantity * n(l.unitCost), 0) + n(p.shippingCost),
    expectedAt: p.expectedAt?.toISOString().slice(0, 10) ?? null,
    createdAt: p.createdAt.toISOString(),
    sentAt: p.sentAt?.toISOString() ?? null,
    receivedAt: p.receivedAt?.toISOString() ?? null,
  }));
}

export async function getPo(shop: string, id: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { shop, id },
    include: { supplier: true, lines: { orderBy: { position: "asc" } }, receipts: { orderBy: { createdAt: "desc" } } },
  });
  if (!po) return null;
  const s = await prisma.shop.findUnique({ where: { shop } });
  const settings = withDefaults(s?.settings);
  const variants = await prisma.variant.findMany({ where: { shop, id: { in: po.lines.map((l) => l.variantId) } } });
  const vById = new Map(variants.map((v) => [v.id, v]));
  const levels = await prisma.inventoryLevel.findMany({
    where: { shop, locationId: po.locationId, inventoryItemId: { in: variants.map((v) => v.inventoryItemId) } },
  });
  const stockOf = new Map(levels.map((l) => [l.inventoryItemId, l.available]));
  const location = await prisma.location.findUnique({ where: { shop_id: { shop, id: po.locationId } } });
  return {
    id: po.id,
    number: poNumber(settings.po.prefix, po.number),
    status: po.status,
    supplier: { ...po.supplier, minOrderValue: po.supplier.minOrderValue == null ? null : Number(po.supplier.minOrderValue) },
    locationId: po.locationId,
    locationName: location?.name ?? "(location removed)",
    currency: po.currency,
    shopCurrency: s?.currency ?? po.currency,
    expectedAt: po.expectedAt?.toISOString().slice(0, 10) ?? null,
    shippingCost: n(po.shippingCost),
    notes: po.notes,
    createdAt: po.createdAt.toISOString(),
    sentAt: po.sentAt?.toISOString() ?? null,
    receivedAt: po.receivedAt?.toISOString() ?? null,
    cancelledAt: po.cancelledAt?.toISOString() ?? null,
    lines: po.lines.map((l) => {
      const v = vById.get(l.variantId);
      return {
        id: l.id,
        variantId: l.variantId,
        sku: l.sku,
        title: l.title,
        supplierSku: l.supplierSku,
        quantity: l.quantity,
        received: l.received,
        unitCost: n(l.unitCost),
        imageUrl: v?.imageUrl ?? null,
        deleted: !v || !!v.deletedAt,
        inStock: v ? (stockOf.get(v.inventoryItemId) ?? 0) : null,
      };
    }),
    receipts: po.receipts.map((r) => ({
      id: r.id,
      status: r.status,
      error: r.error,
      undoOf: r.undoOf,
      createdAt: r.createdAt.toISOString(),
      units: (r.lines as unknown as ReceiptLine[]).reduce((a, l) => a + l.quantity, 0),
      lines: r.lines as unknown as ReceiptLine[],
    })),
  };
}

export type PoDetail = NonNullable<Awaited<ReturnType<typeof getPo>>>;

// ---- Edit ----

export async function savePo(shop: string, id: string, raw: unknown) {
  const r = obj(raw);
  const po = await prisma.purchaseOrder.findFirst({ where: { shop, id }, include: { lines: true } });
  if (!po) throw new InputError("Purchase order not found.", 404);
  if (!OPEN.includes(po.status)) throw new InputError("This purchase order is closed and cannot be changed.", 409);

  const data: Prisma.PurchaseOrderUpdateInput = {};
  if ("supplierId" in r && r.supplierId !== po.supplierId) {
    if (po.status !== "draft") throw new InputError("The supplier can only be changed on a draft.", 409);
    const s = await prisma.supplier.findFirst({ where: { shop, id: String(r.supplierId) } });
    if (!s) throw new InputError("Supplier not found.", 404);
    data.supplier = { connect: { id: s.id } };
  }
  if ("locationId" in r && r.locationId !== po.locationId) {
    if (po.lines.some((l) => l.received > 0)) throw new InputError("Stock was already received at this location; the location cannot change now.", 409);
    const loc = await prisma.location.findFirst({ where: { shop, id: String(r.locationId), isActive: true } });
    if (!loc) throw new InputError("Choose an active location.");
    data.locationId = loc.id;
  }
  if ("expectedAt" in r) {
    const d = String(r.expectedAt ?? "");
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new InputError("Expected date must be a date.");
    data.expectedAt = d ? new Date(`${d}T00:00:00Z`) : null;
  }
  if ("shippingCost" in r) data.shippingCost = costOf(r.shippingCost);
  if ("notes" in r) data.notes = String(r.notes ?? "").slice(0, 2000);
  if ("currency" in r) {
    const c = String(r.currency ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new InputError("Currency must be a 3-letter code.");
    data.currency = c;
  }

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  if (Array.isArray(r.lines)) {
    const lines = (r.lines as unknown[]).map((x, i) => {
      const o = obj(x);
      return {
        id: typeof o.id === "string" ? o.id : null,
        variantId: typeof o.variantId === "string" ? o.variantId : "",
        quantity: qtyOf(o.quantity),
        unitCost: costOf(o.unitCost),
        supplierSku: String(o.supplierSku ?? "").slice(0, 100),
        position: i,
      };
    });
    if (lines.length > MAX_LINES) throw new InputError(`A purchase order can have at most ${MAX_LINES} lines.`);
    const keep = new Set(lines.filter((l) => l.id).map((l) => l.id));
    for (const old of po.lines) {
      if (!keep.has(old.id) && old.received > 0) throw new InputError(`"${old.title}" was already partly received and cannot be removed.`, 409);
    }
    for (const l of lines) {
      if (!l.id) continue;
      const old = po.lines.find((x) => x.id === l.id);
      if (!old) throw new InputError("A line was not found. Reload the page.", 409);
      if (l.quantity < old.received) throw new InputError(`"${old.title}": ${old.received} already received, so the quantity cannot be lower.`);
    }
    const newIds = lines.filter((l) => !l.id).map((l) => l.variantId);
    const dupes = lines.map((l) => l.variantId).filter((v, i, a) => a.indexOf(v) !== i);
    if (dupes.length) throw new InputError("The same item is on the order twice. Combine the lines.");
    const variants = newIds.length ? await prisma.variant.findMany({ where: { shop, id: { in: newIds } } }) : [];
    if (variants.length !== new Set(newIds).size) throw new InputError("Some items were not found. Sync with Shopify and try again.", 404);
    const links = newIds.length ? await prisma.supplierItem.findMany({ where: { shop, variantId: { in: newIds } } }) : [];
    ops.push(prisma.purchaseOrderLine.deleteMany({ where: { poId: id, id: { notIn: [...keep] as string[] } } }));
    for (const l of lines) {
      if (l.id) {
        ops.push(
          prisma.purchaseOrderLine.update({
            where: { id: l.id },
            data: { quantity: l.quantity, unitCost: l.unitCost, supplierSku: l.supplierSku, position: l.position },
          }),
        );
      } else {
        const v = variants.find((x) => x.id === l.variantId)!;
        const link = links.find((x) => x.variantId === l.variantId);
        ops.push(
          prisma.purchaseOrderLine.create({
            data: {
              poId: id,
              variantId: v.id,
              sku: v.sku,
              title: label(v),
              supplierSku: l.supplierSku || link?.supplierSku || "",
              quantity: l.quantity,
              unitCost: l.unitCost || n(link?.cost) || n(v.unitCost),
              position: l.position,
            },
          }),
        );
      }
    }
  }
  ops.push(prisma.purchaseOrder.update({ where: { id }, data }));
  await prisma.$transaction(ops);
  await settleStatus(id);
}

// After lines change: all received -> received; some -> partial
async function settleStatus(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
  if (!po || !["sent", "partial", "received"].includes(po.status)) return;
  const any = po.lines.some((l) => l.received > 0);
  const all = po.lines.length > 0 && po.lines.every((l) => l.received >= l.quantity);
  const status = all ? "received" : any ? "partial" : "sent";
  if (status !== po.status) {
    await prisma.purchaseOrder.update({ where: { id }, data: { status, receivedAt: all ? new Date() : null } });
  }
}

export async function setStatus(shop: string, id: string, action: "mark-sent" | "back-to-draft" | "cancel" | "close" | "reopen") {
  const po = await prisma.purchaseOrder.findFirst({ where: { shop, id }, include: { lines: true } });
  if (!po) throw new InputError("Purchase order not found.", 404);
  const received = po.lines.some((l) => l.received > 0);
  const now = new Date();
  switch (action) {
    case "mark-sent":
      if (po.status !== "draft") throw new InputError("Only a draft can be marked as sent.", 409);
      if (!po.lines.length) throw new InputError("Add at least one item first.");
      await prisma.purchaseOrder.update({ where: { id }, data: { status: "sent", sentAt: now } });
      break;
    case "back-to-draft":
      if (po.status !== "sent" || received) throw new InputError("Only a sent order with nothing received can go back to draft.", 409);
      await prisma.purchaseOrder.update({ where: { id }, data: { status: "draft", sentAt: null } });
      break;
    case "cancel":
      if (!["draft", "sent"].includes(po.status) || received) {
        throw new InputError("An order with stock already received cannot be cancelled. Close it instead.", 409);
      }
      await prisma.purchaseOrder.update({ where: { id }, data: { status: "cancelled", cancelledAt: now } });
      break;
    case "close":
      // The rest is not coming: stop counting it as on order
      if (po.status !== "partial") throw new InputError("Only a partly received order can be closed.", 409);
      await prisma.purchaseOrder.update({ where: { id }, data: { status: "received", receivedAt: now } });
      break;
    case "reopen":
      if (po.status === "cancelled") {
        await prisma.purchaseOrder.update({ where: { id }, data: { status: po.sentAt ? "sent" : "draft", cancelledAt: null } });
      } else if (po.status === "received" && po.lines.some((l) => l.received < l.quantity)) {
        await prisma.purchaseOrder.update({ where: { id }, data: { status: "partial", receivedAt: null } });
      } else {
        throw new InputError("This order cannot be reopened.", 409);
      }
      break;
  }
}

export async function deletePo(shop: string, id: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { shop, id }, include: { lines: true } });
  if (!po) throw new InputError("Purchase order not found.", 404);
  if (!["draft", "cancelled"].includes(po.status) || po.lines.some((l) => l.received > 0)) {
    throw new InputError("Only drafts and cancelled orders can be deleted.", 409);
  }
  await prisma.purchaseOrder.delete({ where: { id } });
}

export async function markSentByEmail(id: string) {
  await prisma.purchaseOrder.updateMany({ where: { id, status: "draft" }, data: { status: "sent", sentAt: new Date() } });
  await prisma.purchaseOrder.updateMany({ where: { id, sentAt: null }, data: { sentAt: new Date() } });
}

// ---- Receive ----

export interface ReceiptLine {
  lineId: string;
  variantId: string;
  inventoryItemId: string;
  title: string;
  quantity: number; // negative when undoing
}

const PENDING_MS = 5 * 60 * 1000;

// Records the stock that arrived. Does not call Shopify: applyReceipt does.
export async function createReceipt(shop: string, poId: string, raw: unknown) {
  const r = obj(raw);
  const asked = (Array.isArray(r.lines) ? (r.lines as unknown[]) : []).map((x) => {
    const o = obj(x);
    return { lineId: String(o.lineId ?? ""), quantity: qtyOf(o.quantity, "Received quantity") };
  });
  const wanted = asked.filter((a) => a.quantity > 0);
  if (!wanted.length) throw new InputError("Enter how many of each item arrived.");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "PurchaseOrder" WHERE "id" = ${poId} AND "shop" = ${shop} FOR UPDATE`;
    const po = await tx.purchaseOrder.findFirst({ where: { shop, id: poId }, include: { lines: true } });
    if (!po) throw new InputError("Purchase order not found.", 404);
    if (!["sent", "partial", "draft"].includes(po.status)) throw new InputError("This order is closed. Reopen it to receive more.", 409);
    const busy = await tx.receipt.findFirst({ where: { poId, status: "pending", createdAt: { gt: new Date(Date.now() - PENDING_MS) } } });
    if (busy) throw new InputError("Stock for this order is being received right now. Wait a moment and reload.", 409);
    const location = await tx.location.findFirst({ where: { shop, id: po.locationId } });
    if (!location?.isActive) throw new InputError("The order's location is no longer active in Shopify. Choose another location first.", 409);
    const variants = await tx.variant.findMany({ where: { shop, id: { in: po.lines.map((l) => l.variantId) } } });
    const lines: ReceiptLine[] = wanted.map((w) => {
      const line = po.lines.find((l) => l.id === w.lineId);
      if (!line) throw new InputError("A line was not found. Reload the page.", 409);
      const v = variants.find((x) => x.id === line.variantId);
      if (!v || v.deletedAt || !v.inventoryItemId) throw new InputError(`"${line.title}" is no longer in Shopify, so its stock cannot be added.`, 409);
      return { lineId: line.id, variantId: v.id, inventoryItemId: v.inventoryItemId, title: line.title, quantity: w.quantity };
    });
    return tx.receipt.create({
      data: { shop, poId, lines: lines as unknown as Prisma.InputJsonValue, updateCost: r.updateCost === true },
    });
  });
}

// Every line received in full
export async function receiveAllLines(shop: string, poId: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { shop, id: poId }, include: { lines: true } });
  if (!po) throw new InputError("Purchase order not found.", 404);
  return po.lines.map((l) => ({ lineId: l.id, quantity: Math.max(0, l.quantity - l.received) }));
}

// Sends a pending (or failed) receipt to Shopify, then counts it on the order. Safe to call again.
export async function applyReceipt(shop: string, receiptId: string, shopify: Shopify) {
  const receipt = await prisma.receipt.findFirst({ where: { shop, id: receiptId }, include: { po: true } });
  if (!receipt) throw new InputError("Receipt not found.", 404);
  if (receipt.status === "done" || receipt.status === "undone") return { ...receipt, warnings: [] as string[] };
  const lines = receipt.lines as unknown as ReceiptLine[];
  const changes = lines.map((l) => ({ inventoryItemId: l.inventoryItemId, locationId: receipt.po.locationId, delta: l.quantity }));
  try {
    for (let i = 0; i < changes.length; i += STOCK_CHANGES_PER_CALL) {
      await shopify.adjustStock(changes.slice(i, i + STOCK_CHANGES_PER_CALL), {
        key: `${receipt.id}-${i / STOCK_CHANGES_PER_CALL}`,
        reason: receipt.undoOf ? "correction" : "received",
        reference: poReference(receipt.poId),
      });
    }
  } catch (e) {
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: "failed", error: (e as Error).message.slice(0, 1000) } });
    throw new InputError(`Shopify did not take the stock change: ${(e as Error).message} Nothing was counted; try again.`, 502);
  }

  const counted = await prisma.$transaction(async (tx) => {
    // Two clicks at once both reach here (Shopify applied the change once, thanks to the key): only the
    // first one counts it on the order
    const claim = await tx.receipt.updateMany({ where: { id: receipt.id, status: { in: ["pending", "failed"] } }, data: { status: "done", error: null } });
    if (!claim.count) return false;
    for (const l of lines) {
      await tx.purchaseOrderLine.updateMany({ where: { id: l.lineId, poId: receipt.poId }, data: { received: { increment: l.quantity } } });
      // Keep the app's copy of the stock in step until the next sync or stock webhook
      await tx.inventoryLevel.updateMany({
        where: { shop, inventoryItemId: l.inventoryItemId, locationId: receipt.po.locationId },
        data: { available: { increment: l.quantity }, onHand: { increment: l.quantity } },
      });
    }
    if (receipt.undoOf) await tx.receipt.update({ where: { id: receipt.undoOf }, data: { status: "undone" } });
    return true;
  });
  if (!counted) return { ...receipt, status: "done", warnings: [] as string[] };
  const po = await prisma.purchaseOrder.findUnique({ where: { id: receipt.poId } });
  if (po?.status === "draft") await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: "sent", sentAt: po.sentAt ?? new Date() } });
  await settleStatus(receipt.poId);

  // Cost per item in Shopify, only when the order is in the store's currency
  const warnings: string[] = [];
  if (receipt.updateCost && !receipt.undoOf) {
    const s = await prisma.shop.findUnique({ where: { shop }, select: { currency: true } });
    if (s?.currency !== receipt.po.currency) {
      warnings.push(`Cost per item not updated: the order is in ${receipt.po.currency}, the store in ${s?.currency}.`);
    } else {
      const poLines = await prisma.purchaseOrderLine.findMany({ where: { id: { in: lines.map((l) => l.lineId) } } });
      for (const l of lines) {
        const pl = poLines.find((x) => x.id === l.lineId);
        if (!pl || n(pl.unitCost) <= 0) continue;
        try {
          await shopify.setUnitCost(l.inventoryItemId, n(pl.unitCost));
          await prisma.variant.updateMany({ where: { shop, id: l.variantId }, data: { unitCost: pl.unitCost } });
        } catch (e) {
          warnings.push(`${l.title}: ${(e as Error).message}`);
        }
      }
    }
  }
  return { ...receipt, status: "done", warnings };
}

// Takes back the stock a receipt added (a typo, or the wrong order). Creates a reversing receipt.
export async function createUndo(shop: string, receiptId: string) {
  const r = await prisma.receipt.findFirst({ where: { shop, id: receiptId } });
  if (!r) throw new InputError("Receipt not found.", 404);
  if (r.status !== "done" || r.undoOf) throw new InputError("Only a completed receipt can be undone, once.", 409);
  const pending = await prisma.receipt.findFirst({ where: { undoOf: r.id, status: { in: ["pending", "failed"] } } });
  if (pending) return pending;
  const lines = (r.lines as unknown as ReceiptLine[]).map((l) => ({ ...l, quantity: -l.quantity }));
  return prisma.receipt.create({ data: { shop, poId: r.poId, lines: lines as unknown as Prisma.InputJsonValue, undoOf: r.id } });
}

// ---- Documents ----

export interface PoDocument {
  number: string;
  status: string;
  createdAt: string;
  expectedAt: string | null;
  currency: string;
  company: { name: string; address: string; email: string };
  supplier: { name: string; contactName: string; email: string; phone: string; address: string; notes: string };
  shipTo: string;
  lines: { sku: string; supplierSku: string; title: string; quantity: number; unitCost: number; total: number }[];
  subtotal: number;
  shippingCost: number;
  total: number;
  notes: string;
  footer: string;
}

export async function poDocument(shop: string, id: string): Promise<PoDocument | null> {
  const po = await getPo(shop, id);
  if (!po) return null;
  const s = await prisma.shop.findUnique({ where: { shop } });
  const settings = withDefaults(s?.settings);
  const lines = po.lines.map((l) => ({
    sku: l.sku,
    supplierSku: l.supplierSku,
    title: l.title,
    quantity: l.quantity,
    unitCost: l.unitCost,
    total: Math.round(l.quantity * l.unitCost * 100) / 100,
  }));
  const subtotal = lines.reduce((a, l) => a + l.total, 0);
  return {
    number: po.number,
    status: po.status,
    createdAt: po.createdAt.slice(0, 10),
    expectedAt: po.expectedAt,
    currency: po.currency,
    company: {
      name: settings.po.companyName || s?.name || shop,
      address: settings.po.companyAddress,
      email: settings.po.replyTo || s?.email || "",
    },
    supplier: {
      name: po.supplier.name,
      contactName: po.supplier.contactName,
      email: po.supplier.email,
      phone: po.supplier.phone,
      address: po.supplier.address,
      notes: po.supplier.notes,
    },
    shipTo: po.locationName,
    lines,
    subtotal,
    shippingCost: po.shippingCost,
    total: subtotal + po.shippingCost,
    notes: po.notes,
    footer: settings.po.footer,
  };
}

const csvCell = (v: unknown) => {
  const t = v == null ? "" : String(v);
  // A leading = + - @ would run as a formula in Excel
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(headers: string[], rows: unknown[][]): string {
  return String.fromCharCode(0xfeff) + [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function poCsv(d: PoDocument): string {
  return toCsv(
    ["PO number", "Supplier", "SKU", "Supplier SKU", "Item", "Quantity", `Unit cost (${d.currency})`, `Total (${d.currency})`],
    d.lines.map((l) => [d.number, d.supplier.name, l.sku, l.supplierSku, l.title, l.quantity, l.unitCost.toFixed(2), l.total.toFixed(2)]),
  );
}
