// GET  /app/api/jobs?command=sync|import   latest runs
// POST /app/api/jobs  { command: "sync", full? } | { command: "import-plan" | "import", options }
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError, readJson } from "../.server/http";
import { enqueueJob, listJobs, parseJobRequest } from "../.server/jobs/service";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const c = new URL(request.url).searchParams.get("command");
    const command = c === "sync" ? "sync" : c === "import" ? ["import", "import-plan"] : undefined;
    return Response.json({ jobs: await listJobs(session.shop, 20, command) });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const { command, options } = parseJobRequest(await readJson(request));
    const job = await enqueueJob(session.shop, command, options);
    return Response.json({ job: { id: job.id, status: job.status, command: job.command } }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
};
