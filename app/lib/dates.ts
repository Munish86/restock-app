// Calendar days as "YYYY-MM-DD" strings. Sales days follow the store's time zone, so a sale at 23:30 in
// Mumbai counts on that Mumbai day, whatever the server's clock says. Shared by server and browser.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

// The calendar day of `date` in time zone `tz` (falls back to UTC for an unknown zone)
export function localDay(date: Date, tz = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// Hour (0-23) and weekday (0 = Sunday) of `date` in time zone `tz`
export function localClock(date: Date, tz = "UTC"): { hour: number; weekday: number; day: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(date);
  } catch {
    return localClock(date, "UTC");
  }
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return { hour, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd), day: localDay(date, tz) };
}

export const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
export const fromDate = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return fromDate(new Date(toDate(day).getTime() + Math.round(n) * DAY_MS));
}

// Whole days from a to b (b later = positive)
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY_MS);

// "2026-10-27" -> "27 Oct"; with the year when it is not `thisYear`
export function shortDay(day: string | null | undefined, thisYear?: string): string {
  if (!day) return "";
  const [y, m, d] = day.split("-");
  const s = `${Number(d)} ${MONTHS[Number(m) - 1] ?? ""}`;
  return thisYear && y !== thisYear.slice(0, 4) ? `${s} ${y}` : s;
}
