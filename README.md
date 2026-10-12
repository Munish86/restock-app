# Restock (Shopify app)

Stock forecasting and purchase orders for Shopify stores. "Know what to reorder this week, in 5 minutes."

- **Reorder list**: for every variant, sales per day (recent weeks count more, out-of-stock days left out), days of
  stock left, stock-out date and the quantity to order, each with a one-line "why". Every number can be overridden.
- **Purchase orders**: made from the reorder list (one per supplier), edited, emailed to the supplier as PDF + CSV,
  printed, and received in full or in part, which adds the stock in Shopify. Receipts can be undone.
- **Suppliers**: from product vendors in one click, or imported from a sheet (Excel, CSV, Google Sheets; Stocky and
  Shopify exports work); supplier SKU, cost, case pack, minimum order and lead time per item.
- **Bundles**: Shopify bundle components are read automatically, others can be set up by hand; bundle sales count
  against their parts.
- **Dead stock**: items not selling, and the money in them.
- **Emails**: a weekly "order these items" email and a daily low-stock alert (each item once per episode). No marketing.
- **Seasonal forecasts** (Growth and Pro): last year's sales raise or lower the forecast for the coming weeks.

Built on the same base as the Bulk Product Uploader (`../shopify-bulk-uploader-app`): Shopify's React Router template,
Polaris web components, Prisma/PostgreSQL, BullMQ worker, R2 storage, Managed Pricing. The plan and market research
are in `../NEXT-APP-IDEA.md`. Status and decisions: `docs/PROGRESS.md`.

## How the forecast works

`app/lib/forecast.ts` (pure, tested in `test/forecast.test.ts`):

```
sales per day   = weighted average of the last N weeks (each week back counts 0.85x the week after it),
                  per week: units / days in stock; weeks with under 2 days in stock are skipped
seasonal        = (Growth/Pro, a year of history) last year's coming weeks vs the weeks before, 0.5x to 3x
suggested       = (lead time + days to cover) x rate + safety days x rate - in stock - on order (- incoming)
                  rounded up to the case pack, then to the minimum order
status          = out of stock | order now (stock + on order <= lead time + safety) | order soon (within 14 days) |
                  OK | overstock | no recent sales | not reordered | bundle
```

Bundle sales are added to their parts (quantity x bundle units) before the rate is worked out.

## Project layout

```
app/
  lib/                forecast.ts, dates.ts, settings.ts, plans.ts, import-columns.ts (shared with the browser)
  .server/
    core/             shopify.ts (Admin API, bulk exports, stock changes), sheet.ts, google.ts, util.ts
    sync.ts           bulk export of variants/stock/bundles and orders -> Variant, InventoryLevel, SalesDay
    planning.ts       weekly sales in SQL + forecast per variant; dead stock; totals
    suppliers.ts      suppliers, supplier links and terms, per-variant choices, bundles by hand
    purchase-orders.ts create/edit/status, receipts (idempotent stock changes), documents
    imports.ts        supplier sheet import (preview + apply) as a job
    alerts.ts         weekly email, low-stock alert, emailing a purchase order, due-time scheduling
    email.ts pdf.ts   Resend mailer, a small PDF writer for purchase orders
    scheduler.ts      every minute: due syncs and alert emails
    jobs/             queue (BullMQ or in-process), processJob, job service and housekeeping
  routes/             pages (app.*), JSON endpoints (app.api.*), webhooks, signed downloads (dl.*)
  components/restock/ the pages: ReorderList, RowDetail, PurchaseOrders, PurchaseOrderEditor, Suppliers,
                      SupplierImport, DeadStock, SettingsForm
worker.ts             background worker (jobs + scheduler)
prisma/               schema and migrations
test/                 unit tests, full flow against PGlite (real Postgres in WebAssembly) + a simulated
                      Shopify store, and a browser test of every page
```

## Endpoints

| Endpoint | |
|---|---|
| `GET /app/api/reorder[?view=dead]` | Reorder list (or dead stock) with totals |
| `GET/POST /app/api/variants` | Search; per-item choices, supplier link, supplier terms, bundle parts |
| `GET/POST /app/api/suppliers` | List, create, update, delete, from vendors |
| `GET/POST /app/api/purchase-orders` | List; create from suggestions or empty |
| `GET/POST /app/api/purchase-orders/:id` | Detail; save, send, status changes, receive, undo, retry |
| `GET/POST /app/api/jobs`, `/app/api/jobs/:id` | Sync and supplier import runs, progress, reports, stop |
| `GET/POST /app/api/files`, `GET /app/api/sheet` | Upload a supplier sheet; read its columns |
| `GET/POST /app/api/settings` | Settings; test email; send the weekly email now |
| `/dl/...` | Signed links: PO PDF/CSV/print, reorder and dead stock CSV, import report, turn alert emails off |
| Webhooks | `app/uninstalled`, `app/scopes_update`, `app_subscriptions/update`, `inventory_levels/update`, `products/delete`, compliance |

## Shopify permissions

`read_products, write_inventory, read_locations, read_orders`. Orders are protected customer data: before going live,
request Level 1 protected customer data access in the Partner Dashboard (only order line items and dates are read).
Request `read_all_orders` there too; once approved, add it to `scopes` in `shopify.app.toml`. Until then Shopify gives
the app the last 60 days of orders (the app says so on the reorder list). Development stores need no approval.
On development stores test orders count as sales (they are the only orders there); on real stores they do not.

## Running it locally

1. `npm install` (or copy `node_modules` from the uploader app; the dependencies are the same plus PGlite for tests)
2. `cp .env.example .env` and set `DATABASE_URL` (a new database, not the uploader's).
3. `npm run config:link` and choose **create a new app** called Restock (do not link the uploader app). Check
   `shopify.app.toml` afterwards: `scopes` and the webhook `api_version = "2026-10"` must stay as they are.
4. In the Partner Dashboard: Restock > API access > Protected customer data: select the data use for development.
5. `npm run dev`, install on the development store. The first sync starts by itself.

## Tests

```
npm test               # 49 tests: forecast maths, settings, and the full flow on a real Postgres (PGlite)
npm run test:browser   # every page in Chrome with a fake API (needs Chrome/Edge and internet for Polaris)
npm run typecheck && npm run lint && npm run build
```

## Deploying on Railway

Same as the uploader: one Docker image, two services (web: default start command; worker: `npm run worker`),
PostgreSQL and Redis plugins, and these variables on both: `DATABASE_URL`, `REDIS_URL`, `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `R2_*`, `RESEND_API_KEY`, `EMAIL_FROM`, `SUPPORT_EMAIL`, `APP_HANDLE`,
optionally `GOOGLE_SERVICE_ACCOUNT_JSON`. The worker runs jobs, the 6-hourly sync, the alert emails and the cleanup.

## Plans and billing

Shopify Managed Pricing. Plans in the Partner Dashboard must be named so they contain `Starter`, `Growth` or `Pro`
(anything else, or none, is Free). Limits are in `app/lib/plans.ts`: Free 50 variants, Starter 500, Growth 5,000,
Pro unlimited and several locations. Over the limit, the best-selling variants get suggestions and the rest are listed
without one.
