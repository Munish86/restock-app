// The emails merchants get: the weekly "order these items" email, and a daily alert when items newly need
// ordering. Each item is alerted once per low-stock episode; nothing is sent when there is nothing to do.
// No marketing, ever. Purchase orders to suppliers are sent from here too.
import prisma from "../db.server";
import { localClock, shortDay } from "../lib/dates";
import { fmt, STATUS_LABEL } from "../lib/forecast";
import { parseEmails, withDefaults } from "../lib/settings";
import { adminAppUrl, button, esc, layout, sendEmail } from "./email";
import { loadPlanning, summary, type PlanRow, type Planning } from "./planning";
import { markSentByEmail, poCsv, poDocument } from "./purchase-orders";
import { money, poPdf } from "./pdf";
import { absoluteSignedUrl } from "./signed";
import { InputError } from "./suppliers";

const URGENCY: Record<string, number> = { out: 0, "order-now": 1, "order-soon": 2 };
const MAX_ROWS = 25;

export function recipientsOf(shopEmail: string, recipients: string): string[] {
  const list = parseEmails(recipients).list;
  return list.length ? list : parseEmails(shopEmail).list;
}

// Items that need ordering, most urgent first
export function toOrder(p: Planning): PlanRow[] {
  return p.rows
    .filter((r) => r.f.status in URGENCY && r.f.suggested > 0)
    .sort((a, b) => URGENCY[a.f.status] - URGENCY[b.f.status] || (a.f.stockoutDay ?? "9").localeCompare(b.f.stockoutDay ?? "9"));
}

const name = (r: PlanRow) => (r.variantTitle ? `${r.title} - ${r.variantTitle}` : r.title);

function itemsTable(rows: PlanRow[], today: string) {
  const cell = "padding:6px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top";
  const head = ["Item", "Status", "In stock", "Runs out", "Order"].map((h, i) => `<th style="${cell};font-size:12px;color:#666${i > 1 ? ";text-align:right" : ""}">${h}</th>`).join("");
  const body = rows
    .slice(0, MAX_ROWS)
    .map(
      (r) => `<tr>
<td style="${cell}">${esc(name(r))}${r.sku ? `<br><span style="color:#777;font-size:12px">${esc(r.sku)}${r.supplierName ? ` · ${esc(r.supplierName)}` : ""}</span>` : ""}</td>
<td style="${cell}">${esc(STATUS_LABEL[r.f.status])}</td>
<td style="${cell};text-align:right">${fmt(r.available)}${r.onOrder ? `<br><span style="color:#777;font-size:12px">+${fmt(r.onOrder)} on order</span>` : ""}</td>
<td style="${cell};text-align:right">${r.available <= 0 ? "Now" : esc(shortDay(r.f.stockoutDay, today))}</td>
<td style="${cell};text-align:right;font-weight:600">${fmt(r.f.suggested)}</td></tr>`,
    )
    .join("");
  const more = rows.length > MAX_ROWS ? `<p style="color:#555">…and ${rows.length - MAX_ROWS} more in the app.</p>` : "";
  return `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

function itemsText(rows: PlanRow[], today: string) {
  return rows
    .slice(0, MAX_ROWS)
    .map((r) => `- ${name(r)}${r.sku ? ` (${r.sku})` : ""}: order ${fmt(r.f.suggested)} · ${fmt(r.available)} in stock · runs out ${r.available <= 0 ? "now" : shortDay(r.f.stockoutDay, today)}`)
    .join("\n");
}

const footer = (shop: string, kind: "weekly" | "low-stock") => {
  const off = absoluteSignedUrl("alerts-off", shop, kind, 120 * 24 * 3600);
  return {
    off,
    html: `You get this email because ${kind === "weekly" ? "the weekly reorder email" : "low-stock alerts"} are on in Restock for ${esc(shop)}. Change this in the app's Settings, or <a href="${esc(off)}" style="color:#777">turn it off</a>.`,
  };
};

