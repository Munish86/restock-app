// GET  /app/api/variants?q=...   search variants (for purchase order lines and bundles)
// POST /app/api/variants         { action: "plan", variantIds, patch }        the merchant's own choices
//                                { action: "assign", variantIds, supplierId } supplier link (null = none)
//                                { action: "item", variantId, terms }         supplier SKU, cost, case pack...
//                                { action: "bundle", variantId, parts }       a bundle set up by hand
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError, readJson } from "../.server/http";
import { assignSupplier, InputError, searchVariants, setBundle, updateItem, updatePlans } from "../.server/suppliers";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const q = new URL(request.url).searchParams.get("q") || "";
    return Response.json({ variants: await searchVariants(session.shop, q) });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const b = (await readJson(request)) as Record<string, unknown>;
    switch (b.action) {
      case "plan":
        return Response.json({ updated: await updatePlans(shop, b.variantIds, b.patch) });
      case "assign":
        return Response.json({
          updated: await assignSupplier(shop, b.variantIds, typeof b.supplierId === "string" && b.supplierId ? b.supplierId : null),
        });
      case "item":
        if (typeof b.variantId !== "string") throw new InputError("Choose an item.");
        await updateItem(shop, b.variantId, b.terms);
        return Response.json({ ok: true });
      case "bundle":
        if (typeof b.variantId !== "string") throw new InputError("Choose the bundle.");
        await setBundle(shop, b.variantId, b.parts);
        return Response.json({ ok: true });
      default:
        throw new InputError("Unknown action.");
    }
  } catch (e) {
    return apiError(e);
  }
};
