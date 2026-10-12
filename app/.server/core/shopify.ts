/* eslint-disable @typescript-eslint/no-explicit-any -- raw Admin API JSON, shaped by each query */
// Shopify Admin GraphQL calls used by Restock, with retries and rate-limit handling.
import { sleep } from "./util";

class GraphqlError extends Error {
  constructor(
    message: string,
    public graphqlErrors: { message: string; extensions?: { code?: string } }[],
  ) {
    super(message);
  }
}

export interface ShopInfo {
  name: string;
  email: string;
  contactEmail: string;
  currencyCode: string;
  ianaTimezone: string;
  myshopifyDomain: string;
}

export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
}

export interface BulkResult {
  status: string;
  url: string | null;
  partialDataUrl: string | null;
  errorCode: string | null;
  objectCount: number;
}

export interface StockChange {
  inventoryItemId: string;
  locationId: string;
  delta: number;
}

export interface ShopifyClientOptions {
  shop: string; // "my-store.myshopify.com"
  apiVersion: string;
  // Returns a valid offline access token. Called again with refresh = true after a 401.
  accessToken: (refresh?: boolean) => Promise<string>;
  endpoint?: string; // tests point this at a simulated store
}

// Inventory changes made by the app point back at the purchase order in the store's inventory history
export const poReference = (poId: string) => `gid://restock-app/PurchaseOrder/${poId}`;
// Shopify's own limit is not documented; forum reports put it near 250. Stay well under it.
export const STOCK_CHANGES_PER_CALL = 100;

export class Shopify {
  readonly shop: string;
  private endpoint: string;
  private getToken: ShopifyClientOptions["accessToken"];
  adminBase: string;

  constructor(opts: ShopifyClientOptions) {
    this.shop = opts.shop;
    this.getToken = opts.accessToken;
    this.endpoint = opts.endpoint || `https://${opts.shop}/admin/api/${opts.apiVersion}/graphql.json`;
    this.adminBase = `https://admin.shopify.com/store/${opts.shop.replace(".myshopify.com", "")}`;
  }

