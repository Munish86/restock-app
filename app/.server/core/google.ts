import crypto from "node:crypto";
import { sleep } from "./util";

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const SCOPES =
  "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

// Reads Google Drive / Sheets with the app's service account. Read-only access.
// Merchants share their sheet or Drive folder with the service account's email.
export class Google {
  private sa: ServiceAccount | null;
  private apiKey: string;
  private tok: { value: string; exp: number } | null = null;

  constructor(cfg: { serviceAccount?: ServiceAccount | null; apiKey?: string } = {}) {
    this.sa = cfg.serviceAccount || null;
    this.apiKey = cfg.apiKey || "";
  }

  get enabled(): boolean {
    return !!(this.sa || this.apiKey);
  }

  // The email merchants share their sheet / folder with
  get email(): string {
    return this.sa?.client_email || "";
  }

  private async token(): Promise<string | null> {
    if (!this.sa) return null;
    if (this.tok && this.tok.exp > Date.now() + 60_000) return this.tok.value;
    const aud = this.sa.token_uri || "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64url(
      JSON.stringify({ iss: this.sa.client_email, scope: SCOPES, aud, iat: now, exp: now + 3600 }),
    );
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${head}.${claim}`);
    const sig = signer.sign(this.sa.private_key).toString("base64url");
    const res = await fetch(aud, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${head}.${claim}.${sig}`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Google sign-in failed: ${JSON.stringify(body)}`);
    this.tok = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
    return this.tok.value;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers describe the JSON they read
  async get<T = any>(url: string): Promise<T> {
    const res = await this.request(url);
    return res.json() as Promise<T>;
  }

  async getBuffer(url: string): Promise<Buffer> {
    const res = await this.request(url);
    return Buffer.from(await res.arrayBuffer());
  }

  private async request(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const u = new URL(url);
      const headers: Record<string, string> = {};
      const t = await this.token();
      if (t) headers.authorization = `Bearer ${t}`;
      else if (this.apiKey) u.searchParams.set("key", this.apiKey);
      const res = await fetch(u, { headers, signal: AbortSignal.timeout(120_000) });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 400);
        let hint = "";
        if (res.status === 403 || res.status === 404) {
          hint = this.sa
            ? `\nHave you shared the Drive folder / Sheet with this email? ${this.sa.client_email}`
            : '\nThe folder / Sheet must be shared as "Anyone with the link".';
        }
        throw new Error(`Google API error ${res.status}: ${text}${hint}`);
      }
      return res;
    }
  }
}

// Google IDs are letters, digits, "-" and "_". Anything else is not a link we can use, and must never
// reach a request URL (the input comes from merchants).
function checkId(id: string, what: string): string {
  if (!/^[\w-]{10,200}$/.test(id)) throw new Error(`That does not look like a Google ${what} link.`);
  return id;
}

// Accepts a full link or a bare ID
export function driveFolderId(ref: string): string {
  const m = String(ref).match(/folders\/([\w-]+)/) || String(ref).match(/[?&]id=([\w-]+)/);
  return checkId(m ? m[1] : String(ref).trim(), "Drive folder");
}

export function sheetRef(ref: string): { id: string; gid: string } {
  const s = String(ref);
  const id = (s.match(/\/d\/([\w-]+)/) || [])[1] || s.trim();
  const gid = (s.match(/[#&?]gid=(\d+)/) || [])[1] || "";
  return { id: checkId(id, "Sheet"), gid };
}
