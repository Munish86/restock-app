// The open row of the reorder list: why each number is what it is, weekly sales, and the merchant's own
// settings for the item (supplier, supplier terms, sales rate, days to cover, quantity, bundle parts).
import { useState } from "react";
import { shortDay } from "../../lib/dates";
import { fmt } from "../../lib/forecast";
import { Button, Checkbox, NumberField, Select, TextField } from "../polaris";
import { post, toast, type Row, type VariantHit } from "./api";
import { ErrorBanner, money, Sparkline, VariantSearch } from "./ui";
import styles from "./restock.module.css";

type Num = number | "";
const n = (v: number | null | undefined): Num => (v == null ? "" : v);

export function RowDetail({
  row,
  today,
  currency,
  suppliers,
  rowsById,
  defaults,
  onChanged,
}: {
  row: Row;
  today: string;
  currency: string;
  suppliers: { id: string; name: string }[];
  rowsById: Map<string, Row>;
  defaults: { daysToCover: number; safetyDays: number };
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const run = (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    setError(null);
    fn()
      .then(() => {
        toast(done);
        onChanged();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };

  // Planning choices
  const [rate, setRate] = useState<Num>(n(row.rateOverride));
  const [cover, setCover] = useState<Num>(n(row.coverOverride));
  const [safety, setSafety] = useState<Num>(n(row.safetyOverride));
  const [qty, setQty] = useState<Num>(n(row.qtyOverride));
  const [ignore, setIgnore] = useState(row.ignore);
  const [note, setNote] = useState(row.note);
  // Supplier terms
  const [supplierId, setSupplierId] = useState(row.supplierId ?? "");
  const [supplierSku, setSupplierSku] = useState(row.supplierSku);
  const [cost, setCost] = useState(row.supplierId && row.unitCost != null && row.unitCost !== row.shopifyCost ? String(row.unitCost) : "");
  const [casePack, setCasePack] = useState<Num>(n(row.casePack));
  const [moq, setMoq] = useState<Num>(n(row.minOrderQty));
  const [lead, setLead] = useState<Num>(row.leadFrom === "item" ? row.leadTimeDays : "");
  // Bundle parts (set up by hand)
  const [parts, setParts] = useState(row.bundleOf.map((p) => ({ ...p, name: label(rowsById.get(p.id)) })));
  const [editBundle, setEditBundle] = useState(false);

  const savePlan = () =>
    run(
      "plan",
      () =>
        post("/app/api/variants", {
          action: "plan",
          variantIds: [row.id],
          patch: { rateOverride: rate, daysToCover: cover, safetyDays: safety, qtyOverride: qty, ignore, note },
        }),
      "Saved",
    );
  const saveTerms = async () => {
    if (supplierId !== (row.supplierId ?? "")) {
      await post("/app/api/variants", { action: "assign", variantIds: [row.id], supplierId: supplierId || null });
    }
    if (supplierId) {
      await post("/app/api/variants", { action: "item", variantId: row.id, terms: { supplierSku, cost, casePack, minOrderQty: moq, leadTimeDays: lead } });
    }
  };

  const why = row.f.why;
  const parentBundles = [...rowsById.values()].filter((r) => r.bundleOf.some((p) => p.id === row.id));

  return (
    <div className={styles.detailGrid}>
      <s-stack direction="block" gap="base">
        <div>
          <s-heading>Why these numbers</s-heading>
          <ul className={styles.why}>
            {why.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {row.f.warnings.map((w, i) => (
              <li key={`w${i}`} className={styles.warn}>
                {w}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <s-text color="subdued">Sold per week, last {row.weeks.length} weeks (oldest on the left)</s-text>
          <Sparkline weeks={row.weeks} width={260} height={48} />
          <s-text color="subdued">
            {row.lastSaleDay ? `Last sale ${shortDay(row.lastSaleDay, today)}` : "No sale recorded"}
            {row.unitCost != null ? ` · cost ${money(row.unitCost, currency)}` : " · no cost in Shopify"}
            {row.price != null ? ` · price ${money(row.price, currency)}` : ""}
          </s-text>
        </div>
        {row.onOrderPos.length > 0 && (
          <s-text>
            On order in{" "}
            {row.onOrderPos.map((p, i) => (
              <span key={p.id}>
                {i ? ", " : ""}
                <s-link href={`/app/purchase-orders/${p.id}`}>{p.number}</s-link>
              </span>
            ))}
          </s-text>
        )}
        {parentBundles.length > 0 && (
          <s-text color="subdued">Also sold inside: {parentBundles.map((b) => label(b)).join(", ")}</s-text>
        )}
      </s-stack>

      <s-stack direction="block" gap="base">
        <ErrorBanner error={error} />
        {!row.isBundle && (
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-heading>Supplier</s-heading>
              <div className={styles.fields}>
                <Select
                  label="Bought from"
                  value={supplierId}
                  onChange={setSupplierId}
                  options={[{ value: "", label: "No supplier" }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]}
                />
                <TextField label="Supplier SKU" value={supplierSku} onChange={setSupplierSku} />
                <TextField label={`Cost (${currency})`} value={cost} onChange={setCost} placeholder={row.shopifyCost != null ? `Shopify: ${row.shopifyCost}` : ""} />
                <NumberField label="Case pack" value={casePack} onChange={setCasePack} min={1} />
                <NumberField label="Minimum order" value={moq} onChange={setMoq} min={1} />
                <NumberField label="Lead time (days)" value={lead} onChange={setLead} min={0} placeholder={`${row.leadFrom === "item" ? "" : row.leadTimeDays}`} />
              </div>
              <s-text color="subdued">Empty lead time uses the supplier&apos;s, then the store default. Empty cost uses Shopify&apos;s cost per item.</s-text>
              <div>
                <Button onClick={() => run("terms", saveTerms, "Supplier saved")} loading={busy === "terms"}>
                  Save supplier
                </Button>
              </div>
            </s-stack>
          </s-box>
        )}

        {!row.isBundle && (
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-heading>Your settings for this item</s-heading>
              <div className={styles.fields}>
                <NumberField label="Sales per day" value={rate} onChange={setRate} min={0} placeholder={`From history: ${fmt(row.f.historyRate)}`} />
                <NumberField label="Days to cover" value={cover} onChange={setCover} min={1} placeholder={`Store: ${defaults.daysToCover}`} />
                <NumberField label="Safety stock (days)" value={safety} onChange={setSafety} min={0} placeholder={`Store: ${defaults.safetyDays}`} />
                <NumberField label="Order this many next" value={qty} onChange={setQty} min={0} placeholder={`Suggested: ${row.f.suggested}`} />
              </div>
              <TextField label="Note" value={note} onChange={setNote} placeholder="Only for you" />
              <Checkbox label="Don't reorder this item (discontinued, made to order...)" checked={ignore} onChange={setIgnore} />
              <s-text color="subdued">Empty fields use the store settings. A quantity you set is used once, for the next purchase order.</s-text>
              <div>
                <Button onClick={savePlan} loading={busy === "plan"}>
                  Save settings
                </Button>
              </div>
            </s-stack>
          </s-box>
        )}

        <s-box padding="base" border="base" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-heading>Bundle</s-heading>
            {row.isBundle && !editBundle ? (
              <>
                <s-text>
                  Made of: {row.bundleOf.map((p) => `${p.quantity} × ${label(rowsById.get(p.id))}`).join(", ") || "parts set up in Shopify"}
                </s-text>
                <s-text color="subdued">Each sale of this bundle counts as sales of its parts, which are reordered instead.</s-text>
                {row.bundleOf.length > 0 && (
                  <div>
                    <Button onClick={() => setEditBundle(true)}>Change parts</Button>
                  </div>
                )}
              </>
            ) : !editBundle ? (
              <>
                <s-text color="subdued">Is this a bundle or kit sold through a bundle app? List its parts so its sales count against them.</s-text>
                <div>
                  <Button onClick={() => setEditBundle(true)}>Set up as a bundle</Button>
                </div>
              </>
            ) : (
              <>
                {parts.map((p, i) => (
                  <s-stack key={p.id} direction="inline" gap="small-200" alignItems="center">
                    <input
                      className={styles.qty}
                      type="number"
                      min={1}
                      value={p.quantity}
                      aria-label={`Quantity of ${p.name}`}
                      onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))}
                    />
                    <s-text>× {p.name}</s-text>
                    <Button variant="tertiary" onClick={() => setParts(parts.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </s-stack>
                ))}
                <VariantSearch
                  label="Add a part"
                  exclude={[row.id, ...parts.map((p) => p.id)]}
                  onPick={(v: VariantHit) => setParts([...parts, { id: v.id, quantity: 1, name: v.variantTitle ? `${v.productTitle} - ${v.variantTitle}` : v.productTitle }])}
                />
                <s-stack direction="inline" gap="small-200">
                  <Button
                    variant="primary"
                    loading={busy === "bundle"}
                    onClick={() =>
                      run(
                        "bundle",
                        () => post("/app/api/variants", { action: "bundle", variantId: row.id, parts: parts.map((p) => ({ variantId: p.id, quantity: p.quantity })) }),
                        parts.length ? "Bundle saved" : "No longer a bundle",
                      )
                    }
                  >
                    {parts.length ? "Save bundle" : "Remove bundle"}
                  </Button>
                  <Button onClick={() => setEditBundle(false)}>Cancel</Button>
                </s-stack>
              </>
            )}
          </s-stack>
        </s-box>
      </s-stack>
    </div>
  );
}

const label = (r?: Pick<Row, "title" | "variantTitle"> | null) => (r ? (r.variantTitle ? `${r.title} - ${r.variantTitle}` : r.title) : "(item not found)");
