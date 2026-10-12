// GET  /app/api/purchase-orders/:id   the order, its lines and receipts, and signed download links
// POST /app/api/purchase-orders/:id   { action, ... }:
//   save { supplierId?, locationId?, expectedAt?, shippingCost?, notes?, currency?, lines? }
//   send { to?, cc?, message? }     email the PDF and CSV to the supplier (marks it sent)
//   mark-sent | back-to-draft | cancel | close | reopen | delete
//   receive { lines: [{ lineId, quantity }], updateCost? } | receive-all { updateCost? }
//   retry-receipt { receiptId } | undo-receipt { receiptId }
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { apiError, readJson } from "../.server/http";
import { applyReceipt, createReceipt, createUndo, deletePo, getPo, receiveAllLines, savePo, setStatus } from "../.server/purchase-orders";
import { emailPo } from "../.server/alerts";
import { shopifyFor } from "../.server/clients";
import { signedUrl } from "../.server/signed";
import { InputError } from "../.server/suppliers";
import { withDefaults } from "../lib/settings";

async function detail(shop: string, id: string) {
  const po = await getPo(shop, id);
  if (!po) throw new InputError("Purchase order not found.", 404);
  const [locations, suppliers, shopRow] = await Promise.all([
    prisma.location.findMany({ where: { shop, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ where: { shop }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.shop.findUnique({ where: { shop }, select: { settings: true } }),
  ]);
  return {
    po,
    locations,
    suppliers,
    updateCostOnReceive: withDefaults(shopRow?.settings).po.updateCostOnReceive,
    links: {
      pdf: signedUrl("po-pdf", shop, id),
      csv: signedUrl("po-csv", shop, id),
      print: signedUrl("po-print", shop, id),
    },
  };
}

const optional = (v: unknown) => (typeof v === "string" ? v : undefined);

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    return Response.json(await detail(session.shop, params.id!));
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const id = params.id!;
    const b = (await readJson(request)) as Record<string, unknown>;
    let extra: Record<string, unknown> = {};
    switch (b.action) {
      case "save":
        await savePo(shop, id, b);
        break;
      case "send":
        extra = { sent: await emailPo(shop, id, { to: optional(b.to), cc: optional(b.cc), message: optional(b.message) }) };
        break;
      case "mark-sent":
      case "back-to-draft":
      case "cancel":
      case "close":
      case "reopen":
        await setStatus(shop, id, b.action);
        break;
      case "delete":
        await deletePo(shop, id);
        return Response.json({ deleted: true });
      case "receive":
      case "receive-all": {
        const lines = b.action === "receive-all" ? await receiveAllLines(shop, id) : b.lines;
        const receipt = await createReceipt(shop, id, { lines, updateCost: b.updateCost === true });
        const done = await applyReceipt(shop, receipt.id, shopifyFor(shop));
        extra = { warnings: done.warnings };
        break;
      }
      case "retry-receipt":
      case "undo-receipt": {
        const rid = String(b.receiptId ?? "");
        const r = b.action === "undo-receipt" ? await createUndo(shop, rid) : { id: rid };
        const done = await applyReceipt(shop, r.id, shopifyFor(shop));
        extra = { warnings: done.warnings };
        break;
      }
      default:
        throw new InputError("Unknown action.");
    }
    return Response.json({ ...(await detail(shop, id)), ...extra });
  } catch (e) {
    return apiError(e);
  }
};
