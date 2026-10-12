// Suppliers: the list, adding and editing one, one-click suppliers from product vendors, and the sheet import.
import { useCallback, useEffect, useState } from "react";
import { Button, NumberField, TextField } from "../polaris";
import { api, post, toast, type Supplier } from "./api";
import { ErrorBanner, count, money } from "./ui";
import { SupplierImport } from "./SupplierImport";
import styles from "./restock.module.css";

type Form = { name: string; email: string; ccEmails: string; contactName: string; phone: string; address: string; currency: string; leadTimeDays: number | ""; minOrderValue: string; notes: string };
const empty: Form = { name: "", email: "", ccEmails: "", contactName: "", phone: "", address: "", currency: "", leadTimeDays: "", minOrderValue: "", notes: "" };

export function Suppliers({ currency }: { currency: string }) {
  const [data, setData] = useState<{ suppliers: Supplier[]; unassigned: number; vendorsWithout: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // supplier id, or "new"
  const [form, setForm] = useState<Form>(empty);
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(
    () =>
      api<{ suppliers: Supplier[]; unassigned: number; vendorsWithout: number }>("/app/api/suppliers")
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const run = (what: string, body: unknown, done: (r: Record<string, unknown>) => string) => {
    setBusy(what);
    setError(null);
    post<Record<string, unknown>>("/app/api/suppliers", body)
      .then((r) => {
        toast(done(r));
        setEditing(null);
        setConfirmDelete(null);
        return load();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };
  const edit = (s?: Supplier) => {
    setEditing(s?.id ?? "new");
    setForm(
      s
        ? { ...s, leadTimeDays: s.leadTimeDays ?? "", minOrderValue: s.minOrderValue == null ? "" : String(s.minOrderValue) }
        : empty,
    );
  };
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setForm({ ...form, [k]: v });
  const shown = (data?.suppliers ?? []).filter((s) => !q.trim() || `${s.name} ${s.email} ${s.contactName}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <s-stack direction="block" gap="base">
      <ErrorBanner error={error} />
      {data && data.unassigned > 0 && (
        <s-banner tone="info" heading={`${count(data.unassigned)} items have no supplier yet`}>
          <s-stack direction="block" gap="small-200">
            <s-text>
              Items without a supplier still get forecasts, but cannot go on a purchase order. Fastest: use your product vendors as suppliers
              {data.vendorsWithout ? ` (${data.vendorsWithout} vendors)` : ""}, or import a sheet below. You can also set a supplier on the reorder
              list.
            </s-text>
            {data.vendorsWithout > 0 && (
              <div>
                <Button
                  loading={busy === "vendors"}
                  onClick={() =>
                    run("vendors", { action: "from-vendors" }, (r) => `${r.created} suppliers created, ${r.assigned} items linked`)
                  }
                >
                  Create suppliers from vendors
                </Button>
              </div>
            )}
          </s-stack>
        </s-banner>
      )}

      <s-section heading="Suppliers">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="end">
            <div style={{ minWidth: 260 }}>
              <TextField label="Search" value={q} onChange={setQ} placeholder="Name, email or contact" />
            </div>
            <Button variant="primary" onClick={() => edit()}>
              Add supplier
            </Button>
          </s-stack>

          {editing && (
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>{editing === "new" ? "New supplier" : `Edit ${form.name}`}</s-heading>
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
                  <TextField label="Name" value={form.name} onChange={set("name")} />
                  <TextField label="Email for orders" value={form.email} onChange={set("email")} />
                  <TextField label="Cc" value={form.ccEmails} onChange={set("ccEmails")} details="Comma separated" />
                  <TextField label="Contact name" value={form.contactName} onChange={set("contactName")} />
                  <TextField label="Phone" value={form.phone} onChange={set("phone")} />
                  <NumberField label="Lead time (days)" value={form.leadTimeDays} onChange={set("leadTimeDays")} min={0} max={365} details="From ordering to arrival" />
                  <TextField label="Minimum order value" value={form.minOrderValue} onChange={set("minOrderValue")} />
                  <TextField label="Currency" value={form.currency} onChange={(v) => set("currency")(v.toUpperCase().slice(0, 3))} placeholder={currency} details="Empty = your store's currency" />
                </s-grid>
                <TextField label="Address" value={form.address} onChange={set("address")} />
                <TextField label="Notes printed on purchase orders" value={form.notes} onChange={set("notes")} />
                <s-stack direction="inline" gap="small-200">
                  <Button
                    variant="primary"
                    loading={busy === "save"}
                    onClick={() =>
                      run(
                        "save",
                        editing === "new" ? { action: "create", supplier: form } : { action: "update", id: editing, supplier: form },
                        () => (editing === "new" ? "Supplier added" : "Supplier saved"),
                      )
                    }
                  >
                    Save
                  </Button>
                  <Button onClick={() => setEditing(null)}>Cancel</Button>
                </s-stack>
              </s-stack>
            </s-box>
          )}

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Email</th>
                  <th className={styles.num}>Lead time</th>
                  <th className={styles.num}>Minimum order</th>
                  <th className={styles.num}>Items</th>
                  <th className={styles.num}>Open orders</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                      {s.contactName && <div className={`${styles.small} ${styles.muted}`}>{s.contactName}</div>}
                    </td>
                    <td>{s.email || <span className={styles.warn}>No email</span>}</td>
                    <td className={styles.num}>{s.leadTimeDays == null ? <span className={styles.muted}>default</span> : `${s.leadTimeDays} days`}</td>
                    <td className={styles.num}>{s.minOrderValue == null ? "-" : money(s.minOrderValue, s.currency || currency)}</td>
                    <td className={styles.num}>{count(s.items)}</td>
                    <td className={styles.num}>
                      {s.openOrders ? <s-link href={`/app/purchase-orders?supplier=${s.id}`}>{s.openOrders}</s-link> : 0}
                    </td>
                    <td>
                      {confirmDelete === s.id ? (
                        <s-stack direction="inline" gap="small-200">
                          <Button tone="critical" loading={busy === "delete"} onClick={() => run("delete", { action: "delete", id: s.id }, () => "Supplier deleted")}>
                            Delete {s.name}
                          </Button>
                          <Button onClick={() => setConfirmDelete(null)}>Keep</Button>
                        </s-stack>
                      ) : (
                        <s-stack direction="inline" gap="small-200">
                          <Button variant="tertiary" onClick={() => edit(s)}>
                            Edit
                          </Button>
                          <Button variant="tertiary" tone="critical" onClick={() => setConfirmDelete(s.id)}>
                            Delete
                          </Button>
                        </s-stack>
                      )}
                    </td>
                  </tr>
                ))}
                {data && !shown.length && (
                  <tr>
                    <td colSpan={7} className={styles.muted}>
                      {data.suppliers.length ? "No suppliers match." : "No suppliers yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {confirmDelete && (
            <s-text color="subdued">Deleting a supplier removes its links to items. A supplier with purchase orders cannot be deleted.</s-text>
          )}
        </s-stack>
      </s-section>

      <SupplierImport suppliers={data?.suppliers ?? []} onImported={() => void load()} />
    </s-stack>
  );
}
