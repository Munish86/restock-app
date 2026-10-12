// Suppliers, which variant comes from which supplier, the merchant's per-variant choices, and bundles set up by hand.
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { isEmail, parseEmails } from "../lib/settings";

export class InputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

// "" / null -> null; otherwise a whole number in range, or an error naming the field
function optInt(v: unknown, label: string, min: number, max: number): number | null {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}
function optMoney(v: unknown, label: string): number | null {
  if (v === "" || v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new InputError(`${label} must be an amount of 0 or more.`);
  return Math.round(n * 10000) / 10000;
}

export interface SupplierInput {
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
}

export function parseSupplier(raw: unknown): SupplierInput {
  const r = obj(raw);
  const name = text(r.name, 120);
  if (!name) throw new InputError("Give the supplier a name.");
  const email = text(r.email, 200);
  if (email && !isEmail(email)) throw new InputError("The supplier's email address is not valid.");
  const cc = parseEmails(text(r.ccEmails, 1000));
  if (cc.bad.length) throw new InputError(`Not an email address: ${cc.bad.slice(0, 3).join(", ")}.`);
  const currency = text(r.currency, 3).toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new InputError("Currency must be a 3-letter code such as USD, EUR or INR.");
  return {
    name,
    email,
    ccEmails: cc.list.slice(0, 10).join(", "),
    contactName: text(r.contactName, 120),
    phone: text(r.phone, 60),
    address: text(r.address, 1000),
    currency,
    leadTimeDays: optInt(r.leadTimeDays, "Lead time", 0, 365),
    minOrderValue: optMoney(r.minOrderValue, "Minimum order value"),
    notes: text(r.notes, 2000),
  };
}

const uniqueName = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
    ? new InputError("A supplier with this name already exists.", 409)
    : e;

export async function listSuppliers(shop: string) {
  const [suppliers, items, open] = await Promise.all([
    prisma.supplier.findMany({ where: { shop }, orderBy: { name: "asc" } }),
    prisma.supplierItem.groupBy({ by: ["supplierId"], where: { shop }, _count: true }),
    prisma.purchaseOrder.groupBy({ by: ["supplierId"], where: { shop, status: { in: ["draft", "sent", "partial"] } }, _count: true }),
  ]);
  const itemCount = new Map(items.map((i) => [i.supplierId, i._count]));
  const openCount = new Map(open.map((o) => [o.supplierId, o._count]));
  return suppliers.map((s) => ({
    ...s,
    minOrderValue: s.minOrderValue == null ? null : Number(s.minOrderValue),
    items: itemCount.get(s.id) ?? 0,
    openOrders: openCount.get(s.id) ?? 0,
  }));
}

// "Acme" and "ACME " are the same supplier
async function checkNameFree(shop: string, name: string, exceptId?: string) {
  const same = await prisma.supplier.findFirst({
    where: { shop, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (same) throw new InputError("A supplier with this name already exists.", 409);
}

export async function createSupplier(shop: string, raw: unknown) {
  const data = parseSupplier(raw);
  await checkNameFree(shop, data.name);
  try {
    return await prisma.supplier.create({ data: { shop, ...data } });
  } catch (e) {
    throw uniqueName(e);
  }
}

export async function updateSupplier(shop: string, id: string, raw: unknown) {
  const data = parseSupplier(raw);
  await checkNameFree(shop, data.name, id);
  try {
    const r = await prisma.supplier.updateMany({ where: { shop, id }, data });
    if (!r.count) throw new InputError("Supplier not found.", 404);
  } catch (e) {
    throw uniqueName(e);
  }
}

export async function deleteSupplier(shop: string, id: string) {
  const orders = await prisma.purchaseOrder.count({ where: { shop, supplierId: id } });
  if (orders) {
    throw new InputError(
      `This supplier has ${orders} purchase order${orders === 1 ? "" : "s"}. Delete or keep them; a supplier with orders cannot be deleted.`,
      409,
    );
  }
  const r = await prisma.supplier.deleteMany({ where: { shop, id } });
  if (!r.count) throw new InputError("Supplier not found.", 404);
}

async function checkVariants(shop: string, variantIds: unknown): Promise<string[]> {
  if (!Array.isArray(variantIds) || !variantIds.length) throw new InputError("Choose at least one item.");
  if (variantIds.length > 10_000) throw new InputError("Too many items at once.");
  const ids = [...new Set(variantIds.filter((x): x is string => typeof x === "string"))];
  const found = await prisma.variant.count({ where: { shop, id: { in: ids } } });
  if (found !== ids.length) throw new InputError("Some items were not found. Sync with Shopify and try again.", 404);
  return ids;
}

// Links variants to a supplier (null = remove the link). Existing terms (supplier SKU, cost...) are kept
// when the supplier changes, because they usually describe the product rather than the supplier.
export async function assignSupplier(shop: string, variantIds: unknown, supplierId: string | null) {
  const ids = await checkVariants(shop, variantIds);
  if (supplierId === null) {
    await prisma.supplierItem.deleteMany({ where: { shop, variantId: { in: ids } } });
    return ids.length;
  }
  const s = await prisma.supplier.findFirst({ where: { shop, id: supplierId }, select: { id: true } });
  if (!s) throw new InputError("Supplier not found.", 404);
  await prisma.$transaction([
    prisma.supplierItem.updateMany({ where: { shop, variantId: { in: ids } }, data: { supplierId } }),
    prisma.supplierItem.createMany({ data: ids.map((variantId) => ({ shop, variantId, supplierId })), skipDuplicates: true }),
  ]);
  return ids.length;
}

// One supplier per product vendor, for every variant that has no supplier yet. The quickest way to set up
// a store whose vendors are its suppliers.
export async function suppliersFromVendors(shop: string) {
  const variants = await prisma.variant.findMany({
    where: { shop, deletedAt: null, vendor: { not: "" } },
    select: { id: true, vendor: true },
  });
  const linked = new Set((await prisma.supplierItem.findMany({ where: { shop }, select: { variantId: true } })).map((i) => i.variantId));
  const byVendor = new Map<string, string[]>();
  for (const v of variants) {
    if (linked.has(v.id)) continue;
    const list = byVendor.get(v.vendor.trim()) ?? [];
    list.push(v.id);
    byVendor.set(v.vendor.trim(), list);
  }
  let created = 0;
  let assigned = 0;
  for (const [vendor, ids] of byVendor) {
    const name = vendor.slice(0, 120);
    let s = await prisma.supplier.findFirst({ where: { shop, name: { equals: name, mode: "insensitive" } } });
    if (!s) {
      s = await prisma.supplier.create({ data: { shop, name } });
      created++;
    }
    const r = await prisma.supplierItem.createMany({ data: ids.map((variantId) => ({ shop, variantId, supplierId: s!.id })), skipDuplicates: true });
    assigned += r.count;
  }
  return { created, assigned };
}

// Supplier terms for one variant
export async function updateItem(shop: string, variantId: string, raw: unknown) {
  const r = obj(raw);
  const item = await prisma.supplierItem.findUnique({ where: { shop_variantId: { shop, variantId } } });
  if (!item) throw new InputError("Choose a supplier for this item first.");
  await prisma.supplierItem.update({
    where: { shop_variantId: { shop, variantId } },
    data: {
      supplierSku: text(r.supplierSku, 100),
      cost: optMoney(r.cost, "Cost"),
      casePack: optInt(r.casePack, "Case pack", 1, 100_000),
      minOrderQty: optInt(r.minOrderQty, "Minimum order", 1, 1_000_000),
      leadTimeDays: optInt(r.leadTimeDays, "Lead time", 0, 365),
    },
  });
}

// The merchant's own choices for one or more variants. Only the fields sent are changed.
export async function updatePlans(shop: string, variantIds: unknown, raw: unknown) {
  const ids = await checkVariants(shop, variantIds);
  const r = obj(raw);
  const data: Prisma.VariantPlanUpdateInput = {};
  if ("ignore" in r) data.ignore = r.ignore === true;
  if ("daysToCover" in r) data.daysToCover = optInt(r.daysToCover, "Days to cover", 1, 365);
  if ("safetyDays" in r) data.safetyDays = optInt(r.safetyDays, "Safety stock days", 0, 120);
  if ("rateOverride" in r) {
    const v = r.rateOverride;
    if (v === "" || v == null) data.rateOverride = null;
    else {
      const x = Number(v);
      if (!Number.isFinite(x) || x < 0 || x > 1_000_000) throw new InputError("Sales per day must be 0 or more.");
      data.rateOverride = Math.round(x * 10000) / 10000;
    }
  }
  if ("qtyOverride" in r) data.qtyOverride = optInt(r.qtyOverride, "Quantity to order", 0, 10_000_000);
  if ("note" in r) data.note = text(r.note, 500);
  if (!Object.keys(data).length) throw new InputError("Nothing to change.");
  await prisma.$transaction(
    ids.map((variantId) =>
      prisma.variantPlan.upsert({
        where: { shop_variantId: { shop, variantId } },
        create: { ...(data as Omit<Prisma.VariantPlanUncheckedCreateInput, "shop" | "variantId">), shop, variantId },
        update: data,
      }),
    ),
  );
  return ids.length;
}

// A bundle set up by hand (for bundle apps that do not use Shopify's bundle components).
// parts = [] removes it. Shopify's own bundle definitions are read on every sync and cannot be changed here.
export async function setBundle(shop: string, bundleVariantId: string, partsRaw: unknown) {
  const [bundle] = await checkVariants(shop, [bundleVariantId]);
  const parts = (Array.isArray(partsRaw) ? partsRaw : []).map((p) => {
    const o = obj(p);
    const quantity = optInt(o.quantity, "Quantity", 1, 1000) ?? 1;
    if (typeof o.variantId !== "string") throw new InputError("Choose the items in the bundle.");
    if (o.variantId === bundle) throw new InputError("A bundle cannot contain itself.");
    return { variantId: o.variantId, quantity };
  });
  if (parts.length > 50) throw new InputError("A bundle can have at most 50 parts.");
  if (parts.length) await checkVariants(shop, parts.map((p) => p.variantId));
  const shopifyParts = await prisma.bundleComponent.count({ where: { shop, bundleVariantId: bundle, source: "shopify" } });
  if (shopifyParts) throw new InputError("This bundle is set up in Shopify. Change it there; the app reads it on every sync.", 409);
  const nested = parts.length
    ? await prisma.bundleComponent.count({ where: { shop, bundleVariantId: { in: parts.map((p) => p.variantId) } } })
    : 0;
  if (nested) throw new InputError("A bundle cannot contain another bundle.");
  await prisma.$transaction([
    prisma.bundleComponent.deleteMany({ where: { shop, bundleVariantId: bundle, source: "manual" } }),
    prisma.bundleComponent.createMany({
      data: parts.map((p) => ({ shop, bundleVariantId: bundle, componentVariantId: p.variantId, quantity: p.quantity, source: "manual" })),
    }),
    prisma.variant.update({ where: { shop_id: { shop, id: bundle } }, data: { isBundle: parts.length > 0 } }),
  ]);
}

// Variant search for adding items to a purchase order or a bundle
export async function searchVariants(shop: string, q: string, take = 20) {
  const term = q.trim().slice(0, 100);
  const where: Prisma.VariantWhereInput = { shop, deletedAt: null };
  if (term) {
    where.OR = [
      { productTitle: { contains: term, mode: "insensitive" } },
      { variantTitle: { contains: term, mode: "insensitive" } },
      { sku: { contains: term, mode: "insensitive" } },
      { barcode: { equals: term } },
    ];
  }
  const rows = await prisma.variant.findMany({
    where,
    take,
    orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }],
    select: { id: true, productTitle: true, variantTitle: true, sku: true, imageUrl: true, unitCost: true, isBundle: true },
  });
  return rows.map((r) => ({ ...r, unitCost: r.unitCost == null ? null : Number(r.unitCost) }));
}
