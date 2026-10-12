import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../.server/shops";

// Mandatory privacy webhooks for App Store apps. authenticate.webhook checks the HMAC signature
// and answers 401 to anything not sent by Shopify.
// See https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // The app reads only order dates and line items (which variant, how many) and keeps daily totals per
      // variant. It never reads or stores customer names, addresses, emails or order ids, so there is nothing
      // about a customer to send or delete.
      break;
    case "SHOP_REDACT":
      await deleteShopData(shop);
      break;
  }

  return new Response();
};