  async gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shopify-access-token": await this.getToken(),
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        if (attempt < 5) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw e;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && !refreshed) {
        // The offline token may have expired: get a fresh one and try again
        refreshed = true;
        await this.getToken(true);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Shopify refused the request (${res.status}). The app may have been uninstalled, or is missing a permission. Open the app again from Shopify Admin.`,
        );
      }
      if (res.status === 402) throw new Error("This store is frozen or unpaid (402), so Shopify does not accept requests.");
      if (res.status === 404) throw new Error(`Shopify store not found (404): ${this.shop}`);
      const body = await res.json();
      if (body.errors) {
        const throttled = body.errors.some?.((e: { extensions?: { code?: string } }) => e.extensions?.code === "THROTTLED");
        if (throttled && attempt < 10) {
          await sleep(2000);
          continue;
        }
        throw new GraphqlError(`Shopify error: ${JSON.stringify(body.errors).slice(0, 600)}`, body.errors);
      }
      const t = body.extensions?.cost?.throttleStatus;
      if (t && t.currentlyAvailable < 300) await sleep(((300 - t.currentlyAvailable) / (t.restoreRate || 50)) * 1000);
      return body.data;
    }
  }

  async shopInfo(): Promise<ShopInfo> {
    const d = await this.gql(`{ shop { name email contactEmail currencyCode ianaTimezone myshopifyDomain } }`);
    return d.shop;
  }

  // Which permissions the app has. Returns null if Shopify does not say.
  async scopes(): Promise<string[] | null> {
    try {
      const d = await this.gql("{ currentAppInstallation { accessScopes { handle } } }");
      return d.currentAppInstallation.accessScopes.map((s: { handle: string }) => s.handle);
    } catch {
      return null;
    }
  }

  async locations(): Promise<ShopifyLocation[]> {
    const out: ShopifyLocation[] = [];
    let after: string | null = null;
    do {
      const d: any = await this.gql(
        `query($after: String) { locations(first: 250, after: $after, includeInactive: true) {
           pageInfo { hasNextPage endCursor } nodes { id name isActive } } }`,
        { after },
      );
      out.push(...d.locations.nodes);
      after = d.locations.pageInfo.hasNextPage ? d.locations.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  adminProductUrl(productGid: string): string {
    return `${this.adminBase}/products/${String(productGid).split("/").pop()}`;
  }

  // ---- Bulk operations: large reads (all variants, a year of orders) run on Shopify's side ----

  async startBulkQuery(query: string): Promise<string> {
    const d = await this.gql(
      `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`,
      { q: query },
    );
    const r = d.bulkOperationRunQuery;
    if (r.userErrors?.length) throw new Error(`Shopify did not start the export: ${r.userErrors.map((e: any) => e.message).join("; ")}`);
    return r.bulkOperation.id;
  }

  async bulkStatus(id: string): Promise<BulkResult> {
    const d = await this.gql(
      `query($id: ID!) { bulkOperation(id: $id) { status url partialDataUrl errorCode objectCount } }`,
      { id },
    );
    const b = d.bulkOperation;
    if (!b) throw new Error("Shopify lost track of the export. Run the sync again.");
    return { ...b, objectCount: Number(b.objectCount || 0) };
  }

  async cancelBulk(id: string): Promise<void> {
    await this.gql(`mutation($id: ID!) { bulkOperationCancel(id: $id) { userErrors { message } } }`, { id }).catch(() => {});
  }

  // Starts a bulk query and waits for it. Returns the result file's URL, or null when nothing matched.
  // onWait is called on every poll (progress, and to stop when asked).
  async runBulkQuery(
    query: string,
    opts: { pollMs?: number; timeoutMs?: number; onWait?: (objects: number) => boolean | void } = {},
  ): Promise<string | null> {
    const id = await this.startBulkQuery(query);
    const started = Date.now();
    const pollMs = opts.pollMs ?? 3000;
    for (;;) {
      const s = await this.bulkStatus(id);
      if (s.status === "COMPLETED") return s.url;
      if (s.status === "FAILED" || s.status === "CANCELED" || s.status === "CANCELING") {
        throw new Error(
          s.errorCode === "ACCESS_DENIED"
            ? "Shopify denied access to this data. Open the app again from Shopify Admin to approve the permissions."
            : `Shopify's export ${s.status.toLowerCase()}${s.errorCode ? ` (${s.errorCode})` : ""}. Run the sync again.`,
        );
      }
      if (opts.onWait?.(s.objectCount) === false) {
        await this.cancelBulk(id);
        throw new StopRequested();
      }
      if (Date.now() - started > (opts.timeoutMs ?? 3 * 60 * 60 * 1000)) {
        await this.cancelBulk(id);
        throw new Error("Shopify's export took too long. Run the sync again later.");
      }
      await sleep(pollMs);
    }
  }

  // ---- Stock ----

  // Adds (or removes) stock. `key` makes the call safe to retry: Shopify applies one key only once.
  async adjustStock(changes: StockChange[], opts: { key: string; reason: "received" | "correction"; reference: string }) {
    if (!changes.length) return;
    if (changes.length > STOCK_CHANGES_PER_CALL) throw new Error(`At most ${STOCK_CHANGES_PER_CALL} stock changes per call.`);
    const d = await this.gql(
      `mutation($input: InventoryAdjustQuantitiesInput!, $key: String!) {
         inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
           inventoryAdjustmentGroup { id } userErrors { field message code } } }`,
      {
        key: opts.key,
        input: {
          name: "available",
          reason: opts.reason,
          referenceDocumentUri: opts.reference,
          // changeFromQuantity must be sent; null = add to whatever is there now
          changes: changes.map((c) => ({ ...c, changeFromQuantity: null })),
        },
      },
    );
    const errs = d.inventoryAdjustQuantities.userErrors;
    if (errs?.length) throw new Error(`Shopify did not change the stock: ${errs.map((e: any) => e.message).join("; ")}`);
  }

  // Sets Shopify's "cost per item" (in the store's currency)
  async setUnitCost(inventoryItemId: string, cost: number): Promise<void> {
    const d = await this.gql(
      `mutation($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) { userErrors { field message } } }`,
      { id: inventoryItemId, input: { cost: Number(cost.toFixed(4)) } },
    );
    const errs = d.inventoryItemUpdate.userErrors;
    if (errs?.length) throw new Error(`Cost not saved: ${errs.map((e: any) => e.message).join("; ")}`);
  }

  // Current available stock of some items at one location (to show before receiving, and for tests)
  async availableAt(inventoryItemIds: string[], locationId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < inventoryItemIds.length; i += 50) {
      const ids = inventoryItemIds.slice(i, i + 50);
      const d = await this.gql(
        `query($ids: [ID!]!, $loc: ID!) { nodes(ids: $ids) { ... on InventoryItem { id
           inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } } }`,
        { ids, loc: locationId },
      );
      for (const n of d.nodes) {
        if (n?.id) out.set(n.id, n.inventoryLevel?.quantities?.[0]?.quantity ?? 0);
      }
    }
    return out;
  }
}

export class StopRequested extends Error {
  constructor() {
    super("Stopped.");
  }
}

// Reads a bulk operation's JSONL result line by line, without holding the whole file in memory
export async function* readJsonl(url: string): AsyncGenerator<any> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (res.ok) break;
    } catch {
      /* retried below */
    }
    await sleep(1000 * 2 ** attempt);
  }
  if (!res?.ok || !res.body) throw new Error("Could not download Shopify's export. Run the sync again.");
  const decoder = new TextDecoder();
  let buf = "";
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
    if (done) break;
  }
  if (buf.trim()) yield JSON.parse(buf.trim());
}
