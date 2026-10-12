// Public support page (linked from the App Store listing). Plain HTML, no login.
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

export const meta: MetaFunction = () => [{ title: "Support · Restock" }];

export const loader = async () => ({
  // eslint-disable-next-line no-undef
  email: process.env.SUPPORT_EMAIL || "support@example.com",
});

export default function Support() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", font: "16px/1.6 system-ui, sans-serif" }}>
      <h1>Support</h1>
      <p>
        Email <a href={`mailto:${email}`}>{email}</a>. Include your store address (xxxx.myshopify.com) and, for a purchase order, its number.
      </p>
      <h2>Common questions</h2>
      <h3>How is the suggested quantity worked out?</h3>
      <p>
        (lead time + days to cover) × sales per day + safety stock − in stock − already on order, rounded up to the case pack and the
        minimum order. Click &quot;Why?&quot; on any item to see its own numbers. Recent weeks count more, and days the item was out of stock
        are left out, so a stock-out does not lower the forecast.
      </p>
      <h3>A suggestion looks wrong</h3>
      <p>
        Open the item with &quot;Why?&quot;. You can set its sales per day, days to cover, safety stock or the quantity yourself, or mark it as
        not reordered. Check the supplier&apos;s lead time too.
      </p>
      <h3>Only 60 days of sales are used</h3>
      <p>
        Shopify gives apps the last 60 days of orders until it approves access to older ones. Once approved, the app reads up to two years
        of sales by itself.
      </p>
      <h3>Bundles</h3>
      <p>
        Bundles made with Shopify&apos;s bundle components are read automatically. For other bundle apps, open the bundle on the reorder list
        (&quot;Not reordered&quot; filter or search), and set up its parts. Each bundle sale then counts as sales of its parts.
      </p>
      <h3>I received the wrong quantity</h3>
      <p>Open the purchase order, find the receipt under &quot;Stock received&quot; and click Undo. The stock is taken back in Shopify.</p>
      <h3>Coming from Stocky?</h3>
      <p>
        On the Suppliers page, import a sheet with your SKUs and suppliers (Stocky exports and Shopify product exports work), or create
        suppliers from your product vendors in one click.
      </p>
      <p>
        <a href="/privacy">Privacy policy</a>
      </p>
    </main>
  );
}
