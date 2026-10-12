// GET  /app/api/files                        the uploaded supplier sheet, if any
// POST /app/api/files?name=suppliers.xlsx    upload a sheet (raw body); replaces the previous one
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError, readBody } from "../.server/http";
import { currentSheet, saveSheet } from "../.server/files";
import { MAX_SHEET_BYTES } from "../.server/core/sheet";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    return Response.json({ file: await currentSheet(session.shop) });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const name = new URL(request.url).searchParams.get("name") || "";
    const data = await readBody(request, MAX_SHEET_BYTES);
    return Response.json({ file: await saveSheet(session.shop, name, data) }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
};
