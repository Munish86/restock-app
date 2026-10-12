// Shop records: created on install, settings saved per shop, the plan read from Shopify, and everything
// removed on shop/redact.
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { planKeyFromName } from "../lib/plans";
import { cleanSettings, withDefaults, type Settings } from "../lib/settings";
import { getStorage, shopPrefix } from "./storage";

// Called after every successful OAuth (install and re-install)
export async function recordInstall(shop: string) {
  await prisma.shop.upsert({
    where: { shop },
    create: { shop },
    update: { uninstalledAt: null },
  });
}

export interface Subscription {
  name: string;
  status: string;
  test?: boolean;
}

// The plan follows the store's active Shopify subscription (Managed Pricing); none = Free
export async function setPlanFromSubscriptions(shop: string, subs: Subscription[]) {
  const active = subs.find((s) => s.status === "ACTIVE");
  const plan = planKeyFromName(active?.name);
  await prisma.shop.updateMany({ where: { shop }, data: { plan, planCheckedAt: new Date() } });
  return plan;
}

// The subscription as Shopify reports it now. `graphql` is the admin client of the request.
export async function syncPlan(shop: string, graphql: (q: string) => Promise<Response>) {
  const res = await graphql(`#graphql
    query activeSubscriptions { currentAppInstallation { activeSubscriptions { name status test } } }`);
  const { data } = await res.json();
  return setPlanFromSubscriptions(shop, data?.currentAppInstallation?.activeSubscriptions ?? []);
}

export async function recordUninstall(shop: string) {
  await prisma.session.deleteMany({ where: { shop } });
  // Shopify cancels the subscription on uninstall; a re-install starts on Free until a plan is chosen
  await prisma.shop.updateMany({ where: { shop }, data: { uninstalledAt: new Date(), plan: "free" } });
  await prisma.job.updateMany({
    where: { shop, status: { in: ["queued", "running"] } },
    data: { status: "stopped", stopAsked: true, error: "The app was uninstalled." },
  });
}

export async function getSettings(shop: string): Promise<Settings> {
  const row = await prisma.shop.findUnique({ where: { shop }, select: { settings: true } });
  return withDefaults(row?.settings);
}

export async function saveSettings(shop: string, raw: unknown): Promise<Settings> {
  const settings = cleanSettings(raw);
  await prisma.shop.update({ where: { shop }, data: { settings: settings as unknown as Prisma.InputJsonValue } });
  return settings;
}

// shop/redact: Shopify asks us to delete everything about a store 48 hours after it uninstalls the app.
// Rows in other tables go with the Shop row (onDelete: Cascade).
export async function deleteShopData(shop: string) {
  await getStorage().deletePrefix(shopPrefix(shop));
  await prisma.session.deleteMany({ where: { shop } });
  await prisma.shop.deleteMany({ where: { shop } });
}
