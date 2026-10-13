# Reorder Desk (code name Restock): progress and handoff

Read this first when starting a new session. Last updated: 2026-10-13 (renamed, plans trimmed, launch docs).
Owner's launch steps in order (Hinglish): `docs/LAUNCH.md`. Listing text + reviewer instructions: `docs/LISTING.md`.

## 2026-10-13: renamed to Reorder Desk, Free + Pro, launch docs

- "Restock" was already taken on the App Store ("Restock: Inventory Management", slugs restock-1 .. restock-11;
  Replenly was renamed from it). Should have been checked before the Partner app was created; the plan had said so.
  Owner chose **Reorder Desk**. Changed: toml `name` + `handle = "reorder-desk"`, every merchant-facing text
  (emails, landing, privacy, support, unsubscribe pages), supplier template file name. Folder, repo, package,
  Railway services, `gid://restock-app/...` references and DB stay `restock`.
- Upgrade gave 404 on `/charges/restock/pricing_plans`: Managed Pricing not set up yet (and the handle may differ).
  The app now reads its handle from Shopify (`currentAppInstallation.app.handle`, in `syncPlan`); `APP_HANDLE`
  is only the worker's fallback (default `reorder-desk`).
- Plans: owner chose **Free + Pro** only. Free 50 variants / 1 location; Pro unlimited, all locations, seasonal.
  Pro shown as $29/month until the owner confirms the price.
- Landing page: "Shop domain" login form removed (App Store requirement 2.3.1). `.dockerignore` now keeps
  `.env`, `.git`, `.shopify`, `storage` and browser test output out of the image. Privacy page names Railway,
  Cloudflare R2 and Resend.
- Not installable on a live (non-dev) store yet: no distribution chosen. Must be **Public**, never Custom.
- Verified: `npm test` 49 passed, `npm run test:browser` all passed, typecheck, lint, build clean.

## Goal

The second Shopify App Store app: stock forecasting + purchase orders for stores that buy from suppliers, aimed first at
ex-Stocky merchants (Stocky shut down on 31 Aug 2026). Plan, competitors and pricing: `../NEXT-APP-IDEA.md`.

Note: the plan said to start only after the Bulk Product Uploader is launched and earning, and to check demand with
5-10 merchants first. On 2026-10-12 the owner asked for the whole app to be built now. The code is done; the demand
check and the uploader launch are still the owner's call on what goes live first.

## Decisions

| Topic | Decision |
|---|---|
| Base | Copy of the uploader app's base (template, OAuth, Prisma, BullMQ, R2, Polaris wrappers, Managed Pricing). Separate app, separate database |
| Data from Shopify | Bulk operations (one export file) for variants+stock+bundle components and for orders; both run at the same time (5 allowed per shop since 2026-01). Stock kept live with `inventory_levels/update`; everything else re-synced every 6 hours |
| Sales history | Only daily totals per variant (`SalesDay`); no orders, no customers. First sync: 730 days with `read_all_orders`, else 60. Later syncs re-read the last 35 days (refunds/cancellations) |
| Forecast | Explainable, no AI: weighted weekly average (0.85 per week back), out-of-stock days left out, seasonal factor from last year (Pro), case pack + MOQ rounding, every number has a "why" line |
| Stock-out history | `OutOfStockDay` written at every sync from then on; earlier stock-outs are unknown |
| Bundles | Shopify `productVariantComponents` read on sync; manual bundles for other apps. Bundle sales expanded into parts at forecast time; bundles themselves are not reordered |
| Locations | Plan-limited: Free counts 1 location (the oldest, normally the main one, or the chosen one), Pro several |
| Plan limit | Variants (Free 50 / Pro unlimited; Starter/Growth dropped 2026-10-13). Over the limit: best sellers get suggestions |
| Purchase orders | Draft per supplier from the reorder list (merged into an open draft), numbers `PO-0001` per shop. Drafts do not count as on order unless the setting says so |
| Receiving | `Receipt` row saved first; its id is the `@idempotent` key (required for inventory mutations since API 2026-04); `changeFromQuantity: null`; reference `gid://restock-app/PurchaseOrder/<id>`. Undo = a reversing receipt (reason `correction`) |
| Emails | Resend HTTP API (no SDK). Weekly email only when something needs ordering; daily low-stock alert once per episode (`Variant.lowAlertAt`); signed one-click unsubscribe. Without a key: logged only |
| PDF | Own small PDF writer (Helvetica, WinAnsi; other scripts print "?", "₹" as "Rs."). The printable HTML page shows every language |
| Stocky import | Stocky cannot export suppliers (Shopify Help Center). So: header-mapping importer with Stocky/Shopify/price-list column names recognised; "suppliers from vendors" button |
| Tests | PGlite (Postgres in WebAssembly) behind `pglite-socket`, so the real SQL, transactions and row locks run in `npm test` |

## What was built (2026-10-12)

Everything in "Version 1 features" of the plan, plus the seasonal adjustment from version 1.1 (without AI):

- Schema + migration `20261012000000_init` (Shop, Job, StoredFile, Location, Variant, InventoryLevel, BundleComponent,
  SalesDay, OutOfStockDay, Supplier, SupplierItem, VariantPlan, PurchaseOrder, PurchaseOrderLine, Receipt, EmailLog).
