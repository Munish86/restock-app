// Purchase orders list: filter by status and supplier, and start a new empty order for a supplier.
import { useCallback, useEffect, useState } from "react";
import { Button, Segmented, Select } from "../polaris";
import { api, post, type PoSummary } from "./api";
import { ErrorBanner, count, dateText, money } from "./ui";
import styles from "./restock.module.css";

type Filter = "open" | "draft" | "sent" | "partial" | "received" | "cancelled" | "all";

export const PO_STATUS: Record<PoSummary["status"], { label: string; tone: "info" | "success" | "warning" | "neutral" | "critical" }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Sent", tone: "info" },
  partial: { label: "Partly received", tone: "warning" },
  received: { label: "Received", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function PoBadge({ status, closedShort }: { status: PoSummary["status"]; closedShort?: boolean }) {
  const s = PO_STATUS[status];
  return <s-badge tone={s.tone}>{closedShort ? "Closed short" : s.label}</s-badge>;
}

export function PurchaseOrders({ go, initialSupplier = "" }: { go: (path: string) => void; initialSupplier?: string }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [supplier, setSupplier] = useState(initialSupplier);
  const [data, setData] = useState<{ orders: PoSummary[]; suppliers: { id: string; name: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newFor, setNewFor] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<{ orders: PoSummary[]; suppliers: { id: string; name: string }[] }>(
        `/app/api/purchase-orders?status=${filter}${supplier ? `&supplier=${encodeURIComponent(supplier)}` : ""}`,
      )
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => setError(e.message)),
    [filter, supplier],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const create = () => {
    setBusy(true);
    post<{ id: string }>("/app/api/purchase-orders", { action: "create", supplierId: newFor })
      .then((r) => go(`/app/purchase-orders/${r.id}`))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <s-stack direction="block" gap="base">
      <ErrorBanner error={error} />
      <s-section>
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Orders are usually made from the reorder list: tick items there and click &quot;Create purchase orders&quot;. Or start an empty order
            for a supplier here.
          </s-text>
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <div style={{ minWidth: 240 }}>
              <Select
                label="New order for"
                value={newFor}
                onChange={setNewFor}
                options={[{ value: "", label: data?.suppliers.length ? "Choose a supplier" : "Add a supplier first" }, ...(data?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))]}
              />
            </div>
            <Button onClick={create} disabled={!newFor} loading={busy}>
              New purchase order
            </Button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Purchase orders">
        <s-stack direction="block" gap="base">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "open", label: "Open" },
              { value: "draft", label: "Drafts" },
              { value: "sent", label: "Sent" },
              { value: "partial", label: "Partly received" },
              { value: "received", label: "Received" },
              { value: "cancelled", label: "Cancelled" },
              { value: "all", label: "All" },
            ]}
          />
          <div style={{ maxWidth: 300 }}>
            <Select
              label="Supplier"
              value={supplier}
              onChange={setSupplier}
              options={[{ value: "", label: "All suppliers" }, ...(data?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))]}
            />
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th className={styles.num}>Items</th>
                  <th className={styles.num}>Units received</th>
                  <th className={styles.num}>Total</th>
                  <th>Expected</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {(data?.orders ?? []).map((o) => {
                  const late = o.expectedAt && o.expectedAt < today && (o.status === "sent" || o.status === "partial");
                  return (
                    <tr key={o.id}>
                      <td>
                        <s-link href={`/app/purchase-orders/${o.id}`}>{o.number}</s-link>
                      </td>
                      <td>{o.supplier}</td>
                      <td>
                        <PoBadge status={o.status} closedShort={o.closedShort} />
                      </td>
                      <td className={styles.num}>{count(o.lines)}</td>
                      <td className={styles.num}>
                        {count(o.received)} / {count(o.units)}
                      </td>
                      <td className={styles.num}>{money(o.total, o.currency)}</td>
                      <td>
                        {dateText(o.expectedAt)}
                        {late && <div className={`${styles.small} ${styles.err}`}>late</div>}
                      </td>
                      <td>{dateText(o.createdAt)}</td>
                    </tr>
                  );
                })}
                {data && !data.orders.length && (
                  <tr>
                    <td colSpan={8} className={styles.muted}>
                      No purchase orders here yet.
                    </td>
                  </tr>
                )}
                {!data && !error && (
                  <tr>
                    <td colSpan={8} className={styles.muted}>
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </s-stack>
      </s-section>
    </s-stack>
  );
}
