// Supplier sheet import: the fields a sheet can fill, and how column names are recognised automatically.
// Column names from Stocky exports, Shopify product exports and common supplier price lists are covered, so
// most sheets need no mapping by hand. Shared by the server (import) and the browser (mapping form).

export const IMPORT_FIELDS = [
  { key: "sku", label: "SKU", hint: "Finds the item in Shopify (or Barcode, below)", patterns: [/^(variant )?sku$/, /^sku code$/, /^item sku$/, /^product sku$/, /^our sku$/] },
  { key: "barcode", label: "Barcode", hint: "Finds the item by barcode (UPC, EAN, ISBN)", patterns: [/^(variant )?barcode$/, /^upc$/, /^ean$/, /^gtin$/, /^isbn$/] },
  { key: "supplier", label: "Supplier", hint: "Supplier name; new suppliers are created", patterns: [/^supplier( name)?$/, /^vendor( name)?$/, /^manufacturer$/, /^supplied by$/] },
  { key: "supplierSku", label: "Supplier SKU", hint: "The supplier's own code for the item", patterns: [/^supplier (sku|code|item code|part( number)?|ref(erence)?)$/, /^vendor (sku|code)$/, /^mpn$/, /^manufacturer (part number|code)$/] },
  { key: "cost", label: "Cost", hint: "The supplier's price per unit", patterns: [/^(unit |supplier |purchase |buy(ing)? )?(cost|price)( price)?( per (unit|item))?$/, /^cost per item$/, /^default cost$/, /^wholesale( price)?$/] },
  { key: "casePack", label: "Case pack", hint: "Sold in packs of this many", patterns: [/^case (pack|qty|quantity|size)$/, /^pack (size|qty|quantity)$/, /^units per (case|pack|box|carton)$/, /^inner( pack)?$/, /^carton qty$/] },
  { key: "minOrderQty", label: "Minimum order", hint: "Smallest order in units", patterns: [/^(min(imum)?|moq)( order)?( qty| quantity)?$/, /^moq$/] },
  { key: "leadTimeDays", label: "Lead time (days)", hint: "Days from ordering to arrival", patterns: [/^lead ?time( \(?days?\)?)?$/, /^delivery (time|days)$/, /^days to deliver$/] },
  { key: "supplierEmail", label: "Supplier email", hint: "Saved on new suppliers, or ones without an email", patterns: [/^supplier e ?mail$/, /^(vendor )?e ?mail$/, /^order e ?mail$/] },
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number]["key"];
export type ImportColumns = Partial<Record<ImportField, string>>;

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_\-.:#/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Picks a column for every field whose pattern matches a header. A header is used for one field only.
export function autoMapColumns(headers: string[]): ImportColumns {
  const out: ImportColumns = {};
  const used = new Set<string>();
  for (const f of IMPORT_FIELDS) {
    const h = headers.find((x) => x && !used.has(x) && f.patterns.some((p) => p.test(clean(x))));
    if (h) {
      out[f.key] = h;
      used.add(h);
    }
  }
  return out;
}
