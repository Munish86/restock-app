// SMS and WhatsApp alerts (Pro): a short message to the merchant's own numbers when items need ordering.
// Production uses Twilio (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN, then TWILIO_SMS_FROM for SMS and
// TWILIO_WHATSAPP_FROM + TWILIO_WHATSAPP_TEMPLATE for WhatsApp). Without them, messages are only logged.
// Every message costs the app money, so each one is counted against the plan's monthly limit before it is sent
// (given back when it was not sent), and SMS are kept to one segment: plain characters, at most 160.
// Every attempt is written to MessageLog.
import prisma from "../db.server";
import { planByKey } from "../lib/plans";
import { channelsOf, parsePhones, withDefaults, type AlertSettings, type Channel } from "../lib/settings";

export type { Channel };
export type MessageKind = "weekly" | "low-stock" | "test";

export interface TextMessage {
  channel: Channel;
  to: string; // +E.164
  body: string; // the SMS text (also kept in the log for WhatsApp)
  vars: [string, string, string]; // WhatsApp template: {{1}} store name, {{2}} what happened, {{3}} link
}

export interface Texter {
  readonly channels: Record<Channel, boolean>; // which channels really send
  send(m: TextMessage): Promise<void>;
}

export class TwilioTexter implements Texter {
  readonly channels: Record<Channel, boolean>;
  constructor(
    private sid: string,
    private token: string,
    private smsFrom: string, // "+15550100000" or a Messaging Service id "MG..."
    private waFrom: string, // "+15550100000" (the WhatsApp sender)
    private waTemplate: string, // Content template id "HX..." (approved by WhatsApp, category Utility)
  ) {
    this.channels = { sms: Boolean(smsFrom), whatsapp: Boolean(waFrom && waTemplate) };
  }

