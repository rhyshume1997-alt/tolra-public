/** Store ISO, display en-GB in UK time. Never write display strings to the database. */
const TZ = "Europe/London";

export const nowIso = () => new Date().toISOString();

/** YYYY-MM-DD for <input type="date"> and DATE columns. */
export function toDateInput(value?: string | Date | null) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts; // en-CA formats as YYYY-MM-DD
}

/**
 * The calendar date (YYYY-MM-DD) a database value stands for. A DATE column ("2026-10-11") is returned exactly as it is.
 * A timestamp ("2026-07-01T23:30:00+00:00", UTC) becomes the date in Europe/London: 23:30 UTC in summer is already the next
 * day in London, in winter it is the same day. Slicing the first ten characters of a timestamp (as the year-end export used to)
 * gets that wrong for an hour a night through the summer. Anything else is "".
 */
export function calendarDate(value: unknown): string {
  if (typeof value !== "string") return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return "";
  return toDateInput(value);
}

export function fmtDate(value?: string | Date | null) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function fmtDateTime(value?: string | Date | null) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(d);
}
