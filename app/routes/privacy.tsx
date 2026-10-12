// Public privacy policy page (linked from the App Store listing). Plain HTML, no login.
// The owner must review this text before launch; it describes what the code stores and for how long.
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

export const meta: MetaFunction = () => [{ title: "Privacy policy · Restock" }];

export const loader = async () => ({
  // eslint-disable-next-line no-undef
  email: process.env.SUPPORT_EMAIL || "support@example.com",
  // eslint-disable-next-line no-undef
  fileDays: Number(process.env.FILE_RETENTION_DAYS || 7),
});

export default function Privacy() {
  const { email, fileDays } = useLoaderData<typeof loader>();
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", font: "16px/1.6 system-ui, sans-serif" }}>
      <h1>Privacy policy</h1>
      <p>
        Restock (&quot;the app&quot;) helps Shopify merchants decide what to reorder, and create and receive purchase orders. This page explains
        what the app reads, what it stores, why, and for how long.
      </p>
      <h2>What the app reads from Shopify</h2>
      <ul>
        <li>Products and variants: titles, SKUs, barcodes, prices, cost per item, vendors and bundle components.</li>
        <li>Stock per location, and location names.</li>
        <li>
          Orders: only the date of each order, whether it was cancelled or a test, and which variants were sold in what quantity and at
          what price. The app does not request or read customer names, email addresses, phone numbers or addresses.
        </li>
      </ul>
      <h2>What the app stores</h2>
      <ul>
        <li>Your store&apos;s address, name, email, currency and time zone, your plan, and the access token Shopify gives the app.</li>
        <li>A copy of your variants and stock levels, refreshed every few hours.</li>
        <li>
          Daily sales totals per variant (units and value). Individual orders are not stored. Totals older than about two years are deleted.
        </li>
        <li>Suppliers, purchase orders, receipts and the settings you enter.</li>
        <li>Supplier sheets you upload, deleted automatically after {fileDays} days.</li>
        <li>A log of emails the app sent for you (recipient, subject, result; not the content), kept for 6 months.</li>
      </ul>
      <h2>Changes the app makes in Shopify</h2>
      <p>
        Only when you ask it to: adding stock when you receive a purchase order (or taking it back when you undo a receipt), and, if you tick
        the option, updating the cost per item.
      </p>
      <h2>Emails</h2>
      <p>
        The app sends purchase orders to the supplier addresses you enter, and reorder emails and low-stock alerts to the addresses in your
        settings. It sends no marketing. Emails are delivered through an email service provider used only for sending them.
      </p>
      <h2>Where the data is kept</h2>
      <p>
        On the app&apos;s servers and its file storage, used only to run the app. The data is not sold or shared with anyone else. Payments are
        handled by Shopify; the app never sees card details.
      </p>
      <h2>Deleting your data</h2>
      <p>
        When you uninstall the app, it stops all work for your store at once. Shopify then asks the app to delete your store&apos;s data, and the
        app deletes all of it: products, stock, sales totals, suppliers, purchase orders, settings and files. You can also ask for deletion
        at any time by email.
      </p>
      <h2>Contact</h2>
      <p>
        Questions or requests: <a href={`mailto:${email}`}>{email}</a>
      </p>
    </main>
  );
}
