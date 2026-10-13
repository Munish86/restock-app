// Import suppliers and their terms from a sheet: upload Excel/CSV or link a Google Sheet, check the columns
// (filled in automatically from their names), preview what changes, then import.
import { useMemo, useRef, useState } from "react";
import { IMPORT_FIELDS, type ImportColumns, type ImportField } from "../../lib/import-columns";
import { Button, Checkbox, NumberField, Segmented, Select, TextField } from "../polaris";
import { api, ApiError, post, toast, type JobInfo, type Supplier } from "./api";
import { ErrorBanner, ProgressBar, count, useJob } from "./ui";
import styles from "./restock.module.css";

interface SheetInfo {
  name: string;
  worksheets: string[];
  headers: string[];
  headerRow: number;
  rowCount: number;
  preview: Record<string, string>[];
  suggested: ImportColumns;
}

interface ReportRow {
  row: number;
  key: string;
  item: string;
  supplier: string;
  action: string;
  changes: string;
  warnings: string;
}

const TONE: Record<string, "success" | "info" | "warning" | "critical" | "neutral"> = {
  Linked: "success",
  Updated: "success",
  "Will link": "info",
  "Will update": "info",
  "No change": "neutral",
  "Not found": "warning",
  Skipped: "warning",
  Error: "critical",
};

