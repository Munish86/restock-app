// Small helpers used across the uploader.

// Normalises text for matching: lowercase, and every run of symbols/spaces becomes one space.
// "Sofa-Set_01" -> "sofa set 01", "Sofa Set (1)" -> "sofa set 1"
export const norm = (s: unknown): string =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || String(v).trim() === "";

// "a, b | c" -> ["a","b","c"]
export const splitList = (s: unknown): string[] =>
  String(s ?? "")
    .split(/[,|\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function uniqueCi(list: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    const k = String(x).trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(x).trim());
  }
  return out;
}

// "£1,249.00" -> "1249.00". Returns null for blank, undefined for something that is not a price.
export function parseMoney(v: unknown): string | null | undefined {
  if (isBlank(v)) return null;
  const cleaned = String(v).replace(/[^\d.-]/g, "");
  if (cleaned === "" || isNaN(Number(cleaned))) return undefined;
  return cleaned;
}

export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Turns a plain-text description into simple HTML. Text that is already HTML is kept as is.
export function toHtml(text: string): string {
  const t = String(text).trim();
  if (/<[a-z][\s\S]*>/i.test(t)) return t;
  return t
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function toCsv(rows: Record<string, unknown>[], headers: readonly string[]): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Starts with a byte-order mark so Excel opens the file as UTF-8
  return (
    String.fromCharCode(0xfeff) +
    [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\r\n")
  );
}

// Runs fn over items with at most `limit` running at the same time. Stops picking new items once shouldStop() is true.
export async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
