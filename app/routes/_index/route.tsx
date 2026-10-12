import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Restock</h1>
        <p className={styles.text}>
          Know what to reorder this week, in 5 minutes. Forecasts from your Shopify sales, purchase orders by supplier, and stock received
          straight into Shopify.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
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
      </div>
    </div>
  );
}
