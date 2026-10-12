// GET  /app/api/jobs/:id             status, progress, counts and log
// GET  /app/api/jobs/:id?report=json  an import's report rows
// POST /app/api/jobs/:id  { stop: true }
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError, readJson } from "../.server/http";
import { getJob, JobError, readReport, requestStop } from "../.server/jobs/service";
import type { ImportReport } from "../.server/imports";
import { signedUrl } from "../.server/signed";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const id = params.id!;
    if (new URL(request.url).searchParams.get("report") === "json") {
      const report = await readReport<ImportReport>(session.shop, id);
      if (!report) throw new JobError("This report is no longer available.", 404);
      return Response.json({ ...report, csvUrl: signedUrl("report-csv", session.shop, id) });
    }
    const job = await getJob(session.shop, id, { withLog: true });
    if (!job) throw new JobError("Run not found.", 404);
    return Response.json({ job });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const b = (await readJson(request)) as { stop?: boolean };
    if (b.stop !== true) throw new JobError("Nothing to do.");
    const stopping = await requestStop(session.shop, params.id!);
    return Response.json({ stopping });
  } catch (e) {
    return apiError(e);
  }
};
