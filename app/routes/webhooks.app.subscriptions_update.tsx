// app_subscriptions/update: the merchant chose, changed or cancelled a plan. The plan is read again from
// Shopify (an upgrade cancels the old subscription and activates the new one, in no fixed order).
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { setPlanFromSubscriptions, syncPlan } from "../.server/shops";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, admin } = await authenticate.webhook(request);
  if (admin) {
    await syncPlan(shop, (q) => admin.graphql(q));
  } else {
    // No session (the app was uninstalled): use what the webhook says
    const sub = (payload as { app_subscription?: { name?: string; status?: string } }).app_subscription;
    await setPlanFromSubscriptions(shop, sub ? [{ name: sub.name || "", status: String(sub.status || "").toUpperCase() }] : []);
  }
  return new Response();
};
