// Shopify and Google clients for one shop, usable both in requests and in the background worker.
import { apiVersion, unauthenticated } from "../shopify.server";
import { Google, type ServiceAccount } from "./core/google";
import { Shopify } from "./core/shopify";

const TOKEN_CACHE_MS = 5 * 60 * 1000;

// Uses the shop's offline session. unauthenticated.admin refreshes an expiring token when needed,
// so long-running jobs keep working.
export function shopifyFor(shop: string): Shopify {
  let cached: { token: string; at: number } | null = null;
  return new Shopify({
    shop,
    apiVersion,
    accessToken: async (refresh = false) => {
      if (!refresh && cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.token;
      const { session } = await unauthenticated.admin(shop);
      cached = { token: session.accessToken!, at: Date.now() };
      return cached.token;
    },
  });
}

let google: Google | null = null;

// One app-wide Google service account. Merchants share their sheet or Drive folder with its email.
// GOOGLE_SERVICE_ACCOUNT_JSON holds the whole JSON key file. Without it, only sheets shared as
// "Anyone with the link" can be read.
export function getGoogle(): Google {
  if (google) return google;
  let serviceAccount: ServiceAccount | null = null;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      serviceAccount = JSON.parse(raw);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file into it.");
    }
  }
  google = new Google({ serviceAccount, apiKey: process.env.GOOGLE_API_KEY });
  return google;
}
