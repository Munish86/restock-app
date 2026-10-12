// Supplier import from a sheet (Excel, CSV, Google Sheet; Stocky and Shopify exports work too): which
// supplier each item comes from and the supplier's terms. "import-plan" shows what would change, "import"
// saves it. Blank cells never wipe what is already saved.
import prisma from "../db.server";
import { IMPORT_FIELDS, type ImportColumns, type ImportField } from "../lib/import-columns";
import { isEmail } from "../lib/settings";
import { getGoogle } from "./clients";
import { loadRows } from "./core/sheet";
import { sheetSourceFor } from "./files";
import type { JobContext, JobResult } from "./jobs/process";

export interface ImportOptions {
  source: "file" | "google";
  fileId?: string;
  url?: string;
  worksheet: string;
  headerRow: number;
  matchBy: "sku" | "barcode";
  columns: ImportColumns;
  defaultSupplierId?: string; // for rows without a supplier column / value
  createSuppliers: boolean;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export function parseImportOptions(raw: unknown): ImportOptions {
  const r = obj(raw);
  const source = r.source === "google" ? "google" : "file";
  const url = String(r.url ?? "").trim().slice(0, 500);
  if (source === "google" && !/^https:\/\/docs\.google\.com\/spreadsheets\/|^[\w-]{20,200}$/.test(url)) {
    throw new Error("Paste a Google Sheets link (https://docs.google.com/spreadsheets/...).");
  }
  const fileId = typeof r.fileId === "string" && /^[a-z0-9]{10,40}$/i.test(r.fileId) ? r.fileId : undefined;
  const headerRow = Number(r.headerRow ?? 0);
  if (!Number.isInteger(headerRow) || headerRow < 0 || headerRow > 50) throw new Error("Header row must be a number from 1 to 50 (or empty to find it).");
  const matchBy = r.matchBy === "barcode" ? "barcode" : "sku";
  const columns: ImportColumns = {};
  const c = obj(r.columns);
  for (const f of IMPORT_FIELDS) {
    const v = c[f.key];
    if (typeof v === "string" && v.trim()) columns[f.key] = v.slice(0, 200);
  }
  if (!columns[matchBy]) throw new Error(`Choose the column that holds the ${matchBy === "sku" ? "SKU" : "barcode"}.`);
  const defaultSupplierId = typeof r.defaultSupplierId === "string" && r.defaultSupplierId ? r.defaultSupplierId.slice(0, 40) : undefined;
  if (!columns.supplier && !defaultSupplierId) throw new Error("Choose the supplier column, or one supplier for every row.");
  return {
    source,
    ...(source === "file" ? { fileId } : { url }),
    worksheet: String(r.worksheet ?? "").slice(0, 200),
    headerRow,
    matchBy,
    columns,
    defaultSupplierId,
    createSuppliers: r.createSuppliers !== false,
  };
}

export interface ImportRow {
  row: number;
  key: string;
  item: string;
  supplier: string;
  action: string; // Will link | Linked | Will update | Updated | No change | Not found | Skipped | Error
  changes: string;
  warnings: string;
}

export interface ImportReport {
  rows: ImportRow[];
  newSuppliers: string[];
}

// "£1,249.00" -> 1249; "" -> null; "abc" -> undefined (not a number)
function money(v: string): number | null | undefined {
  if (!v.trim()) return null;
  const cleaned = v.replace(/[^\d.,-]/g, "");
  // "1.234,50" (European) -> "1234.50"; "1,234.50" -> "1234.50"
  const normal = /,\d{1,2}$/.test(cleaned) && cleaned.includes(".") ? cleaned.replace(/\./g, "").replace(",", ".") : /,\d{1,2}$/.test(cleaned) && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  const n = Number(normal);
  return normal === "" || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n * 10000) / 10000;
}
function whole(v: string, min: number, max: number): number | null | undefined {
  if (!v.trim()) return null;
  // "12", "12 pcs", "10 days" are fine; "abc" is not a number (and must not become 0)
  const m = v.trim().match(/^(-?\d+(?:\.0+)?)\s*[a-z.]*$/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

const label = (v: { productTitle: string; variantTitle: string }) => (v.variantTitle ? `${v.productTitle} - ${v.variantTitle}` : v.productTitle);

export async function runImport(ctx: JobContext, apply: boolean): Promise<JobResult> {
  const shop = ctx.job.shop;
  const o = parseImportOptions(ctx.job.options);
  ctx.progress({ done: 0, total: 3, step: "Reading the sheet" });
  ctx.log("Reading the sheet");
  const src = await sheetSourceFor(shop, { source: o.source, fileId: o.fileId, url: o.url });
  const { headers, rows } = await loadRows(src, { worksheet: o.worksheet, header_row: o.headerRow || "" }, getGoogle());
  const missing = Object.entries(o.columns).filter(([, col]) => col && !headers.includes(col));
  if (missing.length) throw new Error(`The sheet has no column called ${missing.map(([, c]) => `"${c}"`).join(", ")}. Check the column choices.`);
  ctx.log(`${rows.length} rows`);

  ctx.progress({ done: 1, total: 3, step: "Matching items" });
  const variants = await prisma.variant.findMany({
    where: { shop, deletedAt: null },
    select: { id: true, sku: true, barcode: true, productTitle: true, variantTitle: true },
  });
  const byKey = new Map<string, typeof variants>();
  for (const v of variants) {
    const k = (o.matchBy === "sku" ? v.sku : v.barcode).trim().toLowerCase();
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), v]);
  }
  const suppliers = await prisma.supplier.findMany({ where: { shop } });
  const supplierByName = new Map(suppliers.map((s) => [s.name.trim().toLowerCase(), s]));
  const fallback = o.defaultSupplierId ? suppliers.find((s) => s.id === o.defaultSupplierId) : undefined;
  if (o.defaultSupplierId && !fallback) throw new Error("The supplier chosen for every row no longer exists.");
  const existing = new Map((await prisma.supplierItem.findMany({ where: { shop } })).map((i) => [i.variantId, i]));

  const col = (row: Record<string, unknown>, f: ImportField) => (o.columns[f] ? String(row[o.columns[f]!] ?? "").trim() : "");
  const report: ImportRow[] = [];
  const newSuppliers = new Map<string, { name: string; email: string; leadTimeDays: number | null }>();
  const writes = new Map<string, { variantId: string; supplierName: string; data: Record<string, unknown>; row: number }>();

  for (const row of rows) {
    if (ctx.shouldStop()) return { stopped: true };
    const key = col(row, o.matchBy);
    const base = { row: row.__row, key, item: "", supplier: "", changes: "", warnings: "" };
    if (!key) {
      report.push({ ...base, action: "Skipped", warnings: `No ${o.matchBy === "sku" ? "SKU" : "barcode"} in this row.` });
      continue;
    }
    const found = byKey.get(key.toLowerCase()) ?? [];
    if (!found.length) {
      report.push({ ...base, action: "Not found", warnings: `No item in Shopify has ${o.matchBy === "sku" ? "SKU" : "barcode"} "${key}".` });
      continue;
    }
    const supplierName = col(row, "supplier") || fallback?.name || "";
    if (!supplierName) {
      report.push({ ...base, item: found.map(label).join("; "), action: "Skipped", warnings: "No supplier in this row." });
      continue;
    }
    const warnings: string[] = [];
    if (found.length > 1) warnings.push(`${found.length} items share this ${o.matchBy === "sku" ? "SKU" : "barcode"}; all are updated.`);
    const supplier = supplierByName.get(supplierName.toLowerCase());
    const email = col(row, "supplierEmail");
    if (!supplier) {
      if (!o.createSuppliers) {
        report.push({ ...base, item: found.map(label).join("; "), supplier: supplierName, action: "Error", warnings: `No supplier called "${supplierName}". Create it first, or allow new suppliers.` });
        continue;
      }
      const ns = newSuppliers.get(supplierName.toLowerCase()) ?? { name: supplierName.slice(0, 120), email: "", leadTimeDays: null };
      if (email && isEmail(email) && !ns.email) ns.email = email;
      newSuppliers.set(supplierName.toLowerCase(), ns);
    } else if (email && !isEmail(email)) warnings.push(`"${email}" is not an email address.`);

    const data: Record<string, unknown> = {};
    const num = <T,>(f: ImportField, parse: (v: string) => T | null | undefined, what: string) => {
      const raw = col(row, f);
      const v = parse(raw);
      if (v === undefined) warnings.push(`${what} "${raw}" is not valid and was left out.`);
      else if (v !== null) data[f] = v;
    };
    if (col(row, "supplierSku")) data.supplierSku = col(row, "supplierSku").slice(0, 100);
    num("cost", money, "Cost");
    num("casePack", (v) => whole(v, 1, 100_000), "Case pack");
    num("minOrderQty", (v) => whole(v, 1, 1_000_000), "Minimum order");
    num("leadTimeDays", (v) => whole(v, 0, 365), "Lead time");

    for (const v of found) {
      const before = existing.get(v.id);
      const beforeSupplier = before ? suppliers.find((s) => s.id === before.supplierId)?.name : undefined;
      const changes: string[] = [];
      if (beforeSupplier?.toLowerCase() !== supplierName.toLowerCase()) changes.push(beforeSupplier ? `supplier ${beforeSupplier} → ${supplierName}` : `supplier ${supplierName}`);
      const fieldNames: Record<string, string> = { supplierSku: "supplier SKU", cost: "cost", casePack: "case pack", minOrderQty: "minimum order", leadTimeDays: "lead time" };
      for (const [k, val] of Object.entries(data)) {
        const old = before ? (before as unknown as Record<string, unknown>)[k] : null;
        if (old == null || String(Number(old) || old) !== String(val)) changes.push(`${fieldNames[k]} ${val}`);
      }
      if (writes.has(v.id)) warnings.push(`Also in row ${writes.get(v.id)!.row}; this row wins.`);
      writes.set(v.id, { variantId: v.id, supplierName, data, row: row.__row });
      report.push({
        ...base,
        item: label(v),
        supplier: supplierName,
        action: changes.length ? (before ? (apply ? "Updated" : "Will update") : apply ? "Linked" : "Will link") : "No change",
        changes: changes.join(", "),
        warnings: warnings.join(" "),
      });
    }
  }

  ctx.progress({ done: 2, total: 3, step: apply ? "Saving" : "Done" });
  if (apply) {
    for (const ns of newSuppliers.values()) {
      const s = await prisma.supplier.upsert({
        where: { shop_name: { shop, name: ns.name } },
        create: { shop, name: ns.name, email: ns.email },
        update: {},
      });
      supplierByName.set(ns.name.toLowerCase(), s);
    }
    // Existing suppliers without an email get the one from the sheet
    for (const row of rows) {
      const name = col(row, "supplier").toLowerCase();
      const email = col(row, "supplierEmail");
      const s = supplierByName.get(name);
      if (s && !s.email && email && isEmail(email)) {
        await prisma.supplier.update({ where: { id: s.id }, data: { email } });
        s.email = email;
      }
    }
    const list = [...writes.values()];
    for (let i = 0; i < list.length; i += 500) {
      if (ctx.shouldStop()) return { stopped: true, report: { rows: report, newSuppliers: [...newSuppliers.values()].map((s) => s.name) } };
      await prisma.$transaction(
        list.slice(i, i + 500).map((w) => {
          const supplierId = supplierByName.get(w.supplierName.toLowerCase())!.id;
          return prisma.supplierItem.upsert({
            where: { shop_variantId: { shop, variantId: w.variantId } },
            create: { shop, variantId: w.variantId, supplierId, ...w.data },
            update: { supplierId, ...w.data },
          });
        }),
      );
      ctx.progress({ done: 2, total: 3, step: `Saving (${Math.min(i + 500, list.length)} of ${list.length})` });
    }
    ctx.log(`Saved ${list.length} items, ${newSuppliers.size} new suppliers.`);
  }
  ctx.progress({ done: 3, total: 3, step: "Done" });

  const counts: Record<string, number> = {};
  for (const r of report) counts[r.action] = (counts[r.action] ?? 0) + 1;
  if (newSuppliers.size) counts[apply ? "New suppliers" : "New suppliers to create"] = newSuppliers.size;
  return { counts, report: { rows: report, newSuppliers: [...newSuppliers.values()].map((s) => s.name) } satisfies ImportReport };
}

export const IMPORT_REPORT_HEADERS = ["row", "key", "item", "supplier", "action", "changes", "warnings"] as const;
