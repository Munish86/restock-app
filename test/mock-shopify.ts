/* eslint-disable @typescript-eslint/no-explicit-any -- loose test data */
// A simulated Shopify Admin API for tests: store details, locations, bulk exports of variants and orders
// (JSONL with __parentId, like Shopify), and stock changes with idempotency keys.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockVariant {
  id: number;
  productId: number;
  productTitle: string;
  title: string;
  sku: string;
  price: string;
  cost: string | null;
  tracked?: boolean;
  status?: string;
  vendor?: string;
  createdAt: string;
  requiresComponents?: boolean;
  components?: { variantId: number; quantity: number }[];
  levels: Record<number, number>; // location id -> available
}

export interface MockOrder {
  id: number;
  createdAt: string;
  cancelled?: boolean;
  test?: boolean;
  lines: { variantId: number | null; quantity: number; price?: string }[];
}

export interface MockState {
  shop: { name: string; email: string; currencyCode: string; ianaTimezone: string; dev?: boolean };
  scopes: string[];
  locations: { id: number; name: string; isActive: boolean }[];
  variants: MockVariant[];
  orders: MockOrder[];
}

export async function startMock(state: MockState) {
  const calls: { query: string; variables: any }[] = [];
  const bulks = new Map<string, string>();
  const adjustKeys = new Set<string>();
  const adjustments: { key: string; reason: string; reference: string; changes: any[] }[] = [];
  const costs = new Map<string, number>();
  let nextBulk = 1;

  const vgid = (id: number) => `gid://shopify/ProductVariant/${id}`;
  const igid = (id: number) => `gid://shopify/InventoryItem/${id}`;
  const lgid = (id: number) => `gid://shopify/Location/${id}`;

  function variantsJsonl(): string {
    const out: string[] = [];
    for (const v of state.variants) {
      out.push(
        JSON.stringify({
          id: vgid(v.id),
          title: v.title,
          sku: v.sku,
          barcode: null,
          price: v.price,
          requiresComponents: !!v.requiresComponents,
          product: {
            id: `gid://shopify/Product/${v.productId}`,
            title: v.productTitle,
            vendor: v.vendor ?? "Acme",
            productType: "",
            status: v.status ?? "ACTIVE",
            createdAt: v.createdAt,
            featuredMedia: null,
          },
          inventoryItem: { id: igid(v.id), tracked: v.tracked !== false, unitCost: v.cost == null ? null : { amount: v.cost } },
        }),
      );
      for (const [loc, available] of Object.entries(v.levels)) {
        out.push(
          JSON.stringify({
            location: { id: lgid(Number(loc)) },
            quantities: [
              { name: "available", quantity: available },
              { name: "on_hand", quantity: available },
              { name: "incoming", quantity: 0 },
            ],
            __parentId: vgid(v.id),
          }),
        );
      }
      for (const c of v.components ?? []) {
        out.push(JSON.stringify({ quantity: c.quantity, productVariant: { id: vgid(c.variantId) }, __parentId: vgid(v.id) }));
      }
    }
    return out.join("\n") + "\n";
  }

  function ordersJsonl(query: string): string {
    const from = (query.match(/created_at:>='([^']+)'/) || [])[1];
    const out: string[] = [];
    for (const o of state.orders) {
      if (from && o.createdAt < from) continue;
      const id = `gid://shopify/Order/${o.id}`;
      out.push(JSON.stringify({ id, createdAt: o.createdAt, cancelledAt: o.cancelled ? o.createdAt : null, test: !!o.test }));
      for (const l of o.lines) {
        out.push(
          JSON.stringify({
            currentQuantity: l.quantity,
            variant: l.variantId == null ? null : { id: vgid(l.variantId) },
            originalUnitPriceSet: { shopMoney: { amount: l.price ?? "10.00" } },
            __parentId: id,
          }),
        );
      }
    }
    return out.join("\n");
  }

  const handle = (query: string, variables: any): any => {
    if (query.includes("bulkOperationRunQuery")) {
      const id = `gid://shopify/BulkOperation/${nextBulk++}`;
      bulks.set(id, variables.q.includes("productVariants") ? variantsJsonl() : ordersJsonl(variables.q));
      return { data: { bulkOperationRunQuery: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } } };
    }
    if (query.includes("bulkOperation(id")) {
      const body = bulks.get(variables.id);
      return {
        data: {
          bulkOperation: {
            status: "COMPLETED",
            url: body ? `${base}/bulk/${encodeURIComponent(variables.id)}` : null,
            partialDataUrl: null,
            errorCode: null,
            objectCount: String(body?.split("\n").length ?? 0),
          },
        },
      };
    }
    if (query.includes("partnerDevelopment")) return { data: { shop: { plan: { partnerDevelopment: !!state.shop.dev } } } };
    if (query.includes("shop {")) return { data: { shop: { ...state.shop, contactEmail: state.shop.email, myshopifyDomain: "test.myshopify.com" } } };
    if (query.includes("accessScopes")) return { data: { currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) } } };
    if (query.includes("locations(")) {
      return {
        data: { locations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.locations.map((l) => ({ id: lgid(l.id), name: l.name, isActive: l.isActive })) } },
      };
    }
    if (query.includes("inventoryAdjustQuantities")) {
      if (!/@idempotent\(key: \$key\)/.test(query)) return { errors: [{ message: "@idempotent directive is required" }] };
      const input = variables.input;
      for (const c of input.changes) {
        if (!("changeFromQuantity" in c)) return { errors: [{ message: "changeFromQuantity is required" }] };
      }
      if (!adjustKeys.has(variables.key)) {
        adjustKeys.add(variables.key);
        adjustments.push({ key: variables.key, reason: input.reason, reference: input.referenceDocumentUri, changes: input.changes });
        for (const c of input.changes) {
          const v = state.variants.find((x) => igid(x.id) === c.inventoryItemId)!;
          const loc = Number(String(c.locationId).split("/").pop());
          v.levels[loc] = (v.levels[loc] ?? 0) + c.delta;
        }
      }
      return { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [] } } };
    }
    if (query.includes("inventoryItemUpdate")) {
      costs.set(variables.id, variables.input.cost);
      return { data: { inventoryItemUpdate: { userErrors: [] } } };
    }
    return { errors: [{ message: `Mock does not know this query: ${query.slice(0, 80)}` }] };
  };

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/bulk/")) {
      const id = decodeURIComponent(req.url.slice(6));
      res.writeHead(200, { "content-type": "application/jsonl" });
      res.end(bulks.get(id) ?? "");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { query, variables } = JSON.parse(body);
      calls.push({ query, variables });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handle(query, variables || {})));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint: `${base}/graphql`,
    calls,
    adjustments,
    costs,
    state,
    level: (variantId: number, loc: number) => state.variants.find((v) => v.id === variantId)!.levels[loc] ?? 0,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
