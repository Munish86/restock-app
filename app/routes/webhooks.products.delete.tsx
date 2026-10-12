// products/delete: the product's variants leave the reorder list at once (purchase orders keep their lines)
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const id = (payload as { id?: number | string }).id;
  if (id != null) {
    await prisma.variant.updateMany({
      where: { shop, productId: `gid://shopify/Product/${id}`, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
  return new Response();
};
