// The home page: what to reorder this week. Totals at the top, then every variant with its stock, sales rate,
// stock-out date and suggested quantity. Tick items (quantities can be changed) and create purchase orders,
// one per supplier. Open a row to see why, and to change the item's settings.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { shortDay } from "../../lib/dates";
import { fmt, NEEDS_ORDER, type Status } from "../../lib/forecast";
import { planByKey } from "../../lib/plans";
import { Button, Segmented, Select, TextField } from "../polaris";
import { api, post, toast, type ReorderData, type Row } from "./api";
import { ErrorBanner, ItemCell, money, Pager, StatusBadge, SyncStatus, count } from "./ui";
import { RowDetail } from "./RowDetail";
import styles from "./restock.module.css";

const PAGE = 50;
const URGENCY: Record<Status, number> = { out: 0, "order-now": 1, "order-soon": 2, ok: 3, overstock: 4, "no-sales": 5, ignored: 6, bundle: 7 };
type View = "needs" | "all" | "ok" | "overstock" | "no-sales" | "ignored";
const inView = (v: View, s: Status) =>
  v === "all" ? true : v === "needs" ? NEEDS_ORDER.includes(s) : v === "ignored" ? s === "ignored" || s === "bundle" : s === v;

export const label = (r: Pick<Row, "title" | "variantTitle">) => (r.variantTitle ? `${r.title} - ${r.variantTitle}` : r.title);

