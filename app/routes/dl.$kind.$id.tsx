// Signed links (see app/.server/signed.ts). No session here: the signature is the permission.
//   /dl/po-pdf/:poId  /dl/po-csv/:poId  /dl/po-print/:poId   a purchase order
//   /dl/reorder-csv/all  /dl/dead-csv/all                     the reorder and dead stock lists
//   /dl/report-csv/:jobId                                     a supplier import report
//   /dl/alerts-off/weekly|low-stock                           turn an alert email off (GET asks, POST does it)
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { verifySigned } from "../.server/signed";
import { poCsv, poDocument, toCsv, type PoDocument } from "../.server/purchase-orders";
import { money, poPdf } from "../.server/pdf";
import { deadStock, loadPlanning } from "../.server/planning";
import { readReport } from "../.server/jobs/service";
import { IMPORT_REPORT_HEADERS, type ImportReport } from "../.server/imports";
import { esc } from "../.server/email";
import { fmt, STATUS_LABEL } from "../lib/forecast";
import { withDefaults } from "../lib/settings";

const SAFE = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
const file = (body: string | Buffer, type: string, name: string) =>
  new Response(typeof body === "string" ? body : new Uint8Array(body), {
    headers: { ...SAFE, "content-type": type, "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`, "cache-control": "private, no-store" },
  });
const notFound = () => new Response("Not found", { status: 404, headers: SAFE });
const expired = () =>
  new Response("This link has expired. Go back to the app and try again.", { status: 403, headers: { ...SAFE, "content-type": "text/plain; charset=utf-8" } });

const r2 = (v: number | null | undefined) => (v == null ? "" : (Math.round(v * 100) / 100).toFixed(2));

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const kind = params.kind!;
  const id = params.id!;
  const shop = verifySigned(kind, id, new URL(request.url).searchParams);
  if (!shop) return expired();

  switch (kind) {
    case "po-pdf": {
      const d = await poDocument(shop, id);
      return d ? file(poPdf(d), "application/pdf", `${d.number}.pdf`) : notFound();
    }
    case "po-csv": {
      const d = await poDocument(shop, id);
      return d ? file(poCsv(d), "text/csv; charset=utf-8", `${d.number}.csv`) : notFound();
    }
    case "po-print": {
      const d = await poDocument(shop, id);
      if (!d) return notFound();
      return new Response(printPage(d), {
        headers: {
          "x-content-type-options": "nosniff",
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          "cache-control": "private, no-store",
        },
      });
    }
    case "reorder-csv": {
      const p = await loadPlanning(shop);
      const rows = p.rows
        .filter((r) => !r.isBundle)
        .map((r) => [
          r.title, r.variantTitle, r.sku, r.supplierName ?? "", r.supplierSku, STATUS_LABEL[r.f.status], r.available, r.onOrder, r.incoming,
          fmt(r.f.rate), r.f.daysLeft == null ? "" : Math.floor(r.f.daysLeft), r.f.stockoutDay ?? "", r.f.reorderByDay ?? "", r.f.suggested,
          r2(r.unitCost), r2(r.unitCost == null ? null : r.unitCost * r.f.suggested), [...r.f.why, ...r.f.warnings].join(" "),
        ]);
      return file(
        toCsv(
          ["Product", "Variant", "SKU", "Supplier", "Supplier SKU", "Status", "In stock", "On order", "Incoming", "Sales per day", "Days left", "Runs out", "Order by", "Suggested order", `Unit cost (${p.currency})`, `Order value (${p.currency})`, "Why"],
          rows,
        ),
        "text/csv; charset=utf-8",
        `reorder-list-${p.today}.csv`,
      );
    }
    case "dead-csv": {
      const p = await loadPlanning(shop);
      const rows = deadStock(p).map((r) => [r.title, r.variantTitle, r.sku, r.supplierName ?? "", r.available, r2(r.unitCost), r2(r.value), r.lastSaleDay ?? "never", r.daysSinceSale ?? ""]);
      return file(
        toCsv(["Product", "Variant", "SKU", "Supplier", "In stock", `Unit cost (${p.currency})`, `Stock value (${p.currency})`, "Last sale", "Days since last sale"], rows),
        "text/csv; charset=utf-8",
        `dead-stock-${p.today}.csv`,
      );
    }
    case "report-csv": {
      const rep = await readReport<ImportReport>(shop, id);
      if (!rep) return notFound();
      return file(
        toCsv([...IMPORT_REPORT_HEADERS], rep.rows.map((r) => IMPORT_REPORT_HEADERS.map((h) => r[h]))),
        "text/csv; charset=utf-8",
        `supplier-import-${id}.csv`,
      );
    }
    case "alerts-off": {
      const what = id === "weekly" ? "the weekly reorder email" : "low-stock alerts";
      return htmlPage(
        `Turn off ${what}?`,
        `<form method="post"><p>Store: ${esc(shop)}</p><button type="submit">Turn off ${esc(what)}</button></form><p>You can turn it back on any time in Reorder Desk's Settings.</p>`,
      );
    }
  }
  return notFound();
};