export function SupplierImport({ suppliers, onImported }: { suppliers: Pick<Supplier, "id" | "name">[]; onImported: () => void }) {
  const [source, setSource] = useState<"file" | "google">("file");
  const [fileId, setFileId] = useState("");
  const [url, setUrl] = useState("");
  const [worksheet, setWorksheet] = useState("");
  const [headerRow, setHeaderRow] = useState<number | "">("");
  const [sheet, setSheet] = useState<SheetInfo | null>(null);
  const [columns, setColumns] = useState<ImportColumns>({});
  const [matchBy, setMatchBy] = useState<"sku" | "barcode">("sku");
  const [defaultSupplierId, setDefaultSupplierId] = useState("");
  const [createSuppliers, setCreateSuppliers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [over, setOver] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [report, setReport] = useState<{ rows: ReportRow[]; newSuppliers: string[]; csvUrl: string; command: string; counts: Record<string, number> } | null>(null);
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const job = useJob(jobId, (j: JobInfo) => {
    setJobId(null);
    if (j.status === "failed") {
      setError(j.error || "The import failed.");
      return;
    }
    api<{ rows: ReportRow[]; newSuppliers: string[]; csvUrl: string }>(`/app/api/jobs/${j.id}?report=json`)
      .then((r) => {
        setReport({ ...r, command: j.command, counts: j.counts ?? {} });
        setFilter("");
        if (j.command === "import") {
          toast("Suppliers imported");
          onImported();
        }
      })
      .catch((e) => setError(e.message));
  });

  const readSheet = (opts: { fileId?: string; worksheet?: string; headerRow?: number | "" } = {}) => {
    setBusy("read");
    setError(null);
    setReport(null);
    const q = new URLSearchParams({
      source,
      ...(source === "file" ? { fileId: opts.fileId ?? fileId } : { url }),
      worksheet: opts.worksheet ?? worksheet,
      headerRow: String(opts.headerRow ?? headerRow ?? ""),
    });
    return api<{ sheet: SheetInfo | null; error?: string }>(`/app/api/sheet?${q}`)
      .then((r) => {
        if (!r.sheet) throw new ApiError(r.error || "The sheet could not be read.", 400);
        setSheet(r.sheet);
        // Keep choices that still exist in this sheet; fill the rest from the column names
        const kept = Object.fromEntries(Object.entries(columns).filter(([, c]) => c && r.sheet!.headers.includes(c)));
        setColumns({ ...r.sheet.suggested, ...kept });
        if (!r.sheet.suggested.sku && r.sheet.suggested.barcode) setMatchBy("barcode");
      })
      .catch((e) => {
        setSheet(null);
        setError(e.message);
      })
      .finally(() => setBusy(""));
  };

  const upload = async (file: File) => {
    setBusy("upload");
    setError(null);
    try {
      const res = await api<{ file: { id: string } }>(`/app/api/files?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      setFileId(res.file.id);
      setWorksheet("");
      setHeaderRow("");
      setBusy("");
      await readSheet({ fileId: res.file.id, worksheet: "", headerRow: "" });
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  };

  const options = () => ({
    source,
    ...(source === "file" ? { fileId } : { url }),
    worksheet,
    headerRow: headerRow || 0,
    matchBy,
    columns,
    defaultSupplierId: defaultSupplierId || undefined,
    createSuppliers,
  });
  const start = (command: "import-plan" | "import") => {
    setBusy(command);
    setError(null);
    post<{ job: { id: string } }>("/app/api/jobs", { command, options: options() })
      .then((r) => setJobId(r.job.id))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };

  const ready = !!sheet && !!columns[matchBy] && (!!columns.supplier || !!defaultSupplierId);
  const rows = useMemo(() => (report ? report.rows.filter((r) => !filter || r.action === filter) : []), [report, filter]);
  const changes = report ? (report.counts["Will link"] ?? 0) + (report.counts["Will update"] ?? 0) : 0;

  return (
    <s-section heading="Import suppliers from a sheet">
      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          One row per item: its SKU (or barcode) and supplier, plus any of supplier SKU, cost, case pack, minimum order and lead time. Stocky
          exports, Shopify product exports and supplier price lists work; the columns are recognised by name.{" "}
          <a href="/templates/Reorder-Desk-Supplier-Template.csv" download>
            Download a template
          </a>
          . Empty cells never erase what is saved.
        </s-text>
        <ErrorBanner error={error} />
        <Segmented
          value={source}
          onChange={(v) => {
            setSource(v);
            setSheet(null);
            setReport(null);
          }}
          options={[
            { value: "file", label: "Excel or CSV file" },
            { value: "google", label: "Google Sheet" },
          ]}
        />
        {source === "file" ? (
          <div
            className={`${styles.drop} ${over ? styles.dropOver : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void upload(f);
            }}
          >
            <s-stack direction="block" gap="small-200" alignItems="center">
              <s-text>{sheet && source === "file" ? `${sheet.name}: ${count(sheet.rowCount)} rows` : "Drop a sheet here (.xlsx, .xls, .csv)"}</s-text>
              <Button onClick={() => input.current?.click()} loading={busy === "upload" || busy === "read"}>
                {sheet ? "Choose another file" : "Choose file"}
              </Button>
              <input
                ref={input}
                type="file"
                accept=".xlsx,.xlsm,.xls,.csv,.txt"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
            </s-stack>
          </div>
        ) : (
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <div style={{ flex: 1, minWidth: 280 }}>
              <TextField
                label="Google Sheet link"
                value={url}
                onChange={setUrl}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                details={`Share it as "Anyone with the link can view" (or with the app's Google email, shown in Settings).`}
              />
            </div>
            <Button onClick={() => void readSheet()} disabled={!url.trim()} loading={busy === "read"}>
              Read sheet
            </Button>
          </s-stack>
        )}

        {sheet && (
          <>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              {sheet.worksheets.length > 1 && (
                <Select
                  label="Tab"
                  value={worksheet || sheet.worksheets[0]}
                  onChange={(v) => {
                    setWorksheet(v);
                    void readSheet({ worksheet: v });
                  }}
                  options={sheet.worksheets.map((w) => ({ value: w, label: w }))}
                />
              )}
              <NumberField
                label="Header row"
                value={headerRow}
                onChange={setHeaderRow}
                min={1}
                max={50}
                placeholder={`Found: row ${sheet.headerRow}`}
              />
              <Select
                label="Find items by"
                value={matchBy}
                onChange={(v) => setMatchBy(v as "sku" | "barcode")}
                options={[
                  { value: "sku", label: "SKU" },
                  { value: "barcode", label: "Barcode" },
                ]}
              />
            </s-grid>
            {headerRow !== "" && headerRow !== sheet.headerRow && (
              <div>
                <Button onClick={() => void readSheet()}>Use row {headerRow} as the header row</Button>
              </div>
            )}

            <s-heading>Columns</s-heading>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
              {IMPORT_FIELDS.map((f) => (
                <Select
                  key={f.key}
                  label={f.label + (f.key === matchBy ? " (required)" : f.key === "supplier" && !defaultSupplierId ? " (required)" : "")}
                  details={f.hint}
                  value={columns[f.key] ?? ""}
                  onChange={(v) => setColumns({ ...columns, [f.key as ImportField]: v || undefined })}
                  options={[{ value: "", label: "Not in this sheet" }, ...sheet.headers.map((h) => ({ value: h, label: h }))]}
                />
              ))}
            </s-grid>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="base">
              <Select
                label={columns.supplier ? "Supplier for rows without one" : "Supplier for every row"}
                value={defaultSupplierId}
                onChange={setDefaultSupplierId}
                options={[{ value: "", label: columns.supplier ? "None: skip those rows" : "Choose a supplier" }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]}
              />
              <Checkbox label="Create suppliers that do not exist yet" checked={createSuppliers} onChange={setCreateSuppliers} />
            </s-grid>

            {sheet.preview.length > 0 && (
              <details>
                <summary className={styles.muted}>First rows of the sheet</summary>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        {sheet.headers.slice(0, 10).map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.preview.map((r, i) => (
                        <tr key={i}>
                          {sheet.headers.slice(0, 10).map((h) => (
                            <td key={h}>{r[h]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            <s-stack direction="inline" gap="small-200">
              <Button variant={report?.command === "import-plan" ? "secondary" : "primary"} disabled={!ready || !!jobId} loading={busy === "import-plan"} onClick={() => start("import-plan")}>
                Preview import
              </Button>
              {report?.command === "import-plan" && (
                <Button variant="primary" disabled={!changes || !!jobId} loading={busy === "import"} onClick={() => start("import")}>
                  Import {count(changes)} change{changes === 1 ? "" : "s"}
                </Button>
              )}
            </s-stack>
            {!ready && <s-text color="subdued">Choose the {matchBy === "sku" ? "SKU" : "barcode"} column and the supplier column (or one supplier for every row).</s-text>}
          </>
        )}

        {jobId && (
          <s-stack direction="block" gap="small-200">
            <s-text>{job?.progress?.step ?? "Starting"}…</s-text>
            <ProgressBar done={job?.progress?.done ?? 0} total={job?.progress?.total ?? 3} />
          </s-stack>
        )}

        {report && (
          <s-stack direction="block" gap="small-200">
            <s-heading>{report.command === "import" ? "Imported" : "Preview: nothing is saved yet"}</s-heading>
            {report.newSuppliers.length > 0 && (
              <s-text>
                {report.command === "import" ? "New suppliers: " : "New suppliers to create: "}
                {report.newSuppliers.join(", ")}
              </s-text>
            )}
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "", label: `All ${report.rows.length}` },
                ...Object.entries(report.counts)
                  .filter(([k]) => !k.startsWith("New suppliers"))
                  .map(([k, n]) => ({ value: k, label: `${k} ${n}` })),
              ]}
            />
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>{matchBy === "sku" ? "SKU" : "Barcode"}</th>
                    <th>Item</th>
                    <th>Supplier</th>
                    <th>Result</th>
                    <th>Changes</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 500).map((r, i) => (
                    <tr key={`${r.row}-${i}`}>
                      <td>{r.row}</td>
                      <td>{r.key}</td>
                      <td>{r.item}</td>
                      <td>{r.supplier}</td>
                      <td>
                        <s-badge tone={TONE[r.action] ?? "neutral"}>{r.action}</s-badge>
                      </td>
                      <td>{r.changes}</td>
                      <td className={styles.warn}>{r.warnings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <s-text color="subdued">
              {rows.length > 500 ? `First 500 of ${count(rows.length)} rows shown. ` : ""}
              <a href={report.csvUrl} download>
                Download the full report (CSV)
              </a>
            </s-text>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
