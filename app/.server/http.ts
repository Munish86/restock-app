// Helpers for the app's JSON endpoints
import { UploadError } from "./files";
import { JobError } from "./jobs/service";
import { InputError } from "./suppliers";
import { SettingsError } from "../lib/settings";

// Known problems become a clear message for the merchant; anything else is logged and kept vague
export function apiError(e: unknown): Response {
  if (e instanceof Response) return e; // authenticate.admin redirects and 401s
  if (e instanceof UploadError || e instanceof JobError || e instanceof InputError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  if (e instanceof SettingsError) return Response.json({ error: e.message, problems: e.problems }, { status: 400 });
  console.error(e);
  return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

// Reads a request body, refusing more than `max` bytes without reading it all into memory first
export async function readBody(request: Request, max: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > max) throw new UploadError(`The file is larger than ${Math.round(max / 1024 / 1024)} MB.`, 413);
  if (!request.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new UploadError(`The file is larger than ${Math.round(max / 1024 / 1024)} MB.`, 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// JSON body of a POST, at most 2 MB
export async function readJson(request: Request): Promise<unknown> {
  const buf = await readBody(request, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new InputError("The request was not valid JSON.");
  }
}
