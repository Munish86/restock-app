// GET  /app/api/settings   settings, locations, the plan's limits, the latest emails and text messages
// POST /app/api/settings   { settings } save | { action: "test-email" } | { action: "send-weekly" } | { action: "test-message" }
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { apiError, readJson } from "../.server/http";
import { getSettings, saveSettings } from "../.server/shops";
import { sendTestEmail, sendTestMessage, sendWeekly } from "../.server/alerts";
import { getMailer } from "../.server/email";
import { getTexter, messagesUsed } from "../.server/texts";
import { planByKey } from "../lib/plans";

async function state(shop: string) {
  const [settings, s, locations, emails, messages, used] = await Promise.all([
    getSettings(shop),
    prisma.shop.findUnique({ where: { shop }, select: { email: true, plan: true, currency: true, timezone: true, name: true } }),
    prisma.location.findMany({ where: { shop }, orderBy: { name: "asc" } }),
    prisma.emailLog.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.messageLog.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 10 }),
    messagesUsed(shop),
  ]);
  const plan = planByKey(s?.plan);
  return {
    settings,
    shopEmail: s?.email ?? "",
    shopName: s?.name ?? "",
    currency: s?.currency ?? "USD",
    timezone: s?.timezone ?? "UTC",
    plan: { key: plan.key, name: plan.name, locations: plan.locations, messages: plan.messages },
    locations: locations.map((l) => ({ id: l.id, name: l.name, isActive: l.isActive })),
    emails: emails.map((e) => ({ kind: e.kind, to: e.to, subject: e.subject, status: e.status, error: e.error, at: e.createdAt.toISOString() })),
    emailLive: getMailer().live,
    messages: messages.map((m) => ({ kind: m.kind, channel: m.channel, to: m.to, text: m.text, status: m.status, error: m.error, at: m.createdAt.toISOString() })),
    messagesUsed: used,
    textLive: getTexter().channels,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    return Response.json(await state(session.shop));
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const b = (await readJson(request)) as Record<string, unknown>;
    if (b.action === "test-email") return Response.json({ result: await sendTestEmail(shop), ...(await state(shop)) });
    if (b.action === "test-message") return Response.json({ result: await sendTestMessage(shop), ...(await state(shop)) });
    if (b.action === "send-weekly") return Response.json({ result: await sendWeekly(shop, { force: true }), ...(await state(shop)) });
    await saveSettings(shop, b.settings);
    return Response.json(await state(shop));
  } catch (e) {
    return apiError(e);
  }
};
