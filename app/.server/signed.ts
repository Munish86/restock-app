// Signed links for things opened without the app's session token: downloads (<a href> inside the Admin iframe),
// the printable purchase order, and the "stop these emails" link in alert emails. The signature covers the
// kind, the shop, the id and the expiry, so a link cannot be changed to point at another store's data.
import crypto from "node:crypto";

export type SignedKind =
  | "po-pdf" // a purchase order as PDF
  | "po-csv" // ... as CSV
  | "po-print" // ... as a printable page
  | "reorder-csv" // the reorder list (id = "all" or a status filter)
  | "dead-csv" // the dead stock list
  | "report-csv" // a supplier import report (id = job id)
  | "alerts-off"; // turn off an alert email (id = weekly | low-stock)

const secret = () => {
  const s = process.env.SHOPIFY_API_SECRET;
  if (!s) throw new Error("SHOPIFY_API_SECRET is not set");
  return s;
};

const mac = (kind: string, shop: string, id: string, exp: number) =>
  crypto.createHmac("sha256", secret()).update(`${kind}\n${shop}\n${id}\n${exp}`).digest("base64url");

export function signedUrl(kind: SignedKind, shop: string, id: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const q = new URLSearchParams({ shop, exp: String(exp), sig: mac(kind, shop, id, exp) });
  return `/dl/${kind}/${encodeURIComponent(id)}?${q}`;
}

// The same link with the app's own address in front, for emails
export function absoluteSignedUrl(kind: SignedKind, shop: string, id: string, ttlSeconds: number): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  return base + signedUrl(kind, shop, id, ttlSeconds);
}

// Returns the shop the link was made for, or null if it is forged or expired
export function verifySigned(kind: string, id: string, params: URLSearchParams): string | null {
  const shop = params.get("shop") || "";
  const exp = Number(params.get("exp"));
  const sig = params.get("sig") || "";
  if (!shop || !Number.isInteger(exp) || exp < Date.now() / 1000) return null;
  const want = Buffer.from(mac(kind, shop, id, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? shop : null;
}
