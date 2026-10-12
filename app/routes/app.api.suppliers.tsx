// GET  /app/api/suppliers   suppliers with item and open-order counts
// POST /app/api/suppliers   { action: "create", supplier } | { action: "update", id, supplier }
//                           { action: "delete", id } | { action: "from-vendors" }
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { apiError, readJson } from "../.server/http";
import { createSupplier, deleteSupplier, InputError, listSuppliers, suppliersFromVendors, updateSupplier } from "../.server/suppliers";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const [suppliers, unassigned, vendorsWithout] = await Promise.all([
      listSuppliers(shop),
      prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM "Variant" v
        WHERE v."shop" = ${shop} AND v."deletedAt" IS NULL AND v."isBundle" = false AND v."status" = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM "SupplierItem" i WHERE i."shop" = v."shop" AND i."variantId" = v."id")`,
      prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(DISTINCT v."vendor") AS n FROM "Variant" v
        WHERE v."shop" = ${shop} AND v."deletedAt" IS NULL AND v."vendor" <> ''
          AND NOT EXISTS (SELECT 1 FROM "SupplierItem" i WHERE i."shop" = v."shop" AND i."variantId" = v."id")`,
    ]);
    return Response.json({ suppliers, unassigned: Number(unassigned[0]?.n ?? 0), vendorsWithout: Number(vendorsWithout[0]?.n ?? 0) });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const b = (await readJson(request)) as Record<string, unknown>;
    const id = typeof b.id === "string" ? b.id : "";
    switch (b.action) {
      case "create":
        return Response.json({ supplier: await createSupplier(shop, b.supplier) }, { status: 201 });
      case "update":
        await updateSupplier(shop, id, b.supplier);
        return Response.json({ ok: true });
      case "delete":
        await deleteSupplier(shop, id);
        return Response.json({ ok: true });
      case "from-vendors":
        return Response.json(await suppliersFromVendors(shop));
      default:
        throw new InputError("Unknown action.");
    }
  } catch (e) {
    return apiError(e);
  }
};
