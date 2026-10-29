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

/**
 * The "due within 7 days" window: today and the day 7 calendar days on, both in UK time. Calendar days, not 7 x 24 hours,
 * so the end date is right across the clock changes (7 x 24 hours from 23:30 on the Saturday before the clocks go forward is
 * already the Sunday after the window).
 */
export function dueWindow(now = new Date()) {
  const today = toDateInput(now);
  const [y, m, d] = today.split("-").map(Number);
  return { today, end: new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10) };
}

/** A YYYY-MM-DD date as "Wed 4 Nov". */
export function fmtDueBy(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
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
