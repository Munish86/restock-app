// inventory_levels/update: keeps the app's stock figures live between syncs. The payload only has
// "available"; on-hand and incoming are refreshed by the next sync.
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const p = payload as { inventory_item_id?: number | string; location_id?: number | string; available?: number | null };
  if (p.inventory_item_id == null || p.location_id == null) return new Response();
  const inventoryItemId = `gid://shopify/InventoryItem/${p.inventory_item_id}`;
  const locationId = `gid://shopify/Location/${p.location_id}`;
  const available = Number(p.available ?? 0) || 0;
  const known = await prisma.shop.count({ where: { shop, uninstalledAt: null } });
  if (!known) return new Response();
  // Webhooks can arrive late and out of order; the 6-hourly sync corrects any stale value
  await prisma.inventoryLevel.upsert({
    where: { shop_inventoryItemId_locationId: { shop, inventoryItemId, locationId } },
    create: { shop, inventoryItemId, locationId, available },
    update: { available },
  });
  return new Response();
};