- Sync job, first sync started on install / first open, 6-hourly scheduled sync, stock webhook, product delete webhook.
- Reorder list page with totals, filters, search, sort, editable quantities, bulk supplier/ignore, create POs, CSV,
  per-item "why" panel with weekly chart, supplier terms, overrides and bundle parts.
- Purchase orders list and editor: lines, add item search, details, send by email (PDF + CSV), mark sent, back to
  draft, cancel, close short, reopen, delete, receive (partial/all, optional cost update), undo, retry, PDF/CSV/print.
- Suppliers page: CRUD (case-insensitive unique names), from vendors, sheet import with preview and report CSV.
- Dead stock page, Settings page (forecast defaults, locations, PO details, emails + test + send now, email log),
  Plans page, public Privacy and Support pages, landing page, supplier template CSV.

### Verified (2026-10-12)
`npm test` 49 passed (22 forecast/helpers + 27 full-flow on PGlite with a simulated Shopify), `npm run test:browser`
all checks passed (every page), `npm run typecheck`, `npm run lint`, `npm run build` (app + worker) clean.
Bugs found by the tests and fixed: items sold only inside bundles were listed as dead stock; "abc" as a lead time was
read as 0; duplicate supplier names differing only in case.

### Not verified yet
- Anything against real Shopify: the two bulk queries (field names checked against the 2026-10 docs, not run), the
  `inventoryAdjustQuantities` call with `@idempotent`, `inventoryItemUpdate`, webhooks, App Bridge inside Admin.
- Resend sending, R2, Redis/BullMQ in production, Neon.

## Waiting on the owner

1. Done 2026-10-12: Partner app created (then named Restock), Railway Postgres.
2. Protected customer data (Level 1, orders) and `read_all_orders`: request early, approval can take days to weeks.
3. Resend account + a verified sending domain (for supplier emails and alerts); `SUPPORT_EMAIL`.
4. Plans in Managed Pricing named Free / Pro with prices and trial.
5. Done 2026-10-13: "Restock" was taken; renamed to Reorder Desk.

## Go-live status (2026-10-12, owner paused here)

- Code on GitHub: https://github.com/Munish86/restock-app (`main`); every push redeploys Railway.
- Railway project "courageous-compassion" / "production": Postgres + Redis Online; web service `restock-app` Online
  at https://restock-app-production.up.railway.app. Web variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
  `REDIS_URL=${{Redis.REDIS_URL}}`, `PORT=3000`, `SHOPIFY_APP_URL`, `SCOPES`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
  `APP_HANDLE=restock`. An unattached volume `redis-volume-7wJH` can be deleted.
- Shopify Partner app "Restock", client_id `fc0ae5925d98dec9609df1b38c3b7062`, linked in `shopify.app.toml` with the
  Railway URLs (config:link had rewritten the file; restored).

Done on 2026-10-12: worker service `restock-app-worker` running ("Worker started"; R2 warning expected),
`npm run deploy` done, app installed on the dev store `bulk-uploader-test`; it opens in Admin and the first sync
worked (5 variants, no sales yet because the dev store had no orders in 60 days).

Still to do: see `docs/LAUNCH.md` (rename deploy, Public distribution, Managed Pricing, protected data, R2, Resend,
dev-store test, listing, submit).

## Next (resume here)

1. Owner follows `docs/LAUNCH.md` 1-3 (`npm run deploy` for the new name/handle, `APP_HANDLE=reorder-desk` on
   Railway, Public distribution, Managed Pricing plans "Free" / "Pro"); then the dev-store test (step 7). Fix
   whatever turns up.
2. Owner confirms the Pro price; change `app/lib/plans.ts` and `docs/LISTING.md` if not $29.
3. After `read_all_orders` is approved: add it to `scopes` in `shopify.app.toml`, `npm run deploy`.
4. Screenshots + icon, submit (`docs/LISTING.md`). Optional: a separate Custom-distribution app for the owner's
   live store before approval (needs a second client id in the same deployment).
5. Later (1.1): AI weekly summary and "what should I order for next month's sale?" (optional, never pushed).

## Commands

```
npm test | npm run test:browser | npm run typecheck | npm run lint | npm run build | npm run worker | npm run dev
npx prisma migrate diff --from-schema-datamodel <old.prisma> --to-schema-datamodel prisma/schema.prisma --script
```

## Gotchas (in addition to the uploader's `docs/PROGRESS.md` gotchas, which all apply)

- This PC's PATH lacks `C:\Windows\System32`: prefix shell commands with it (`robocopy`, Shopify CLI need it).
- Raw SQL writes (`app/.server/sql.ts`) cast every value: Prisma `DateTime` columns are `timestamp(3)` without zone,
  so pass `sqlTime(date)`; `@db.Date` columns take "YYYY-MM-DD" strings.
- Day maths uses "YYYY-MM-DD" strings in the store's time zone (`app/lib/dates.ts`); never `new Date()` days in SQL.
- PGlite's socket server drops the connection after a failed statement; tests avoid relying on DB errors.
- `s-banner heading` renders twice in the DOM (browser tests use `.first()`); CSS module class names are hashed
  in the browser bundle, so tests select by text or aria-label, not by class.
