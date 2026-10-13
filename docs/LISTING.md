# App Store listing: Reorder Desk

Text to paste into Partner Dashboard > Reorder Desk > Distribution > App Store listing. Limits are Shopify's
(checked 2026-10). Change prices here and in `app/lib/plans.ts` together.

## Name

**Reorder Desk** (App Store search on 2026-10-13: no app with this name. "Restock" was taken: restock-1 to
restock-11, "Restock: Inventory Management".) If the Dashboard still refuses the name, backups: "Reorder Desk:
Forecast & POs" (listing title can carry the subtitle), "Supplier Desk".

## Subtitle (max 62)

Know what to reorder: sales forecasts and supplier POs

## Introduction (max 100)

See what will run out before it does, order the right amount from each supplier, receive it in one click.

## Details (max 500)

Reorder Desk reads your Shopify sales and stock and tells you what to order this week, from which supplier, and
how many. Every number comes with a plain "why": sales per day, days of stock left, lead time, case pack and
minimum order. Create a purchase order per supplier from the list, email it with a PDF, and receive the stock
straight into Shopify, partly or all at once, with undo. Bundles count against their parts. Moving from Stocky?
Import your suppliers from a sheet.

## Feature list (max 80 each, up to 5)

1. Reorder list ranked by urgency, with the reason behind every number
2. Purchase orders per supplier, emailed as PDF and CSV
3. Receive stock into Shopify in one click, with partial receiving and undo
4. Bundles, case packs, minimum orders and supplier lead times built in
5. Weekly reorder email, low-stock alerts and a dead stock report

## Search terms (up to 5)

reorder, purchase order, inventory forecast, stocky alternative, low stock

## Category

Store management > Inventory > Inventory optimization (pick the closest the Dashboard offers).

## Pricing (Managed Pricing)

Plan names must contain "Free" / "Pro" exactly as words: the app reads the plan from the subscription name.

| Plan | Price | Trial | Shown features |
|---|---|---|---|
| Free | $0 | - | Forecasts for the 50 best-selling variants, purchase orders and receiving, weekly reorder email |
| Pro | $29 / month (owner to confirm) | 14 days | No variant limit, several locations, seasonal forecasts, priority email support |

## Screenshots (1600 x 900, 3-6)

From the dev store once it has orders (the browser test screenshots in `test/browser/.out/` show the same pages):
1. Reorder list with "Need ordering" items and totals
2. The "Why?" panel with the weekly chart
3. A purchase order with lines, ready to send
4. Receiving stock (partial) with the result
5. Suppliers page with the sheet import preview
6. Settings: weekly email and low-stock alerts

## URLs

- Privacy policy: https://restock-app-production.up.railway.app/privacy
- Support / FAQ: https://restock-app-production.up.railway.app/support
- Support email: the `SUPPORT_EMAIL` set on Railway

## Testing instructions for the reviewer

Paste in Partner Dashboard > App submission > Testing instructions. Before submitting, the dev store must have
products with SKUs, cost per item, stock, and paid orders from the last 60 days.

```
Reorder Desk needs sales history, so please use our development store, which has products and paid orders:
<store>.myshopify.com (staff account invited for app review), or install on your own store with orders from
the last 60 days.

1. Open Reorder Desk. The first sync starts by itself; it takes under a minute. Click "Sync now" to repeat it.
2. Reorder: the "Need ordering" list shows items that will run out within lead time + cover. Click "Why?" on any
   row to see the sales per day, stock-out date and order quantity, each with its reason.
3. Suppliers: click "Create suppliers from vendors" (or "Add supplier"); give one supplier your email address.
4. Reorder: "Select all that need ordering", then "Create purchase orders". One draft per supplier opens under
   Purchase orders.
5. Open the purchase order: "Send to supplier" emails the PDF and CSV; or "Mark as sent".
6. "Receive stock": enter part of a quantity and save. Check the variant's stock in Shopify > Products: it went up
   by that amount. Click "Undo" on the receipt: the stock goes back.
7. Dead stock, Settings ("Send a test email") and Plans pages need no data.
The app reads orders only for line items and dates; it does not read customer data.
```
