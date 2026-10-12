// A small PDF writer for purchase orders: text in Helvetica, lines and shaded boxes, several pages.
// No library: purchase orders are simple tables, and this keeps the app light. The standard PDF fonts only
// cover Western European characters; others print as "?" (the printable HTML version shows everything).
import type { PoDocument } from "./purchase-orders";

// Character widths of Helvetica and Helvetica-Bold (1/1000 em) for codes 32-126, from Adobe's font metrics
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278,
  278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333,
  333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611,
  611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Characters outside Latin-1 that WinAnsiEncoding still has
const WIN_ANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

// Text -> WinAnsi byte codes. "₹" becomes "Rs."; anything else not printable becomes "?".
export function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of String(text).normalize("NFC")) {
    if (ch === "₹") {
      out.push(0x52, 0x73, 0x2e);
      continue;
    }
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13) out.push(32);
    else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out.push(c);
    else if (WIN_ANSI[ch]) out.push(WIN_ANSI[ch]);
    else out.push(0x3f);
  }
  return out;
}

export function textWidth(text: string, size: number, bold = false): number {
  const w = bold ? W_BOLD : W_REG;
  return (encode(text).reduce((s, c) => s + (c >= 32 && c <= 126 ? w[c - 32] : 556), 0) * size) / 1000;
}

const pdfString = (text: string) =>
  "(" +
  encode(text)
    .map((c) => (c === 0x28 || c === 0x29 || c === 0x5c ? "\\" + String.fromCharCode(c) : c < 32 || c > 126 ? "\\" + c.toString(8).padStart(3, "0") : String.fromCharCode(c)))
    .join("") +
  ")";

// Cuts text to fit a width, adding "..." when cut
export function fit(text: string, width: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= width) return text;
  let t = text;
  while (t.length > 1 && textWidth(t + "...", size, bold) > width) t = t.slice(0, -1);
  return t.trimEnd() + "...";
}

