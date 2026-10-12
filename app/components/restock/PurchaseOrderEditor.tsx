// One purchase order: edit lines and details, send it to the supplier, download it, receive stock (all or part),
// and undo a receipt. Receiving adds the stock in Shopify at the order's location.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Select, TextField } from "../polaris";
import { api, post, toast, type PoLine, type PoResponse, type VariantHit } from "./api";
import { ErrorBanner, ItemCell, count, dateText, money, VariantSearch } from "./ui";
import { PoBadge } from "./PurchaseOrders";
import styles from "./restock.module.css";

interface EditLine {
  id: string | null;
  variantId: string;
  title: string;
  sku: string;
  supplierSku: string;
  quantity: number;
  received: number;
  unitCost: number;
  imageUrl: string | null;
  deleted: boolean;
  inStock: number | null;
}

const toEdit = (l: PoLine): EditLine => ({ ...l });

export function PurchaseOrderEditor({ id, go }: { id: string; go: (path: string) => void }) {
  const [data, setData] = useState<PoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  // Editable copy
  const [lines, setLines] = useState<EditLine[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [shipping, setShipping] = useState("");
  const [currency, setCurrency] = useState("");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  // Panels
  const [panel, setPanel] = useState<"" | "send" | "receive">("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [message, setMessage] = useState("");
  const [arrived, setArrived] = useState<Record<string, number>>({});
  const [updateCost, setUpdateCost] = useState(false);
  const [confirm, setConfirm] = useState<"" | "cancel" | "delete" | "close">("");

  const apply = useCallback((d: PoResponse) => {
    setData(d);
    const p = d.po;
    setLines(p.lines.map(toEdit));
    setSupplierId(p.supplier.id);
    setLocationId(p.locationId);
    setExpectedAt(p.expectedAt ?? "");
    setShipping(p.shippingCost ? String(p.shippingCost) : "");
    setCurrency(p.currency);
    setNotes(p.notes);
    setTo(p.supplier.email);
    setCc(p.supplier.ccEmails);
    setDirty(false);
    setArrived(Object.fromEntries(p.lines.map((l) => [l.id, Math.max(0, l.quantity - l.received)])));
    setUpdateCost(d.updateCostOnReceive && p.currency === p.shopCurrency);
  }, []);

  useEffect(() => {
    api<PoResponse>(`/app/api/purchase-orders/${id}`)
      .then(apply)
      .catch((e) => setError(e.message));
  }, [id, apply]);

  const act = (what: string, body: Record<string, unknown>, done: string, after?: (d: PoResponse) => void) => {
    setBusy(what);
    setError(null);
    setNotice(null);
    post<PoResponse & { deleted?: boolean }>(`/app/api/purchase-orders/${id}`, { action: what, ...body })
      .then((d) => {
        if (d.deleted) {
          toast("Purchase order deleted");
          go("/app/purchase-orders");
          return;
        }
        apply(d);
        toast(done);
        if (d.warnings?.length) setNotice(d.warnings.join(" "));
        setPanel("");
        setConfirm("");
        after?.(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };

  const subtotal = useMemo(() => lines.reduce((s, l) => s + l.quantity * l.unitCost, 0), [lines]);
  if (!data) {
    return (
      <s-section>
        <ErrorBanner error={error} />
        {!error && <s-text color="subdued">Loading…</s-text>}
      </s-section>
    );
  }

  const po = data.po;
  const editable = ["draft", "sent", "partial"].includes(po.status);
  const shippingCost = Number(shipping) || 0;
  const units = lines.reduce((s, l) => s + l.quantity, 0);
  const remaining = po.lines.reduce((s, l) => s + Math.max(0, l.quantity - l.received), 0);
  const belowMin = po.supplier.minOrderValue != null && subtotal < po.supplier.minOrderValue;
  const change = (i: number, patch: Partial<EditLine>) => {
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const save = (then?: () => void) =>
    act(
      "save",
      {
        supplierId,
        locationId,
        expectedAt,
        shippingCost: shipping,
        currency,
        notes,
        lines: lines.map((l) => ({ id: l.id, variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost, supplierSku: l.supplierSku })),
      },
      "Saved",
      then,
    );
  const addLine = (v: VariantHit) => {
    setLines([
      ...lines,
      {
        id: null,
        variantId: v.id,
        title: v.variantTitle ? `${v.productTitle} - ${v.variantTitle}` : v.productTitle,
        sku: v.sku,
        supplierSku: "",
        quantity: 1,
        received: 0,
        unitCost: v.unitCost ?? 0,
        imageUrl: v.imageUrl,
        deleted: false,
        inStock: null,
      },
    ]);
    setDirty(true);
  };

  return (
    <s-stack direction="block" gap="base">
      <ErrorBanner error={error} />
      {notice && <s-banner tone="warning">{notice}</s-banner>}
      {dirty && <s-banner tone="info">You have unsaved changes. Save before sending or receiving.</s-banner>}

      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-heading>
                {po.number} · {po.supplier.name}
              </s-heading>
              <PoBadge status={po.status} closedShort={po.status === "received" && po.lines.some((l) => l.received < l.quantity)} />
            </s-stack>
            <s-stack direction="inline" gap="small-200">
              <a href={data.links.pdf} download>
                PDF
              </a>
              <a href={data.links.csv} download>
                CSV
              </a>
              <a href={data.links.print} target="_blank" rel="noreferrer">
                Print
              </a>
            </s-stack>
          </s-stack>
          <s-text color="subdued">
            Created {dateText(po.createdAt)}
            {po.sentAt ? ` · sent ${dateText(po.sentAt)}` : ""}
            {po.receivedAt ? ` · received ${dateText(po.receivedAt)}` : ""}
            {po.cancelledAt ? ` · cancelled ${dateText(po.cancelledAt)}` : ""} · stock goes to {po.locationName}
          </s-text>

          <s-stack direction="inline" gap="small-200">
            {editable && (
              <Button variant={dirty ? "primary" : "secondary"} onClick={() => save()} loading={busy === "save"} disabled={!dirty}>
                Save
              </Button>
            )}
            {(po.status === "draft" || po.status === "sent") && (
              <Button variant={!dirty && po.status === "draft" ? "primary" : "secondary"} disabled={dirty || !po.lines.length} onClick={() => setPanel(panel === "send" ? "" : "send")}>
                {po.status === "draft" ? "Send to supplier" : "Send again"}
              </Button>
            )}
            {po.status === "draft" && (
              <Button disabled={dirty || !po.lines.length} loading={busy === "mark-sent"} onClick={() => act("mark-sent", {}, "Marked as sent")}>
                Mark as sent
              </Button>
            )}
            {(po.status === "sent" || po.status === "partial" || po.status === "draft") && (
              <Button variant={po.status !== "draft" && !dirty ? "primary" : "secondary"} disabled={dirty || !remaining} onClick={() => setPanel(panel === "receive" ? "" : "receive")}>
                Receive stock
              </Button>
            )}
            {po.status === "sent" && !po.lines.some((l) => l.received) && (
              <Button loading={busy === "back-to-draft"} onClick={() => act("back-to-draft", {}, "Back to draft")}>
                Back to draft
              </Button>
            )}
            {po.status === "partial" && (
              <Button onClick={() => setConfirm("close")}>Close order</Button>
            )}
            {(po.status === "draft" || po.status === "sent") && !po.lines.some((l) => l.received) && (
              <Button tone="critical" onClick={() => setConfirm("cancel")}>
                Cancel order
              </Button>
            )}
            {(po.status === "cancelled" || (po.status === "received" && po.lines.some((l) => l.received < l.quantity))) && (
              <Button loading={busy === "reopen"} onClick={() => act("reopen", {}, "Reopened")}>
                Reopen
              </Button>
            )}
            {(po.status === "draft" || po.status === "cancelled") && !po.lines.some((l) => l.received) && (
              <Button tone="critical" variant="tertiary" onClick={() => setConfirm("delete")}>
                Delete
              </Button>
            )}
          </s-stack>

          {confirm && (
            <s-banner tone="warning" heading={confirm === "delete" ? "Delete this purchase order?" : confirm === "cancel" ? "Cancel this purchase order?" : "Close this order?"}>
              <s-stack direction="block" gap="small-200">
                <s-text>
                  {confirm === "delete"
                    ? "It is removed for good."
                    : confirm === "cancel"
                      ? "Its items stop counting as on order. You can reopen it later."
                      : `${count(remaining)} units were not received. Closing says they are not coming, so they stop counting as on order. You can reopen it.`}
                </s-text>
                <s-stack direction="inline" gap="small-200">
                  <Button tone="critical" loading={busy === confirm} onClick={() => act(confirm, {}, confirm === "delete" ? "Deleted" : confirm === "cancel" ? "Cancelled" : "Closed")}>
                    {confirm === "delete" ? "Delete" : confirm === "cancel" ? "Cancel order" : "Close order"}
                  </Button>
                  <Button onClick={() => setConfirm("")}>Keep it</Button>
                </s-stack>
              </s-stack>
            </s-banner>
          )}

          {panel === "send" && (
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Email this order to {po.supplier.name}</s-heading>
                <TextField label="To" value={to} onChange={setTo} placeholder="supplier@example.com" details="Several addresses: separate with commas" />
                <TextField label="Cc" value={cc} onChange={setCc} />
                <TextField label="Message (optional)" value={message} onChange={setMessage} />
                <s-text color="subdued">The PDF and a CSV are attached. Replies go to your store email (set in Settings).</s-text>
                <s-stack direction="inline" gap="small-200">
                  <Button variant="primary" loading={busy === "send"} onClick={() => act("send", { to, cc, message }, "Sent to the supplier")}>
                    Send
                  </Button>
                  <Button onClick={() => setPanel("")}>Cancel</Button>
                </s-stack>
              </s-stack>
            </s-box>
          )}

          {panel === "receive" && (
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Receive stock at {po.locationName}</s-heading>
                <s-text color="subdued">Enter what arrived. The stock is added in Shopify straight away. A mistake can be undone below.</s-text>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className={styles.num}>Ordered</th>
                        <th className={styles.num}>Received so far</th>
                        <th className={styles.num}>Arrived now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {po.lines.map((l) => (
                        <tr key={l.id}>
                          <td>{l.title}</td>
                          <td className={styles.num}>{count(l.quantity)}</td>
                          <td className={styles.num}>{count(l.received)}</td>
                          <td className={styles.num}>
                            <input
                              type="number"
                              min={0}
                              className={styles.qty}
                              aria-label={`Arrived now: ${l.title}`}
                              value={arrived[l.id] ?? 0}
                              onChange={(e) => setArrived({ ...arrived, [l.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Checkbox
                  label={`Update "cost per item" in Shopify to this order's costs${po.currency !== po.shopCurrency ? ` (not possible: the order is in ${po.currency})` : ""}`}
                  checked={updateCost}
                  onChange={setUpdateCost}
                />
                <s-stack direction="inline" gap="small-200">
                  <Button
                    variant="primary"
                    loading={busy === "receive"}
                    onClick={() =>
                      act("receive", { lines: Object.entries(arrived).map(([lineId, quantity]) => ({ lineId, quantity })), updateCost }, "Stock added in Shopify")
                    }
                  >
                    Add {count(Object.values(arrived).reduce((s, n) => s + n, 0))} units to stock
                  </Button>
                  <Button onClick={() => setArrived(Object.fromEntries(po.lines.map((l) => [l.id, 0])))}>Set all to 0</Button>
                  <Button onClick={() => setPanel("")}>Cancel</Button>
                </s-stack>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Items">
        <s-stack direction="block" gap="base">
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Supplier SKU</th>
                  <th className={styles.num}>In stock</th>
                  <th className={styles.num}>Quantity</th>
                  <th className={styles.num}>Received</th>
                  <th className={styles.num}>Unit cost</th>
                  <th className={styles.num}>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.id ?? l.variantId}>
                    <td>
                      <ItemCell
                        title={l.title}
                        sku={l.sku}
                        imageUrl={l.imageUrl}
                        extra={l.deleted ? <div className={`${styles.small} ${styles.warn}`}>No longer in Shopify</div> : null}
                      />
                    </td>
                    <td>
                      {editable ? (
                        <input className={`${styles.qty} ${styles.qtyWide}`} style={{ textAlign: "left" }} aria-label={`Supplier SKU of ${l.title}`} value={l.supplierSku} onChange={(e) => change(i, { supplierSku: e.target.value.slice(0, 100) })} />
                      ) : (
                        l.supplierSku
                      )}
                    </td>
                    <td className={styles.num}>{l.inStock == null ? "-" : count(l.inStock)}</td>
                    <td className={styles.num}>
                      {editable ? (
                        <input
                          type="number"
                          min={l.received}
                          className={styles.qty}
                          aria-label={`Quantity of ${l.title}`}
                          value={l.quantity}
                          onChange={(e) => change(i, { quantity: Math.max(l.received, Math.floor(Number(e.target.value) || 0)) })}
                        />
                      ) : (
                        count(l.quantity)
                      )}
                    </td>
                    <td className={styles.num}>{count(l.received)}</td>
                    <td className={styles.num}>
                      {editable ? (
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className={styles.qty}
                          aria-label={`Unit cost of ${l.title}`}
                          value={l.unitCost}
                          onChange={(e) => change(i, { unitCost: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      ) : (
                        money(l.unitCost, po.currency)
                      )}
                    </td>
                    <td className={styles.num}>{money(l.quantity * l.unitCost, po.currency)}</td>
                    <td>
                      {editable && !l.received && (
                        <button
                          type="button"
                          className={styles.linkBtn}
                          onClick={() => {
                            setLines(lines.filter((_, j) => j !== i));
                            setDirty(true);
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!lines.length && (
                  <tr>
                    <td colSpan={8} className={styles.muted}>
                      No items yet. Add some below.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>
                    {lines.length} items · {count(units)} units
                  </td>
                  <td colSpan={3} className={styles.num}>
                    Subtotal
                    {shippingCost ? (
                      <>
                        <br />
                        Shipping
                        <br />
                        Total
                      </>
                    ) : null}
                  </td>
                  <td className={styles.num}>
                    {money(subtotal, currency || po.currency)}
                    {shippingCost ? (
                      <>
                        <br />
                        {money(shippingCost, currency || po.currency)}
                        <br />
                        {money(subtotal + shippingCost, currency || po.currency)}
                      </>
                    ) : null}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {belowMin && (
            <s-banner tone="warning">
              {po.supplier.name}&apos;s minimum order is {money(po.supplier.minOrderValue, po.currency)}; this order is {money(subtotal, po.currency)}.
            </s-banner>
          )}
          {editable && (
            <div style={{ maxWidth: 480 }}>
              <VariantSearch onPick={addLine} exclude={lines.map((l) => l.variantId)} />
            </div>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Details">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
          {po.status === "draft" ? (
            <Select
              label="Supplier"
              value={supplierId}
              onChange={(v) => {
                setSupplierId(v);
                setDirty(true);
              }}
              options={data.suppliers.map((s) => ({ value: s.id, label: s.name }))}
            />
          ) : (
            <s-text>
              Supplier: <strong>{po.supplier.name}</strong>
              {po.supplier.email ? ` · ${po.supplier.email}` : ""}
            </s-text>
          )}
          <Select
            label="Receive stock at"
            value={locationId}
            onChange={(v) => {
              setLocationId(v);
              setDirty(true);
            }}
            options={[
              ...data.locations.map((l) => ({ value: l.id, label: l.name })),
              ...(data.locations.some((l) => l.id === po.locationId) ? [] : [{ value: po.locationId, label: `${po.locationName} (inactive)` }]),
            ]}
          />
          <label className={styles.small}>
            Expected by
            <input
              type="date"
              className={styles.qty}
              style={{ width: "100%", textAlign: "left", display: "block", marginTop: 4 }}
              value={expectedAt}
              disabled={!editable}
              onChange={(e) => {
                setExpectedAt(e.target.value);
                setDirty(true);
              }}
            />
          </label>
          <TextField
            label={`Shipping cost (${currency})`}
            value={shipping}
            onChange={(v) => {
              setShipping(v);
              setDirty(true);
            }}
          />
          <TextField
            label="Currency"
            value={currency}
            onChange={(v) => {
              setCurrency(v.toUpperCase().slice(0, 3));
              setDirty(true);
            }}
          />
        </s-grid>
        <div style={{ marginTop: 12 }}>
          <TextField
            label="Notes printed on the order"
            value={notes}
            onChange={(v) => {
              setNotes(v);
              setDirty(true);
            }}
          />
        </div>
      </s-section>

      {po.receipts.length > 0 && (
        <s-section heading="Stock received">
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {po.receipts.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>
                      {r.undoOf ? "Undo: " : ""}
                      {r.lines.map((l) => `${l.quantity > 0 ? "+" : ""}${l.quantity} ${l.title}`).join(", ")}
                      {r.error && <div className={`${styles.small} ${styles.err}`}>{r.error}</div>}
                    </td>
                    <td>
                      <s-badge tone={r.status === "done" ? "success" : r.status === "failed" ? "critical" : "neutral"}>
                        {r.status === "done" ? "Added in Shopify" : r.status === "failed" ? "Failed" : r.status === "undone" ? "Undone" : "In progress"}
                      </s-badge>
                    </td>
                    <td>
                      {r.status === "done" && !r.undoOf && (
                        <Button variant="tertiary" loading={busy === "undo-receipt"} onClick={() => act("undo-receipt", { receiptId: r.id }, "Receipt undone")}>
                          Undo
                        </Button>
                      )}
                      {(r.status === "failed" || r.status === "pending") && (
                        <Button variant="tertiary" loading={busy === "retry-receipt"} onClick={() => act("retry-receipt", { receiptId: r.id }, "Stock added in Shopify")}>
                          Try again
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </s-section>
      )}
    </s-stack>
  );
}
