import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordUninstall } from "../.server/shops";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can arrive more than once and after the app was already uninstalled,
  // so this must be safe to run again. The shop's files and data are deleted later, on shop/redact.
  await recordUninstall(shop);

  return new Response();
};