export function ReorderList({ go }: { go: (path: string) => void }) {
  const [data, setData] = useState<ReorderData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("needs");
  const [supplier, setSupplier] = useState("");
  const [sort, setSort] = useState("urgent");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState("");
  const [created, setCreated] = useState<{ id: string; number: string; supplier: string; lines: number; merged: boolean }[] | null>(null);
  const [assignTo, setAssignTo] = useState("");

  const load = useCallback(
    () =>
      api<ReorderData>("/app/api/reorder")
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

  const rowsById = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.id, r])), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const list = data.rows.filter(
      (r) =>
        inView(view, r.f.status) &&
        (!supplier || (supplier === "none" ? !r.supplierId : r.supplierId === supplier)) &&
        (!needle || [r.title, r.variantTitle, r.sku, r.barcode, r.supplierName, r.vendor].some((v) => String(v || "").toLowerCase().includes(needle))),
    );
    const value = (r: Row) => (qty.get(r.id) ?? r.f.suggested) * (r.unitCost ?? 0);
    return list.sort((a, b) =>
      sort === "name"
        ? label(a).localeCompare(label(b))
        : sort === "value"
          ? value(b) - value(a)
          : sort === "supplier"
            ? (a.supplierName ?? "~").localeCompare(b.supplierName ?? "~") || URGENCY[a.f.status] - URGENCY[b.f.status]
            : URGENCY[a.f.status] - URGENCY[b.f.status] || (a.f.stockoutDay ?? "9999").localeCompare(b.f.stockoutDay ?? "9999") || label(a).localeCompare(label(b)),
    );
  }, [data, view, supplier, q, sort, qty]);

  if (!data) {
    return (
      <s-section>
        <ErrorBanner error={error} />
        {!error && <s-text color="subdued">Loading your reorder list…</s-text>}
      </s-section>
    );
  }

  const cur = data.currency;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const slice = rows.slice(current * PAGE, current * PAGE + PAGE);
  const counts = data.rows.reduce<Record<string, number>>((m, r) => ((m[r.f.status] = (m[r.f.status] ?? 0) + 1), m), {});
  const orderQty = (r: Row) => qty.get(r.id) ?? r.f.suggested;
  const pick = [...selected].map((id) => rowsById.get(id)).filter((r): r is Row => !!r);
  const pickUnits = pick.reduce((s, r) => s + orderQty(r), 0);
  const pickValue = pick.reduce((s, r) => s + orderQty(r) * (r.unitCost ?? 0), 0);
  const pickNoSupplier = pick.filter((r) => !r.supplierId).length;
  const orderable = (r: Row) => !r.isBundle && r.f.status !== "ignored";
  const pageSelectable = slice.filter(orderable);
  const allPicked = pageSelectable.length > 0 && pageSelectable.every((r) => selected.has(r.id));
  const plan = planByKey(data.planKey);
  const neverSynced = !data.syncedAt;

  const toggle = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };
  const createPos = () => {
    setBusy("po");
    setError(null);
    post<{ created: typeof created }>("/app/api/purchase-orders", {
      action: "from-suggestions",
      items: pick.map((r) => ({ variantId: r.id, quantity: orderQty(r) })),
    })
      .then((r) => {
        setCreated(r.created);
        setSelected(new Set());
        setQty(new Map());
        toast(`${r.created!.length} purchase order${r.created!.length === 1 ? "" : "s"} ready`);
        return load();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };
  const bulk = (what: string, body: unknown, done: string) => {
    setBusy(what);
    setError(null);
    post("/app/api/variants", body)
      .then(() => {
        toast(done);
        setSelected(new Set());
        return load();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };
  const selectNeeding = () => {
    const s = new Set(selected);
    for (const r of rows) if (NEEDS_ORDER.includes(r.f.status) && orderQty(r) > 0) s.add(r.id);
    setSelected(s);
  };

  return (
    <s-stack direction="block" gap="base">
      <s-section>
        <SyncStatus syncedAt={data.syncedAt} activeJob={data.activeJob} lastSync={data.lastSync} onSynced={() => void load()} />
      </s-section>

      {!neverSynced && !data.allOrders && (
        <s-banner tone="info" heading="Only 60 days of sales so far">
          Shopify lets the app read just the last 60 days of orders until it approves access to older ones. Forecasts already work, and get
          steadier with more history; the app reads older orders by itself once access is granted.
        </s-banner>
      )}
      {data.variantLimit != null && data.totalVariants > data.variantLimit && (
        <s-banner tone="warning" heading={`Your ${plan.name} plan covers ${count(data.variantLimit)} of your ${count(data.totalVariants)} variants`}>
          Suggestions are made for your best sellers first. The others are listed without a suggestion.{" "}
          <s-link href="/app/plans">See plans</s-link>
        </s-banner>
      )}
      {!neverSynced && data.suppliers.length === 0 && (
        <s-banner tone="info" heading="Next: tell the app who you buy from">
          Purchase orders are made per supplier. Create suppliers from your product vendors in one click, or import a sheet (Stocky exports
          work too). <s-link href="/app/suppliers">Set up suppliers</s-link>
        </s-banner>
      )}

      {created && (
        <s-banner tone="success" heading={`${created.length} purchase order${created.length === 1 ? "" : "s"} ready to check and send`}>
          {created.map((c, i) => (
            <span key={c.id}>
              {i ? " · " : ""}
              <s-link href={`/app/purchase-orders/${c.id}`}>{c.number}</s-link> {c.supplier} ({c.lines} item{c.lines === 1 ? "" : "s"}
              {c.merged ? ", added to the existing draft" : ""})
            </span>
          ))}
        </s-banner>
      )}
      <ErrorBanner error={error} />

      {!neverSynced && (
        <div className={styles.tiles}>
          <button type="button" className={`${styles.tile} ${data.summary.needsOrder ? styles.tileAlert : ""}`} style={{ textAlign: "left", cursor: "pointer", font: "inherit" }} onClick={() => setView("needs")}>
            <span className={styles.muted}>Need ordering</span>
            <b>{count(data.summary.needsOrder)}</b>
            <span className={`${styles.small} ${styles.muted}`}>{data.summary.counts.out ? `${data.summary.counts.out} out of stock` : "none out of stock"}</span>
          </button>
          <div className={styles.tile}>
            <span className={styles.muted}>To order, at cost</span>
            <b>{money(data.summary.toOrderValue, cur, 0)}</b>
            <span className={`${styles.small} ${styles.muted}`}>{count(data.summary.toOrderUnits)} units</span>
          </div>
          <div className={styles.tile}>
            <span className={styles.muted}>Stock value, at cost</span>
            <b>{money(data.summary.stockValue, cur, 0)}</b>
            <span className={`${styles.small} ${styles.muted}`}>
              {data.summary.missingCost ? `${count(data.summary.missingCost)} items have no cost` : data.countedLocations.join(", ")}
            </span>
          </div>
          <button type="button" className={styles.tile} style={{ textAlign: "left", cursor: "pointer", font: "inherit" }} onClick={() => go("/app/dead-stock")}>
            <span className={styles.muted}>Dead stock</span>
            <b>{money(data.summary.deadValue, cur, 0)}</b>
            <span className={`${styles.small} ${styles.muted}`}>
              {count(data.summary.deadCount)} item{data.summary.deadCount === 1 ? "" : "s"}, no sale in {data.settings.deadStockDays} days
            </span>
          </button>
        </div>
      )}

      <s-section heading="Reorder list">
        <s-stack direction="block" gap="base">
          <Segmented<View>
            value={view}
            onChange={(v) => {
              setView(v);
              setPage(0);
            }}
            options={[
              { value: "needs", label: `Needs ordering ${(counts.out ?? 0) + (counts["order-now"] ?? 0) + (counts["order-soon"] ?? 0)}` },
              { value: "ok", label: `OK ${counts.ok ?? 0}` },
              { value: "overstock", label: `Overstock ${counts.overstock ?? 0}` },
              { value: "no-sales", label: `No recent sales ${counts["no-sales"] ?? 0}` },
              { value: "ignored", label: `Not reordered ${(counts.ignored ?? 0) + (counts.bundle ?? 0)}` },
              { value: "all", label: `All ${data.rows.length}` },
            ]}
          />
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base" alignItems="end">
            <TextField
              label="Search"
              placeholder="Name, SKU, barcode, supplier"
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(0);
              }}
            />
            <Select
              label="Supplier"
              value={supplier}
              onChange={(v) => {
                setSupplier(v);
                setPage(0);
              }}
              options={[{ value: "", label: "All suppliers" }, { value: "none", label: "No supplier yet" }, ...data.suppliers.map((s) => ({ value: s.id, label: s.name }))]}
            />
            <Select
              label="Sort by"
              value={sort}
              onChange={setSort}
              options={[
                { value: "urgent", label: "Most urgent first" },
                { value: "value", label: "Order value" },
                { value: "supplier", label: "Supplier" },
                { value: "name", label: "Name" },
              ]}
            />
          </s-grid>
          <s-stack direction="inline" gap="base" alignItems="center">
            <Button onClick={selectNeeding}>Select all that need ordering</Button>
            {selected.size > 0 && (
              <Button variant="tertiary" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            )}
            <a href={data.csvUrl} download>
              Download as CSV
            </a>
          </s-stack>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      className={styles.check}
                      aria-label="Select every item on this page"
                      checked={allPicked}
                      onChange={() => {
                        const s = new Set(selected);
                        for (const r of pageSelectable) {
                          if (allPicked) s.delete(r.id);
                          else s.add(r.id);
                        }
                        setSelected(s);
                      }}
                    />
                  </th>
                  <th>Item</th>
                  <th>Supplier</th>
                  <th className={styles.num}>In stock</th>
                  <th className={styles.num}>Sells / day</th>
                  <th className={styles.num}>Runs out</th>
                  <th className={styles.num}>Order</th>
                  <th className={styles.num}>Cost</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {slice.map((r) => {
                  const isOpen = open === r.id;
                  const value = orderQty(r) * (r.unitCost ?? 0);
                  return (
                    <Fragment key={r.id}>
                      <tr className={isOpen ? styles.open : undefined}>
                        <td>
                          {orderable(r) && (
                            <input type="checkbox" className={styles.check} aria-label={`Select ${label(r)}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                          )}
                        </td>
                        <td>
                          <ItemCell title={r.title} variantTitle={r.variantTitle} sku={r.sku} imageUrl={r.imageUrl} productId={r.productId} />
                        </td>
                        <td>{r.supplierName ?? <span className={styles.muted}>None</span>}</td>
                        <td className={styles.num}>
                          {fmt(r.available)}
                          {r.onOrder ? <div className={`${styles.small} ${styles.muted}`}>+{fmt(r.onOrder)} on order</div> : null}
                          {r.incoming ? <div className={`${styles.small} ${styles.muted}`}>+{fmt(r.incoming)} incoming</div> : null}
                        </td>
                        <td className={styles.num}>
                          {r.f.rate > 0 ? fmt(r.f.rate) : <span className={styles.muted}>0</span>}
                          {r.f.confidence === "low" && <div className={`${styles.small} ${styles.warn}`}>little data</div>}
                          {r.rateOverride != null && <div className={`${styles.small} ${styles.muted}`}>set by you</div>}
                          {r.f.seasonalFactor !== 1 && <div className={`${styles.small} ${styles.muted}`}>seasonal ×{fmt(r.f.seasonalFactor)}</div>}
                        </td>
                        <td className={styles.num}>
                          {r.available <= 0 && r.f.rate > 0 ? (
                            <span className={styles.err}>Now</span>
                          ) : r.f.stockoutDay ? (
                            <>
                              {shortDay(r.f.stockoutDay, data.today)}
                              <div className={`${styles.small} ${styles.muted}`}>{fmt(Math.floor(r.f.daysLeft ?? 0))} days</div>
                            </>
                          ) : (
                            <span className={styles.muted}>-</span>
                          )}
                        </td>
                        <td className={styles.num}>
                          {orderable(r) ? (
                            <input
                              type="number"
                              min={0}
                              className={`${styles.qty} ${qty.has(r.id) ? styles.qtyChanged : ""}`}
                              aria-label={`Quantity to order of ${label(r)}`}
                              value={orderQty(r)}
                              onChange={(e) => {
                                const m = new Map(qty);
                                const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
                                if (v === r.f.suggested) m.delete(r.id);
                                else m.set(r.id, v);
                                setQty(m);
                                if (v > 0 && !selected.has(r.id)) toggle(r.id);
                              }}
                            />
                          ) : (
                            <span className={styles.muted}>-</span>
                          )}
                          {r.qtyOverride != null && <div className={`${styles.small} ${styles.muted}`}>your quantity</div>}
                          {r.casePack && r.casePack > 1 ? <div className={`${styles.small} ${styles.muted}`}>packs of {r.casePack}</div> : null}
                        </td>
                        <td className={styles.num}>{r.unitCost != null && orderQty(r) > 0 ? money(value, cur, 0) : <span className={styles.muted}>-</span>}</td>
                        <td>
                          <StatusBadge status={r.f.status} />
                        </td>
                        <td>
                          <button type="button" className={styles.linkBtn} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
                            {isOpen ? "Close" : "Why?"}
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className={styles.detail}>
                          <td colSpan={10}>
                            <RowDetail
                              key={`${r.id}-${data.syncedAt}-${r.supplierId}-${r.rateOverride}-${r.qtyOverride}-${r.ignore}`}
                              row={r}
                              today={data.today}
                              currency={cur}
                              suppliers={data.suppliers}
                              rowsById={rowsById}
                              defaults={data.settings}
                              onChanged={() => void load()}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {!slice.length && (
                  <tr>
                    <td colSpan={10} className={styles.muted}>
                      {neverSynced
                        ? "Your reorder list appears here after the first sync with Shopify."
                        : data.rows.length === 0
                          ? "No active products in Shopify yet."
                          : view === "needs" && !q && !supplier
                            ? "Nothing needs ordering right now."
                            : "No items match."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={current} pages={pages} total={rows.length} noun="item" onPage={setPage} />
        </s-stack>
      </s-section>

      {selected.size > 0 && (
        <div className={styles.sticky}>
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-text>
              <strong>{selected.size} selected</strong> · {count(pickUnits)} units · {money(pickValue, cur, 0)}
              {pickNoSupplier ? <span className={styles.warn}> · {pickNoSupplier} without a supplier</span> : null}
            </s-text>
            <s-stack direction="inline" gap="small-200" alignItems="end">
              <div style={{ minWidth: 180 }}>
                <Select
                  label="Supplier"
                  labelHidden
                  value={assignTo}
                  onChange={setAssignTo}
                  options={[{ value: "", label: "Set supplier…" }, ...data.suppliers.map((s) => ({ value: s.id, label: s.name })), { value: "-", label: "No supplier" }]}
                />
              </div>
              <Button
                disabled={!assignTo}
                loading={busy === "assign"}
                onClick={() =>
                  bulk("assign", { action: "assign", variantIds: [...selected], supplierId: assignTo === "-" ? null : assignTo }, "Supplier set")
                }
              >
                Apply
              </Button>
              <Button loading={busy === "ignore"} onClick={() => bulk("ignore", { action: "plan", variantIds: [...selected], patch: { ignore: true } }, "Marked as not reordered")}>
                Don&apos;t reorder
              </Button>
              <Button variant="primary" loading={busy === "po"} disabled={pickUnits <= 0} onClick={createPos}>
                Create purchase orders
              </Button>
            </s-stack>
          </s-stack>
        </div>
      )}
    </s-stack>
  );
}