// One-click unsubscribe (email clients POST here too, per RFC 8058)
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const kind = params.kind!;
  const id = params.id!;
  const shop = verifySigned(kind, id, new URL(request.url).searchParams);
  if (!shop || kind !== "alerts-off" || !["weekly", "low-stock"].includes(id)) return expired();
  const s = await prisma.shop.findUnique({ where: { shop }, select: { settings: true } });
  if (s) {
    const settings = withDefaults(s.settings);
    if (id === "weekly") settings.alerts.weekly = false;
    else settings.alerts.lowStock = false;
    await prisma.shop.update({ where: { shop }, data: { settings: settings as unknown as Prisma.InputJsonValue } });
  }
  return htmlPage("Done", `<p>${id === "weekly" ? "The weekly reorder email" : "Low-stock alerts"} for ${esc(shop)} are off. Turn them back on any time in Reorder Desk's Settings.</p>`);
};

function htmlPage(title: string, body: string) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#222}button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#1a1a1a;color:#fff;cursor:pointer}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`,
    {
      headers: {
        "x-content-type-options": "nosniff",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      },
    },
  );
}

// The purchase order as a page to print or save as PDF from the browser (all languages and symbols work here)
function printPage(d: PoDocument) {
  const lines = d.lines
    .map(
      (l, i) =>
        `<tr><td>${i + 1}</td><td>${esc(l.title)}</td><td>${esc(l.sku)}${l.supplierSku && l.supplierSku !== l.sku ? `<br><small>Supplier: ${esc(l.supplierSku)}</small>` : ""}</td><td class="n">${l.quantity}</td><td class="n">${l.unitCost.toFixed(2)}</td><td class="n">${l.total.toFixed(2)}</td></tr>`,
    )
    .join("");
  const block = (title: string, text: string) => (text.trim() ? `<h3>${title}</h3><p class="pre">${esc(text)}</p>` : "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.number)}</title>
<style>
body{font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 16px}
header{display:flex;justify-content:space-between;gap:16px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 4px;text-align:right}
.muted{color:#666}.pre{white-space:pre-wrap}.cols{display:flex;gap:32px;margin:20px 0}.cols>div{flex:1}h3{font-size:11px;color:#666;letter-spacing:.05em;text-transform:uppercase;margin:16px 0 4px}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{text-align:left;padding:6px;border-bottom:1px solid #ddd;vertical-align:top}th{background:#f3f3f3;font-size:11px}
.n{text-align:right;white-space:nowrap}.totals{margin-left:auto;width:280px;margin-top:8px}.totals td{border:0}.bar{margin:16px 0}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer}
@media print{.bar{display:none}body{margin:0}}
</style></head><body>
<div class="bar"><button onclick="window.print()">Print or save as PDF</button></div>
<header><div><h1>${esc(d.company.name)}</h1><div class="muted pre">${esc(d.company.address)}</div><div class="muted">${esc(d.company.email)}</div></div>
<div><h2>PURCHASE ORDER<br>${esc(d.number)}</h2><div class="muted" style="text-align:right">Date: ${esc(d.createdAt)}${d.expectedAt ? `<br>Expected: ${esc(d.expectedAt)}` : ""}</div></div></header>
<div class="cols"><div><h3>Supplier</h3><strong>${esc(d.supplier.name)}</strong><div class="pre">${esc([d.supplier.contactName, d.supplier.address, d.supplier.email, d.supplier.phone].filter(Boolean).join("\n"))}</div></div>
<div><h3>Deliver to</h3><div class="pre">${esc(`${d.company.name}\n${d.shipTo}`)}</div></div></div>
<table><thead><tr><th>#</th><th>Item</th><th>SKU</th><th class="n">Qty</th><th class="n">Unit cost</th><th class="n">Total</th></tr></thead><tbody>${lines}</tbody></table>
<table class="totals"><tr><td>Subtotal</td><td class="n">${esc(money(d.subtotal, d.currency))}</td></tr>${d.shippingCost ? `<tr><td>Shipping</td><td class="n">${esc(money(d.shippingCost, d.currency))}</td></tr>` : ""}<tr><td><strong>Total</strong></td><td class="n"><strong>${esc(money(d.total, d.currency))}</strong></td></tr></table>
${block("Notes", d.notes)}${block("Supplier notes", d.supplier.notes)}${block("Terms", d.footer)}
</body></html>`;
}
