// Sending email: weekly reorder emails, low-stock alerts and purchase orders to suppliers.
// Production uses Resend (RESEND_API_KEY + EMAIL_FROM). Without a key, emails are only logged, so local
// development never mails anyone. Every attempt is written to EmailLog (no bodies are kept).
import prisma from "../db.server";
import { appHandle } from "./shops";

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Attachment[];
  unsubscribeUrl?: string; // one-click "stop these emails" for alert emails
}

export interface Mailer {
  readonly live: boolean;
  send(m: EmailMessage): Promise<void>;
}

export class ResendMailer implements Mailer {
  readonly live = true;
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(m: EmailMessage) {
    const body = {
      from: this.from,
      to: m.to,
      ...(m.cc?.length ? { cc: m.cc } : {}),
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      subject: m.subject,
      html: m.html,
      text: m.text,
      ...(m.attachments?.length
        ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType })) }
        : {}),
      ...(m.unsubscribeUrl
        ? { headers: { "List-Unsubscribe": `<${m.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }
        : {}),
    };
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const text = (await res.text()).slice(0, 300);
      throw new Error(`The email service refused the email (${res.status}): ${text}`);
    }
  }
}

// Development: prints the email instead of sending it
export class LogMailer implements Mailer {
  readonly live = false;
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    console.log(`[email not sent: RESEND_API_KEY is not set] to ${m.to.join(", ")}: ${m.subject}`);
  }
}

let mailer: Mailer | null = null;

export function getMailer(): Mailer {
  if (mailer) return mailer;
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (key && from) mailer = new ResendMailer(key, from);
  else {
    if (process.env.NODE_ENV === "production") console.warn("RESEND_API_KEY / EMAIL_FROM not set: emails are not sent.");
    mailer = new LogMailer();
  }
  return mailer;
}

export function setMailer(m: Mailer | null) {
  mailer = m;
}

export type EmailKind = "weekly" | "low-stock" | "purchase-order" | "test";

export async function sendEmail(shop: string, kind: EmailKind, m: EmailMessage): Promise<{ status: "sent" | "skipped" | "failed"; error?: string }> {
  const to = [...new Set(m.to.map((x) => x.trim()).filter(Boolean))];
  const base = { shop, kind, to: to.join(", ").slice(0, 1000), subject: m.subject.slice(0, 300) };
  if (!to.length) {
    await prisma.emailLog.create({ data: { ...base, status: "skipped", error: "No email address." } });
    return { status: "skipped", error: "No email address." };
  }
  const mail = getMailer();
  try {
    await mail.send({ ...m, to });
    const status = mail.live ? "sent" : "skipped";
    await prisma.emailLog.create({ data: { ...base, status, error: mail.live ? null : "Email service not set up (development)." } });
    return { status };
  } catch (e) {
    const error = (e as Error).message.slice(0, 1000);
    await prisma.emailLog.create({ data: { ...base, status: "failed", error } });
    return { status: "failed", error };
  }
}

// Link to a page of the app inside Shopify Admin
export function adminAppUrl(shop: string, path = "") {
  const store = shop.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${store}/apps/${appHandle()}${path}`;
}

export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The plain frame every email uses: calm, readable, no tracking pixels
export function layout(opts: { title: string; intro: string; body: string; footer: string }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f4;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222">
<div style="max-width:640px;margin:0 auto;padding:24px 12px">
<div style="background:#fff;border-radius:10px;padding:24px;border:1px solid #e3e3e3">
<h1 style="font-size:20px;margin:0 0 8px">${esc(opts.title)}</h1>
<p style="margin:0 0 16px;color:#555">${opts.intro}</p>
${opts.body}
</div>
<p style="font-size:12px;color:#777;margin:16px 4px">${opts.footer}</p>
</div></body></html>`;
}

export function button(href: string, label: string) {
  return `<p style="margin:20px 0 4px"><a href="${esc(href)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">${esc(label)}</a></p>`;
}