// Splits text into lines no wider than `width`
export function wrap(text: string, width: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width) line = next;
      else {
        if (line) lines.push(line);
        line = textWidth(word, size, bold) > width ? fit(word, width, size, bold) : word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export class Pdf {
  readonly width = 595.28; // A4
  readonly height = 841.89;
  private pages: string[][] = [];

  constructor() {
    this.addPage();
  }

  get page() {
    return this.pages.length;
  }

  addPage() {
    this.pages.push([]);
  }

  private get ops() {
    return this.pages[this.pages.length - 1];
  }

  // y is measured from the top of the page
  text(x: number, y: number, text: string, opts: { size?: number; bold?: boolean; align?: "left" | "right"; gray?: boolean } = {}) {
    const size = opts.size ?? 10;
    const w = opts.align === "right" ? textWidth(text, size, opts.bold) : 0;
    const color = opts.gray ? "0.42 0.42 0.42 rg" : "0 0 0 rg";
    this.ops.push(`BT ${color} /${opts.bold ? "F2" : "F1"} ${size} Tf ${(x - w).toFixed(2)} ${(this.height - y).toFixed(2)} Td ${pdfString(text)} Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.8) {
    this.ops.push(`${gray} G 0.6 w ${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l S`);
  }

  box(x: number, y: number, w: number, h: number, gray = 0.95) {
    this.ops.push(`${gray} g ${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  toBuffer(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body) - 1 + 1; // 1-based object number
    const catalog = add("");
    const pagesObj = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join("\n");
      const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
      kids.push(
        add(
          `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.width} ${this.height}] ` +
            `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${stream} 0 R >>`,
        ),
      );
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

export function money(amount: number, currency: string): string {
  const v = (Math.round(amount * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${v}`;
}

// The purchase order as a PDF the supplier can print
export function poPdf(d: PoDocument): Buffer {
  const pdf = new Pdf();
  const L = 40;
  const R = pdf.width - 40;
  let y = 50;

  pdf.text(L, y, fit(d.company.name, 300, 18, true), { size: 18, bold: true });
  pdf.text(R, y, "PURCHASE ORDER", { size: 12, bold: true, align: "right" });
  y += 18;
  pdf.text(R, y, d.number, { size: 12, align: "right" });
  for (const l of wrap(d.company.address, 300, 9).slice(0, 4)) {
    pdf.text(L, y, l, { size: 9, gray: true });
    y += 12;
  }
  if (d.company.email) {
    pdf.text(L, y, d.company.email, { size: 9, gray: true });
    y += 12;
  }
  y = Math.max(y, 92) + 10;
  pdf.text(R, y - 18, `Date: ${d.createdAt}`, { size: 9, align: "right" });
  if (d.expectedAt) pdf.text(R, y - 6, `Expected: ${d.expectedAt}`, { size: 9, align: "right" });

  // Supplier and delivery
  const top = y + 6;
  pdf.text(L, top, "SUPPLIER", { size: 8, bold: true, gray: true });
  pdf.text(310, top, "DELIVER TO", { size: 8, bold: true, gray: true });
  let ys = top + 14;
  const sup = [d.supplier.name, d.supplier.contactName, ...wrap(d.supplier.address, 240, 9).slice(0, 4), d.supplier.email, d.supplier.phone].filter(Boolean);
  sup.forEach((t, i) => {
    pdf.text(L, ys, fit(t, 250, i ? 9 : 10, i === 0), { size: i ? 9 : 10, bold: i === 0 });
    ys += 12;
  });
  let yd = top + 14;
  for (const t of [d.company.name, d.shipTo]) {
    pdf.text(310, yd, fit(t, 245, 9), { size: 9 });
    yd += 12;
  }
  y = Math.max(ys, yd) + 14;

  // Lines
  const cols = { n: L, item: L + 22, sku: 330, qty: 425, cost: 490, total: R };
  const header = () => {
    pdf.box(L, y - 11, R - L, 16);
    pdf.text(cols.n, y, "#", { size: 8, bold: true });
    pdf.text(cols.item, y, "Item", { size: 8, bold: true });
    pdf.text(cols.sku, y, "SKU / supplier SKU", { size: 8, bold: true });
    pdf.text(cols.qty, y, "Qty", { size: 8, bold: true, align: "right" });
    pdf.text(cols.cost, y, "Unit cost", { size: 8, bold: true, align: "right" });
    pdf.text(cols.total, y, "Total", { size: 8, bold: true, align: "right" });
    y += 16;
  };
  header();
  d.lines.forEach((l, i) => {
    const titleLines = wrap(l.title, cols.sku - cols.item - 8, 9).slice(0, 2);
    const skuLines = [l.sku, l.supplierSku && l.supplierSku !== l.sku ? `Supplier: ${l.supplierSku}` : ""].filter(Boolean);
    const h = Math.max(titleLines.length, skuLines.length, 1) * 11 + 5;
    if (y + h > pdf.height - 120) {
      pdf.text(R, pdf.height - 30, `Continued on page ${pdf.page + 1}`, { size: 8, gray: true, align: "right" });
      pdf.addPage();
      y = 50;
      pdf.text(L, y, `${d.number} (continued)`, { size: 10, bold: true });
      y += 22;
      header();
    }
    pdf.text(cols.n, y, String(i + 1), { size: 9, gray: true });
    titleLines.forEach((t, j) => pdf.text(cols.item, y + j * 11, t, { size: 9 }));
    skuLines.forEach((t, j) => pdf.text(cols.sku, y + j * 11, fit(t, cols.qty - cols.sku - 30, 8), { size: 8, gray: j > 0 }));
    pdf.text(cols.qty, y, String(l.quantity), { size: 9, align: "right" });
    pdf.text(cols.cost, y, l.unitCost.toFixed(2), { size: 9, align: "right" });
    pdf.text(cols.total, y, l.total.toFixed(2), { size: 9, align: "right" });
    y += h;
    pdf.line(L, y - 9, R, y - 9, 0.88);
  });

  // Totals
  y += 6;
  const units = d.lines.reduce((a, l) => a + l.quantity, 0);
  pdf.text(L, y, `${d.lines.length} items, ${units} units`, { size: 9, gray: true });
  const total = (label: string, v: number, bold = false) => {
    pdf.text(cols.cost, y, label, { size: 9, bold, align: "right" });
    pdf.text(R, y, money(v, d.currency), { size: 9, bold, align: "right" });
    y += 14;
  };
  total("Subtotal", d.subtotal);
  if (d.shippingCost) total("Shipping", d.shippingCost);
  total("Total", d.total, true);

  const block = (title: string, body: string) => {
    if (!body.trim()) return;
    const lines = wrap(body, R - L, 9);
    if (y + 20 + lines.length * 12 > pdf.height - 40) {
      pdf.addPage();
      y = 50;
    }
    y += 10;
    pdf.text(L, y, title, { size: 8, bold: true, gray: true });
    y += 13;
    for (const l of lines) {
      pdf.text(L, y, l, { size: 9 });
      y += 12;
    }
  };
  block("NOTES", d.notes);
  block("SUPPLIER NOTES", d.supplier.notes);
  block("TERMS", d.footer);
  return pdf.toBuffer();
}