export async function sendWeekly(shop: string, opts: { force?: boolean } = {}) {
  const s = await prisma.shop.findUnique({ where: { shop } });
  if (!s) return { status: "skipped" as const, error: "Store not found." };
  const settings = withDefaults(s.settings);
  const p = await loadPlanning(shop);
  const rows = toOrder(p);
  const sum = summary(p);
  if (!rows.length && !opts.force) return { status: "skipped" as const, error: "Nothing to order this week." };
  const f = footer(shop, "weekly");
  const value = sum.toOrderValue > 0 ? ` (about ${money(sum.toOrderValue, p.currency)} at cost)` : "";
  const subject = rows.length ? `Restock: order ${rows.length} item${rows.length === 1 ? "" : "s"} this week` : "Restock: nothing to order this week";
  const intro = rows.length
    ? `${rows.length} item${rows.length === 1 ? "" : "s"} in ${esc(s.name || shop)} need${rows.length === 1 ? "s" : ""} ordering${value}. ${sum.counts.out ? `${sum.counts.out} already out of stock.` : ""}`
    : `Nothing in ${esc(s.name || shop)} needs ordering this week.`;
  const extra =
    sum.deadCount > 0
      ? `<p style="color:#555;margin-top:16px">${sum.deadCount} item${sum.deadCount === 1 ? " has" : "s have"} not sold in ${settings.forecast.deadStockDays} days${sum.deadValue ? `, with ${money(sum.deadValue, p.currency)} of stock` : ""}. See Dead stock in the app.</p>`
      : "";
  const r = await sendEmail(shop, "weekly", {
    to: recipientsOf(s.email, settings.alerts.recipients),
    subject,
    html: layout({
      title: rows.length ? "This week's reorder list" : "All stocked up",
      intro,
      body: (rows.length ? itemsTable(rows, p.today) : "") + extra + button(adminAppUrl(shop), "Open the reorder list"),
      footer: f.html,
    }),
    text: `${intro.replace(/<[^>]+>/g, "")}\n\n${itemsText(rows, p.today)}\n\nOpen the reorder list: ${adminAppUrl(shop)}\nTurn this email off: ${f.off}`,
    unsubscribeUrl: f.off,
  });
  // Everything listed counts as alerted, so tomorrow's low-stock alert does not repeat it
  const urgent = rows.filter((x) => x.f.status === "out" || x.f.status === "order-now").map((x) => x.id);
  if (r.status !== "failed" && urgent.length) {
    await prisma.variant.updateMany({ where: { shop, id: { in: urgent }, lowAlertAt: null }, data: { lowAlertAt: new Date() } });
  }
  return r;
}

export async function sendLowStock(shop: string) {
  const s = await prisma.shop.findUnique({ where: { shop } });
  if (!s) return { status: "skipped" as const };
  const settings = withDefaults(s.settings);
  const p = await loadPlanning(shop);
  const flagged = new Set(
    (await prisma.variant.findMany({ where: { shop, lowAlertAt: { not: null } }, select: { id: true } })).map((v) => v.id),
  );
  // Back to normal: the next drop alerts again
  const recovered = p.rows.filter((r) => flagged.has(r.id) && !["out", "order-now"].includes(r.f.status)).map((r) => r.id);
  if (recovered.length) await prisma.variant.updateMany({ where: { shop, id: { in: recovered } }, data: { lowAlertAt: null } });

  const fresh = toOrder(p).filter((r) => (r.f.status === "out" || r.f.status === "order-now") && !flagged.has(r.id));
  if (!fresh.length) return { status: "skipped" as const, error: "No new items need ordering." };
  const f = footer(shop, "low-stock");
  const intro = `${fresh.length} item${fresh.length === 1 ? "" : "s"} in ${esc(s.name || shop)} ${fresh.length === 1 ? "needs" : "need"} ordering now.`;
  const r = await sendEmail(shop, "low-stock", {
    to: recipientsOf(s.email, settings.alerts.recipients),
    subject: `Restock: ${fresh.length} item${fresh.length === 1 ? "" : "s"} to order now`,
    html: layout({ title: "Low stock", intro, body: itemsTable(fresh, p.today) + button(adminAppUrl(shop), "Open the reorder list"), footer: f.html }),
    text: `${intro}\n\n${itemsText(fresh, p.today)}\n\nOpen the reorder list: ${adminAppUrl(shop)}\nTurn these alerts off: ${f.off}`,
    unsubscribeUrl: f.off,
  });
  if (r.status !== "failed") {
    await prisma.variant.updateMany({ where: { shop, id: { in: fresh.map((x) => x.id) } }, data: { lowAlertAt: new Date() } });
  }
  return r;
}

