import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

// Public landing page. App Store requirement 2.3.1: an app must not ask merchants to type their
// myshopify.com domain, so there is no login form here; installs start from the App Store (or the
// CLI install link during development) and come back here with ?shop=.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Reorder Desk</h1>
        <p className={styles.text}>
          Know what to reorder this week, in 5 minutes. Forecasts from your Shopify sales, purchase orders by supplier, and stock received
          straight into Shopify.
        </p>
        <p className={styles.text}>Install it from the Shopify App Store, then open it from your Shopify admin.</p>
        <ul className={styles.list}>
          <li>
            <strong>Every number explained</strong>. Sales per day, stock-out date and order quantity, each with a one-line why.
          </li>
          <li>
            <strong>Set up in minutes</strong>. Suppliers from your vendors or a sheet; Stocky exports work.
          </li>
          <li>
            <strong>Bundles counted right</strong>. Bundle sales count against the products inside them.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="/privacy">Privacy policy</a> · <a href="/support">Support</a>
        </p>
      </div>
    </div>
  );
}
