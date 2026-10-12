// Small pieces shared by the Restock pages: number and money formats, status badges, the item cell, a weekly
// sales chart, paging, the sync status, and the variant search box.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt, STATUS_LABEL, type Status } from "../../lib/forecast";
import { api, isActive, post, toast, type JobInfo, type VariantHit } from "./api";
import { Button } from "../polaris";
import styles from "./restock.module.css";

export function money(n: number | null | undefined, currency: string, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "-";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: digits, minimumFractionDigits: digits ? 2 : 0 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(digits)}`;
  }
}

export const count = (n: number) => new Intl.NumberFormat().format(Math.round(n));

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export const dateText = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

const TONE: Record<Status, "critical" | "warning" | "info" | "success" | "neutral" | "caution"> = {
  out: "critical",
  "order-now": "critical",
  "order-soon": "warning",
  ok: "success",
  overstock: "info",
  "no-sales": "neutral",
  ignored: "neutral",
  bundle: "neutral",
};

export function StatusBadge({ status }: { status: Status }) {
  return <s-badge tone={TONE[status]}>{STATUS_LABEL[status]}</s-badge>;
}

// "gid://shopify/Product/123" -> link that opens the product inside Shopify Admin
export const productLink = (productId: string) => `shopify:admin/products/${productId.split("/").pop()}`;

export function ItemCell({
  title,
  variantTitle,
  sku,
  imageUrl,
  productId,
  extra,
}: {
  title: string;
  variantTitle?: string;
  sku?: string;
  imageUrl?: string | null;
  productId?: string;
  extra?: ReactNode;
}) {
  return (
    <div className={styles.item}>
      {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span className={styles.noImg} />}
      <div>
        {productId ? <s-link href={productLink(productId)}>{title}</s-link> : <span>{title}</span>}
        {variantTitle ? <div>{variantTitle}</div> : null}
        {sku ? <div className={`${styles.muted} ${styles.small}`}>{sku}</div> : null}
        {extra}
      </div>
    </div>
  );
}

// Units sold per week, oldest on the left
export function Sparkline({ weeks, width = 156, height = 36 }: { weeks: number[]; width?: number; height?: number }) {
  const data = [...weeks].reverse();
  const max = Math.max(1, ...data);
  const w = width / Math.max(1, data.length);
  return (
    <svg className={styles.spark} width={width} height={height} role="img" aria-label={`Weekly sales, oldest first: ${data.join(", ")}`}>
      {data.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * (height - 2)) : 1;
        return (
          <rect key={i} x={i * w + 1} y={height - h} width={Math.max(1, w - 2)} height={h} rx={1.5} fill={v ? "#5c6ac4" : "#d4d4d4"}>
            <title>{`${data.length - i} week${data.length - i === 1 ? "" : "s"} ago: ${v} sold`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function Pager({ page, pages, total, noun, onPage }: { page: number; pages: number; total: number; noun: string; onPage: (p: number) => void }) {
  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end">
      {pages > 1 && (
        <Button onClick={() => onPage(page - 1)} disabled={page === 0}>
          Previous
        </Button>
      )}
      <s-text color="subdued">
        {pages > 1 ? `Page ${page + 1} of ${pages} · ` : ""}
        {count(total)} {total === 1 ? noun : `${noun}s`}
      </s-text>
      {pages > 1 && (
        <Button onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>
          Next
        </Button>
      )}
    </s-stack>
  );
}

export function ErrorBanner({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <s-banner tone="critical">{error}</s-banner>;
}

export const qtyText = (n: number) => fmt(n);

// Polls a job until it finishes. onDone runs once when it does.
export function useJob(jobId: string | null | undefined, onDone?: (j: JobInfo) => void) {
  const [job, setJob] = useState<JobInfo | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () =>
      api<{ job: JobInfo }>(`/app/api/jobs/${jobId}`)
        .then(({ job: j }) => {
          if (stop) return;
          setJob(j);
          if (isActive(j)) timer = setTimeout(tick, 1500);
          else done.current?.(j);
        })
        .catch(() => {
          if (!stop) timer = setTimeout(tick, 4000);
        });
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [jobId]);
  return job;
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className={styles.bar} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

// "Synced 2 h ago · Sync now", a progress bar while a sync runs, and the error when the last one failed
export function SyncStatus({
  syncedAt,
  activeJob,
  lastSync,
  onSynced,
}: {
  syncedAt: string | null;
  activeJob: JobInfo | null;
  lastSync: JobInfo | null;
  onSynced: () => void;
}) {
  const [jobId, setJobId] = useState<string | null>(activeJob?.command === "sync" && isActive(activeJob) ? activeJob.id : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const job = useJob(jobId, (j) => {
    setJobId(null);
    if (j.status === "done") {
      toast("Synced with Shopify");
      onSynced();
    } else if (j.status === "failed") setError(j.error || "The sync failed.");
  });
  const running = !!jobId;
  const start = (full = false) => {
    setBusy(true);
    setError(null);
    post<{ job: { id: string } }>("/app/api/jobs", { command: "sync", ...(full ? { full: true } : {}) })
      .then(({ job: j }) => setJobId(j.id))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const failed = !running && !error && lastSync?.status === "failed" ? lastSync.error : null;
  const otherJob = activeJob && activeJob.command !== "sync" && isActive(activeJob);

  return (
    <s-stack direction="block" gap="small-200">
      {running ? (
        <s-stack direction="block" gap="small-200">
          <s-text>
            {syncedAt ? "Syncing with Shopify" : "Reading your products, stock and sales from Shopify. This usually takes a minute or two."}
            {job?.progress?.step ? ` · ${job.progress.step}` : ""}
          </s-text>
          <ProgressBar done={job?.progress?.done ?? 0} total={job?.progress?.total ?? 6} />
        </s-stack>
      ) : (
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text color="subdued">{syncedAt ? `Synced with Shopify ${ago(syncedAt)}. Stock updates live; sales every 6 hours.` : "Not synced with Shopify yet."}</s-text>
          <Button onClick={() => start(false)} loading={busy} disabled={!!otherJob}>
            Sync now
          </Button>
        </s-stack>
      )}
      <ErrorBanner error={error || failed} />
    </s-stack>
  );
}

// Search box for variants (purchase order lines, bundle parts). Calls onPick with the chosen variant.
export function VariantSearch({ onPick, label = "Add an item", exclude = [] }: { onPick: (v: VariantHit) => void; label?: string; exclude?: string[] }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<VariantHit[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!q.trim()) return;
    const t = setTimeout(() => {
      api<{ variants: VariantHit[] }>(`/app/api/variants?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setHits(r.variants);
          setOpen(true);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const shown = q.trim() ? hits.filter((h) => !exclude.includes(h.id)) : [];
  return (
    <div className={styles.search}>
      <label className={styles.small}>
        {label}
        <input
          className={styles.qty}
          style={{ width: "100%", textAlign: "left", display: "block", marginTop: 4 }}
          type="search"
          placeholder="Search by name, SKU or barcode"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
      </label>
      {open && shown.length > 0 && (
        <div className={styles.results}>
          {shown.map((h) => (
            <button
              key={h.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(h);
                setQ("");
                setOpen(false);
              }}
            >
              {h.imageUrl ? <img src={h.imageUrl} alt="" width={28} height={28} style={{ borderRadius: 4, objectFit: "cover" }} /> : null}
              <span>
                {h.productTitle}
                {h.variantTitle ? ` - ${h.variantTitle}` : ""}
                <span className={`${styles.muted} ${styles.small}`}>{h.sku ? ` · ${h.sku}` : ""}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim() && !shown.length && (
        <div className={styles.results}>
          <div style={{ padding: 10 }} className={styles.muted}>
            No items found.
          </div>
        </div>
      )}
    </div>
  );
}