  async send(m: TextMessage) {
    const p = new URLSearchParams();
    if (m.channel === "sms") {
      p.set("To", m.to);
      p.set(this.smsFrom.startsWith("MG") ? "MessagingServiceSid" : "From", this.smsFrom);
      p.set("Body", m.body);
    } else {
      p.set("To", `whatsapp:${m.to}`);
      p.set("From", `whatsapp:${this.waFrom.replace(/^whatsapp:/, "")}`);
      p.set("ContentSid", this.waTemplate);
      p.set("ContentVariables", JSON.stringify({ 1: m.vars[0], 2: m.vars[1], 3: m.vars[2] }));
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.sid)}/Messages.json`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: p.toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const raw = await res.text();
      let detail = raw.slice(0, 300);
      try {
        const j = JSON.parse(raw) as { message?: string; code?: number };
        if (j.message) detail = `${j.message}${j.code ? ` (Twilio ${j.code})` : ""}`;
      } catch {
        // not JSON: keep the raw text
      }
      throw new Error(`The message service refused the message (${res.status}): ${detail}`);
    }
  }
}

// Development: prints the message instead of sending it
export class LogTexter implements Texter {
  readonly channels: Record<Channel, boolean> = { sms: false, whatsapp: false };
  sent: TextMessage[] = [];
  async send(m: TextMessage) {
    this.sent.push(m);
    console.log(`[${m.channel} not sent: Twilio is not set up] to ${m.to}: ${m.body}`);
  }
}

let texter: Texter | null = null;

export function getTexter(): Texter {
  if (texter) return texter;
  const e = process.env;
  if (e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_SMS_FROM || e.TWILIO_WHATSAPP_FROM)) {
    texter = new TwilioTexter(e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN, e.TWILIO_SMS_FROM || "", e.TWILIO_WHATSAPP_FROM || "", e.TWILIO_WHATSAPP_TEMPLATE || "");
    if (e.TWILIO_WHATSAPP_FROM && !e.TWILIO_WHATSAPP_TEMPLATE) console.warn("TWILIO_WHATSAPP_TEMPLATE is not set: WhatsApp messages are not sent.");
  } else {
    texter = new LogTexter();
  }
  return texter;
}

export function setTexter(t: Texter | null) {
  texter = t;
}

// Characters every phone shows in a single 160-character SMS (the GSM 7-bit set, without the ones that take two
// places). Accents are dropped ("Café" -> "Cafe"); anything else (emoji, other scripts) is left out. A message
// with even one other character would be split into 70-character parts, each charged separately.
export function smsText(s: string, max = 160): string {
  const plain = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^A-Za-z0-9 \n!"#$%&'()*+,\-./:;<=>?@_]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return plain.length <= max ? plain : `${plain.slice(0, max - 3).trimEnd()}...`;
}

// WhatsApp template values may not hold line breaks, tabs or long runs of spaces
const waValue = (s: string, max = 900) => s.replace(/\s+/g, " ").trim().slice(0, max);

export const monthKey = (d: Date) => d.toISOString().slice(0, 7);

// Takes one message from this month's allowance; false when it is used up
async function takeOne(shop: string, limit: number, now: Date) {
  const m = monthKey(now);
  await prisma.shop.updateMany({ where: { shop, NOT: { msgMonth: m } }, data: { msgMonth: m, msgCount: 0 } });
  const r = await prisma.shop.updateMany({ where: { shop, msgMonth: m, msgCount: { lt: limit } }, data: { msgCount: { increment: 1 } } });
  return r.count === 1;
}

async function giveBack(shop: string, now: Date) {
  await prisma.shop.updateMany({ where: { shop, msgMonth: monthKey(now), msgCount: { gt: 0 } }, data: { msgCount: { decrement: 1 } } });
}

export async function messagesUsed(shop: string, now = new Date()) {
  const s = await prisma.shop.findUnique({ where: { shop }, select: { msgMonth: true, msgCount: true } });
  return s && s.msgMonth === monthKey(now) ? s.msgCount : 0;
}

// Whether a store wants messages of this kind (the plan is checked when sending)
export function wantsTexts(a: AlertSettings, kind: "weekly" | "low-stock") {
  return parsePhones(a.phones).list.length > 0 && (kind === "weekly" ? a.phoneWeekly : a.phoneLowStock);
}

export interface TextContent {
  sms: string; // full SMS text; cut to one segment here
  what: string; // WhatsApp {{2}}
  link: string; // WhatsApp {{3}}
}

export type TextResult = { status: "sent" | "skipped" | "failed"; error?: string; sent: number; failed: number; to: string[] };

// Sends one alert to every number on the store's channels, within the plan's monthly allowance
export async function sendTexts(shop: string, kind: MessageKind, content: TextContent, now = new Date()): Promise<TextResult> {
  const s = await prisma.shop.findUnique({ where: { shop }, select: { name: true, plan: true, settings: true } });
  const none = (error: string): TextResult => ({ status: "skipped", error, sent: 0, failed: 0, to: [] });
  if (!s) return none("Store not found.");
  const plan = planByKey(s.plan);
  if (!plan.messages) return none("SMS and WhatsApp alerts are part of the Pro plan.");
  const a = withDefaults(s.settings).alerts;
  const phones = parsePhones(a.phones).list;
  if (!phones.length) return none("Add a phone number first.");

  const t = getTexter();
  const body = smsText(content.sms);
  const vars: [string, string, string] = [waValue(s.name || shop, 100), waValue(content.what), content.link];
  let sent = 0;
  let failed = 0;
  let lastError: string | undefined;
  for (const channel of channelsOf(a.phoneChannel)) {
    for (const to of phones) {
      const log = (status: string, error: string | null) =>
        prisma.messageLog.create({ data: { shop, kind, channel, to, text: channel === "sms" ? body : vars[1], status, error } });
      if (!t.channels[channel]) {
        // Development, or this channel is not set up on the server: printed only, costs nothing
        if (t instanceof LogTexter) await t.send({ channel, to, body, vars });
        lastError = `${channel === "sms" ? "SMS" : "WhatsApp"} sending is not set up on this server.`;
        await log("skipped", lastError);
        continue;
      }
      if (!(await takeOne(shop, plan.messages, now))) {
        lastError = `This month's ${plan.messages} messages are used up; they start again on the 1st. Emails still go out.`;
        await log("skipped", lastError);
        continue;
      }
      try {
        await t.send({ channel, to, body, vars });
        sent++;
        await log("sent", null);
      } catch (e) {
        await giveBack(shop, now);
        failed++;
        lastError = (e as Error).message.slice(0, 1000);
        await log("failed", lastError);
      }
    }
  }
  return { status: sent ? "sent" : failed ? "failed" : "skipped", error: sent ? undefined : lastError, sent, failed, to: phones };
}
