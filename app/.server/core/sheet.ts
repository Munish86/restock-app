import * as XLSX from "xlsx";
import { sheetRef, type Google } from "./google";

export type Table = unknown[][];
export interface Row {
  __row: number; // line number in the sheet
  [column: string]: string | number;
}

// Where the sheet comes from: an uploaded file (bytes + original name) or a Google Sheet link
export type SheetSource =
  | { kind: "file"; name: string; data: Buffer }
  | { kind: "google"; url: string };

interface SheetMeta {
  properties: { sheetId: number; title: string };
}

// Which tab, and which row holds the column names (0 or "" = find it)
export interface SheetOptions {
  worksheet: string;
  header_row: number | string;
}

// Uploaded files come from merchants: refuse anything that would take too much memory to parse
export const MAX_SHEET_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 50_000;

function tableFromWorkbook(wb: XLSX.WorkBook, worksheet?: string): Table {
  const name = worksheet || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`The sheet has no tab called "${worksheet}". Tabs: ${wb.SheetNames.join(", ")}`);
  // blankrows: true keeps empty rows so row numbers match the sheet; empty rows are dropped later
  const table = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", raw: false, blankrows: true });
  // If the used range does not start at row 1, pad so table index 0 is sheet row 1
  const start = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).s.r : 0;
  return [...Array.from({ length: start }, () => []), ...table];
}

const readWorkbook = (data: Buffer, opts: XLSX.ParsingOptions = {}) =>
  XLSX.read(data, { type: "buffer", dense: true, ...opts });

// Excel adds a byte-order mark (U+FEFF) at the start of CSV files it saves
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const parseCsv = (text: string) =>
  tableFromWorkbook(XLSX.read(stripBom(text), { type: "string", raw: true, dense: true }));

const isCsv = (name: string) => /\.(csv|txt)$/i.test(name);

function checkSize(data: Buffer) {
  if (data.length > MAX_SHEET_BYTES) {
    throw new Error(`The sheet is ${(data.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_SHEET_BYTES / 1024 / 1024} MB.`);
  }
}

async function loadTable(src: SheetSource, opts: SheetOptions, google: Google): Promise<Table> {
  if (src.kind === "file") {
    checkSize(src.data);
    if (isCsv(src.name)) return parseCsv(src.data.toString("utf8"));
    return tableFromWorkbook(readWorkbook(src.data), opts.worksheet);
  }

  const { id, gid } = sheetRef(src.url);
  if (google.enabled) {
    let title = opts.worksheet;
    if (!title) {
      const meta = await google.get(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
      const s = gid
        ? (meta.sheets as SheetMeta[]).find((x) => String(x.properties.sheetId) === gid)
        : meta.sheets[0];
      if (!s) throw new Error("No tab found in the Google Sheet.");
      title = s.properties.title;
    }
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
    try {
      const data = await google.get(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
      );
      return data.values || [];
    } catch (e) {
      // Not shared with the service account: a sheet shared as "Anyone with the link" can still be read
      if (!/Google API error (403|404)/.test(String((e as Error).message))) throw e;
      return publicTable(id, gid, opts.worksheet).catch(() => {
        throw e;
      });
    }
  }
  return publicTable(id, gid, opts.worksheet);
}

// A sheet shared as "Anyone with the link" can be read through the export, without signing in.
// A chosen tab is read from the full workbook; otherwise the tab in the link (gid) is read as CSV.
async function publicTable(id: string, gid: string, worksheet: string): Promise<Table> {
  if (worksheet) return tableFromWorkbook(await publicWorkbook(id), worksheet);
  const res = await fetch(
    `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  const text = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) throw new Error(NOT_SHARED);
  checkSize(Buffer.from(text));
  return parseCsv(text);
}

const NOT_SHARED =
  'Could not read the Google Sheet. Share it with the app\'s Google email, or as "Anyone with the link can view".';

// A Google Sheet shared as "Anyone with the link", downloaded as a whole workbook (all tabs)
async function publicWorkbook(id: string): Promise<XLSX.WorkBook> {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, {
    signal: AbortSignal.timeout(60_000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buf.subarray(0, 2).toString() !== "PK") throw new Error(NOT_SHARED);
  checkSize(buf);
  return readWorkbook(buf);
}

// Tab names of an Excel file, or of a Google Sheet
export async function listWorksheets(src: SheetSource, google: Google): Promise<string[]> {
  if (src.kind === "file") {
    if (isCsv(src.name)) return [];
    checkSize(src.data);
    return readWorkbook(src.data, { bookSheets: true }).SheetNames;
  }
  const { id } = sheetRef(src.url);
  if (google.enabled) {
    try {
      const meta = await google.get(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
      return (meta.sheets as SheetMeta[]).map((s) => s.properties.title);
    } catch {
      /* fall back to the public export */
    }
  }
  return (await publicWorkbook(id)).SheetNames;
}

// The header row is the first row that looks like column names: it has at least half as many filled
// cells as the fullest row near the top. This skips title or note rows above the real headers.
export function detectHeaderRow(table: Table): number {
  const counts = table.slice(0, 20).map((r) => (r || []).filter((v) => String(v ?? "").trim() !== "").length);
  const max = Math.max(0, ...counts);
  const idx = counts.findIndex((n) => n >= Math.max(2, Math.ceil(max * 0.5)));
  return idx < 0 ? 0 : idx;
}

export interface SheetRows {
  headers: string[];
  rows: Row[];
  headerRow: number;
  duplicateHeaders: string[];
}

// Returns { headers, rows, headerRow } where each row is { __row: line number in the sheet, "Column": "value" }
export async function loadRows(src: SheetSource, opts: SheetOptions, google: Google): Promise<SheetRows> {
  const table = await loadTable(src, opts, google);
  if (!table.length) throw new Error("The sheet is empty.");
  const chosen = Number(opts.header_row) || 0;
  const h = chosen > 0 ? chosen - 1 : detectHeaderRow(table);
  if (h >= table.length) throw new Error(`The sheet has no row ${h + 1} to use as the header row.`);
  const headers = (table[h] || []).map((x) => String(x ?? "").trim());
  const dupes = headers.filter((x, i) => x && headers.indexOf(x) !== i);
  const rows = table
    .slice(h + 1)
    .map((r, i) => {
      const o: Row = { __row: h + i + 2 };
      headers.forEach((col, j) => {
        if (col && !(col in o)) o[col] = String(r?.[j] ?? "").trim();
      });
      return o;
    })
    .filter((o) => headers.some((col) => col && o[col] !== ""));
  if (rows.length > MAX_ROWS) {
    throw new Error(`The sheet has ${rows.length} rows. The limit is ${MAX_ROWS} rows per run; split it into smaller sheets.`);
  }
  return { headers, rows, headerRow: h + 1, duplicateHeaders: [...new Set(dupes)] };
}
