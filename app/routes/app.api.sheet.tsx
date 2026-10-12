// GET /app/api/sheet?source=file|google&fileId=&url=&worksheet=&headerRow=
// A sheet's column names, tabs, row count and first rows, read the same way an import reads it, plus the
// columns the app recognised. { error } when it cannot be read.
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError } from "../.server/http";
import { listWorksheets, loadRows } from "../.server/core/sheet";
import { sheetSourceFor } from "../.server/files";
import { getGoogle } from "../.server/clients";
import { autoMapColumns } from "../lib/import-columns";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const q = new URL(request.url).searchParams;
    const source = q.get("source") === "google" ? "google" : "file";
    try {
      const google = getGoogle();
      const src = await sheetSourceFor(session.shop, { source, fileId: q.get("fileId") || undefined, url: q.get("url") || undefined });
      const { headers, rows, headerRow } = await loadRows(src, { worksheet: q.get("worksheet") || "", header_row: Number(q.get("headerRow")) || "" }, google);
      const worksheets = await listWorksheets(src, google).catch(() => []);
      const named = headers.filter(Boolean);
      return Response.json({
        sheet: {
          name: src.kind === "file" ? src.name : "Google Sheet",
          worksheets,
          headers: named,
          headerRow,
          rowCount: rows.length,
          preview: rows.slice(0, 5),
          suggested: autoMapColumns(named),
        },
      });
    } catch (e) {
      return Response.json({ sheet: null, error: (e as Error).message });
    }
  } catch (e) {
    return apiError(e);
  }
};