// Sends a purchase order to its supplier with the PDF and CSV attached, then marks it as sent
export async function emailPo(shop: string, poId: string, opts: { to?: string; cc?: string; message?: string } = {}) {
  const d = await poDocument(shop, poId);
  if (!d) throw new InputError("Purchase order not found.", 404);
  if (!d.lines.length) throw new InputError("Add at least one item before sending.");
  if (d.status === "cancelled") throw new InputError("This order is cancelled.", 409);
  const s = await prisma.shop.findUnique({ where: { shop } });
  const settings = withDefaults(s?.settings);
  const to = parseEmails(opts.to ?? d.supplier.email);
  if (to.bad.length) throw new InputError(`Not an email address: ${to.bad.slice(0, 3).join(", ")}.`);
  if (!to.list.length) throw new InputError("The supplier has no email address. Add one, or download the PDF and send it yourself.");
  const supplier = await prisma.purchaseOrder.findFirst({ where: { shop, id: poId }, select: { supplier: { select: { ccEmails: true } } } });
  const cc = parseEmails(opts.cc ?? supplier?.supplier.ccEmails ?? "");
  if (cc.bad.length) throw new InputError(`Not an email address: ${cc.bad.slice(0, 3).join(", ")}.`);
  const replyTo = settings.po.replyTo || s?.email || undefined;
  const message = String(opts.message ?? "").slice(0, 3000).trim();
  const units = d.lines.reduce((a, l) => a + l.quantity, 0);
  const intro = `Please find attached purchase order <strong>${esc(d.number)}</strong> from ${esc(d.company.name)}: ${d.lines.length} items, ${units} units, ${esc(money(d.total, d.currency))}${d.expectedAt ? `, needed by ${esc(d.expectedAt)}` : ""}.`;
  const body =
    (message ? `<p style="white-space:pre-wrap">${esc(message)}</p>` : "") +
    `<table style="border-collapse:collapse;width:100%;font-size:13px">${d.lines
      .slice(0, 50)
      .map(
        (l) =>
          `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee">${esc(l.title)}${l.supplierSku || l.sku ? `<br><span style="color:#777">${esc(l.supplierSku || l.sku)}</span>` : ""}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;text-align:right">${l.quantity}</td></tr>`,
      )
      .join("")}</table>${d.lines.length > 50 ? `<p>…and ${d.lines.length - 50} more lines in the attached PDF.</p>` : ""}` +
    (replyTo ? `<p style="margin-top:16px">Reply to this email to reach ${esc(d.company.name)}.</p>` : "");
  const r = await sendEmail(shop, "purchase-order", {
    to: to.list,
    cc: cc.list,
    replyTo,
    subject: `Purchase order ${d.number} from ${d.company.name}`,
    html: layout({ title: `Purchase order ${d.number}`, intro, body, footer: `Sent for ${esc(d.company.name)} with Restock.` }),
    text:
      `Purchase order ${d.number} from ${d.company.name}: ${d.lines.length} items, ${units} units, ${money(d.total, d.currency)}.\n\n` +
      (message ? `${message}\n\n` : "") +
      d.lines.map((l) => `${l.quantity} x ${l.title}${l.supplierSku || l.sku ? ` (${l.supplierSku || l.sku})` : ""}`).join("\n") +
      `\n\nThe PDF and CSV are attached.`,
    attachments: [
      { filename: `${d.number}.pdf`, content: poPdf(d), contentType: "application/pdf" },
      { filename: `${d.number}.csv`, content: Buffer.from(poCsv(d), "utf8"), contentType: "text/csv" },
    ],
  });
  if (r.status === "failed") throw new InputError(`The email was not sent: ${r.error}`, 502);
  await markSentByEmail(poId);
  return { ...r, to: to.list, cc: cc.list };
}

export async function sendTestEmail(shop: string) {
  const s = await prisma.shop.findUnique({ where: { shop } });
  if (!s) throw new InputError("Store not found.", 404);
  const to = recipientsOf(s.email, withDefaults(s.settings).alerts.recipients);
  if (!to.length) throw new InputError("Add an email address for alerts first.");
  const r = await sendEmail(shop, "test", {
    to,
    subject: "Restock: test email",
    html: layout({
      title: "Emails work",
      intro: "This is a test from Restock. Weekly reorder emails and low-stock alerts will arrive at this address.",
      body: button(adminAppUrl(shop), "Open Restock"),
      footer: `Sent because someone clicked "Send a test email" in Restock for ${esc(shop)}.`,
    }),
    text: "This is a test from Restock. Weekly reorder emails and low-stock alerts will arrive at this address.",
  });
  return { ...r, to };
}

// Called every minute by the worker: sends what is due in each store's own time zone.
// Each send is claimed with a conditional update first, so two workers never send the same email.
export async function runDueAlerts(now = new Date(), take = 50) {
  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null, syncedAt: { not: null } },
    select: { shop: true, timezone: true, settings: true, weeklySentAt: true, dailyCheckAt: true },
    orderBy: { dailyCheckAt: { sort: "asc", nulls: "first" } },
    take: 500,
  });
  let done = 0;
  for (const s of shops) {
    if (done >= take) break;
    const a = withDefaults(s.settings).alerts;
    const clock = localClock(now, s.timezone);
    if (clock.hour < a.hour) continue;
    const today = clock.day;
    if (a.weekly && clock.weekday === a.weeklyDay && (!s.weeklySentAt || localClock(s.weeklySentAt, s.timezone).day !== today)) {
      const claim = await prisma.shop.updateMany({
        where: { shop: s.shop, OR: [{ weeklySentAt: null }, { weeklySentAt: { lt: new Date(now.getTime() - 20 * 3600 * 1000) } }] },
        data: { weeklySentAt: now },
      });
      if (claim.count) {
        done++;
        await sendWeekly(s.shop).catch((e) => console.error(`Weekly email failed for ${s.shop}:`, e));
      }
    }
    if (a.lowStock && (!s.dailyCheckAt || localClock(s.dailyCheckAt, s.timezone).day !== today)) {
      const claim = await prisma.shop.updateMany({
        where: { shop: s.shop, OR: [{ dailyCheckAt: null }, { dailyCheckAt: { lt: new Date(now.getTime() - 20 * 3600 * 1000) } }] },
        data: { dailyCheckAt: now },
      });
      if (claim.count) {
        done++;
        await sendLowStock(s.shop).catch((e) => console.error(`Low-stock alert failed for ${s.shop}:`, e));
      }
    }
  }
  return done;
}
