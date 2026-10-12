// GET  /app/api/purchase-orders?status=open|draft|sent|partial|received|cancelled|all&supplier=<id>
// POST /app/api/purchase-orders  { action: "from-suggestions", items: [{ variantId, quantity }], mergeDrafts }
//                                { action: "create", supplierId }
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { apiError, readJson } from "../.server/http";
import { createEmpty, createFromSuggestions, listPos } from "../.server/purchase-orders";
import { InputError } from "../.server/suppliers";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const q = new URL(request.url).searchParams;
    const [orders, suppliers] = await Promise.all([
      listPos(session.shop, { status: q.get("status") || "all", supplierId: q.get("supplier") || undefined }),
      prisma.supplier.findMany({ where: { shop: session.shop }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    return Response.json({ orders, suppliers });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const b = (await readJson(request)) as Record<string, unknown>;
    if (b.action === "from-suggestions") return Response.json({ created: await createFromSuggestions(session.shop, b) }, { status: 201 });
    if (b.action === "create") {
      const po = await createEmpty(session.shop, b.supplierId);
      return Response.json({ id: po.id }, { status: 201 });
    }
    throw new InputError("Unknown action.");
  } catch (e) {
    return apiError(e);
  }
};
