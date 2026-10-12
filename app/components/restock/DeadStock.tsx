// Dead stock: items in stock that have not sold for a long time, and how much money is tied up in them.
import { useEffect, useMemo, useState } from "react";
import { shortDay } from "../../lib/dates";
import { fmt } from "../../lib/forecast";
import { Button, Select, TextField } from "../polaris";
import { api, post, toast, type DeadData } from "./api";
import { ErrorBanner, ItemCell, Pager, count, money } from "./ui";
import styles from "./restock.module.css";

const PAGE = 50;

export function DeadStock() {
  const [data, setData] = useState<DeadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [supplier, setSupplier] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api<DeadData>("/app/api/reorder?view=dead")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.rows ?? []).filter(
      (r) =>
        (!supplier || (supplier === "none" ? !r.supplierId : r.supplierId === supplier)) &&
        (!needle || [r.title, r.variantTitle, r.sku, r.supplierName].some((v) => String(v || "").toLowerCase().includes(needle))),
    );
  }, [data, q, supplier]);

  if (!data) {
    return (
      <s-section>
        <ErrorBanner error={error} />
        {!error && <s-text color="subdued">Loading…</s-text>}
      </s-section>
    );
  }

  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const units = rows.reduce((s, r) => s + r.available, 0);
  const noCost = rows.filter((r) => r.value == null).length;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const slice = rows.slice(current * PAGE, current * PAGE + PAGE);
  const days = data.settings.deadStockDays;

  return (
    <s-stack direction="block" gap="base">
      <ErrorBanner error={error} />
      <div className={styles.tiles}>
        <div className={styles.tile}>
          <span className={styles.muted}>Money in dead stock</span>
          <b>{money(total, data.currency, 0)}</b>
          <span className={`${styles.small} ${styles.muted}`}>at cost{noCost ? `, ${noCost} items without a cost` : ""}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.muted}>Items</span>
          <b>{count(rows.length)}</b>
          <span className={`${styles.small} ${styles.muted}`}>{count(units)} units in stock</span>
        </div>
      </div>

      <s-section heading={`No sale in ${days} days or more`}>
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Ideas: a discount or bundle, a return to the supplier, or a clearance. Items you no longer sell can be marked &quot;Don&apos;t
            reorder&quot;. The number of days is set in Settings.
          </s-text>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base" alignItems="end">
            <TextField
              label="Search"
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(0);
              }}
              placeholder="Name, SKU or supplier"
            />
            <Select
              label="Supplier"
              value={supplier}
              onChange={(v) => {
                setSupplier(v);
                setPage(0);
              }}
              options={[{ value: "", label: "All suppliers" }, { value: "none", label: "No supplier" }, ...data.suppliers.map((s) => ({ value: s.id, label: s.name }))]}
            />
            <a href={data.csvUrl} download>
              Download as CSV
            </a>
          </s-grid>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Supplier</th>
                  <th className={styles.num}>In stock</th>
                  <th className={styles.num}>Unit cost</th>
                  <th className={styles.num}>Stock value</th>
                  <th>Last sale</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {slice.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <ItemCell title={r.title} variantTitle={r.variantTitle} sku={r.sku} imageUrl={r.imageUrl} productId={r.productId} />
                    </td>
                    <td>{r.supplierName ?? <span className={styles.muted}>None</span>}</td>
                    <td className={styles.num}>{fmt(r.available)}</td>
                    <td className={styles.num}>{money(r.unitCost, data.currency)}</td>
                    <td className={styles.num}>{money(r.value, data.currency)}</td>
                    <td>{r.lastSaleDay ? `${shortDay(r.lastSaleDay, data.today)} (${r.daysSinceSale} days ago)` : "No sale on record"}</td>
                    <td>
                      {r.ignore ? (
                        <s-text color="subdued">Not reordered</s-text>
                      ) : (
                        <Button
                          variant="tertiary"
                          loading={busy === r.id}
                          onClick={() => {
                            setBusy(r.id);
                            post("/app/api/variants", { action: "plan", variantIds: [r.id], patch: { ignore: true } })
                              .then(() => {
                                toast("Marked as not reordered");
                                return load();
                              })
                              .catch((e) => setError(e.message))
                              .finally(() => setBusy(null));
                          }}
                        >
                          Don&apos;t reorder
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {!slice.length && (
                  <tr>
                    <td colSpan={7} className={styles.muted}>
                      {data.rows.length ? "No items match." : data.syncedAt ? "No dead stock. Everything in stock has sold recently." : "Shown after the first sync with Shopify."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={current} pages={pages} total={rows.length} noun="item" onPage={setPage} />
        </s-stack>
      </s-section>
    </s-stack>
  );
}
