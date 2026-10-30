/**
 * Store ISO, display in UK time in the signed-in person's date format. Never write display strings to the database.
 *
 * The date format is a per-person setting (Account Settings > Date format; migration 109 `user_preferences.date_format`): the order
 * (DD/MM/YYYY, MM/DD/YYYY or the ISO YYYY-MM-DD) and how the month is shown (a number, Oct, October). Every date on screen and on what
 * the person prints or saves as a PDF goes through this file. The setting is applied in the browser by the dashboard shell
 * (lib/date-format-preference.ts); anything formatted elsewhere (the server, before sign-in) uses the default, DD/MM/YYYY, exactly as
 * before 109. CSV and Excel exports don't follow it (lib/spreadsheet and the year-end CSVs write ISO YYYY-MM-DD), and
 * `<input type="date">` keeps the browser's own picker (toDateInput).
 */
const TZ = "Europe/London";

export const nowIso = () => new Date().toISOString();

// ----- the setting -------------------------------------------------------------------------------------------------------------------
export const DATE_ORDERS = ["dmy", "mdy", "ymd"] as const;
export const DATE_MONTHS = ["number", "short", "full"] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];
export type DateMonth = (typeof DATE_MONTHS)[number];
/** The stored value (the CHECK on user_preferences.date_format lists exactly these nine). */
export type DateFormat = `${DateOrder}-${DateMonth}`;
export const DATE_FORMATS = DATE_ORDERS.flatMap((o) => DATE_MONTHS.map((m) => `${o}-${m}` as DateFormat));
export const DEFAULT_DATE_FORMAT: DateFormat = "dmy-number";

export const DATE_ORDER_LABELS: Record<DateOrder, string> = { dmy: "DD/MM/YYYY", mdy: "MM/DD/YYYY", ymd: "YYYY-MM-DD (ISO)" };
export const DATE_MONTH_LABELS: Record<DateMonth, string> = { number: "Number (10)", short: "Short (Oct)", full: "Full (October)" };

export const isDateFormat = (value: unknown): value is DateFormat => typeof value === "string" && (DATE_FORMATS as string[]).includes(value);
export const parseDateFormat = (value: unknown): DateFormat => (isDateFormat(value) ? value : DEFAULT_DATE_FORMAT);
export const dateFormatOf = (order: DateOrder, month: DateMonth): DateFormat => `${order}-${month}`;
export function dateFormatParts(format: DateFormat): { order: DateOrder; month: DateMonth } {
  const [order, month] = parseDateFormat(format).split("-") as [DateOrder, DateMonth];
  return { order, month };
}

let current: DateFormat = DEFAULT_DATE_FORMAT;
const listeners = new Set<() => void>();

/** The format dates are shown in on this page (the signed-in person's, once the dashboard has read it). */
export const getDateFormat = () => current;

/** Applies a format to every date formatted from now on in this browser tab. Ignored on the server (it is shared by every request). */
export function setDateFormat(format: unknown) {
  if (typeof window === "undefined") return;
  const next = parseDateFormat(format);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Sets the format without telling anyone: only for the moment before the first dated thing renders (the dashboard shell applying this
 * browser's copy during its render, where notifying React would be an update in the middle of a render).
 */
export function primeDateFormat(format: unknown) {
  if (typeof window === "undefined") return;
  current = parseDateFormat(format);
}

/** For useSyncExternalStore: told when the format changes. */
export function subscribeDateFormat(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ----- calendar parts ----------------------------------------------------------------------------------------------------------------
// Month and weekday names exactly as en-GB writes them in this runtime (so "Sept", not "Sep", where its ICU says so): the labels the
// app showed before 109 come out byte for byte the same.
const enGbName = (options: Intl.DateTimeFormatOptions, at: number) => new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(at);
const MONTHS_FULL = Array.from({ length: 12 }, (_, m) => enGbName({ month: "long" }, Date.UTC(2026, m, 15)));
const MONTHS_SHORT = Array.from({ length: 12 }, (_, m) => enGbName({ month: "short" }, Date.UTC(2026, m, 15)));
// 2026-03-01 was a Sunday: index 0 is Sunday, as Date.getUTCDay counts.
const WEEKDAYS_FULL = Array.from({ length: 7 }, (_, d) => enGbName({ weekday: "long" }, Date.UTC(2026, 2, 1 + d)));
const WEEKDAYS_SHORT = Array.from({ length: 7 }, (_, d) => enGbName({ weekday: "short" }, Date.UTC(2026, 2, 1 + d)));

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

type Parts = { y: number; m: number; d: number; wd: number; time: string | null };

/**
 * The calendar date (and UK time) a value stands for. A plain date ("2026-10-21", a DATE column or a date input) is that calendar
 * day, with no time zone involved; anything else is read as an instant and shown in Europe/London. Null when it isn't a date.
 */
function partsOf(value: string | Date): Parts | null {
  if (typeof value === "string") {
    const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (plain) {
      const [y, m, d] = [Number(plain[1]), Number(plain[2]), Number(plain[3])];
      const check = new Date(Date.UTC(y, m - 1, d));
      if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
      return { y, m, d, wd: check.getUTCDay(), time: null };
    }
  }
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const p: Record<string, string> = {};
  for (const part of londonParts.formatToParts(at)) if (part.type !== "literal") p[part.type] = part.value;
  const [y, m, d] = [Number(p.year), Number(p.month), Number(p.day)];
  return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A full date in `format`: 21/10/2026, 21 Oct 2026, 21 October 2026, 10/21/2026, Oct 21, 2026, 2026-10-21, 2026 Oct 21, ... */
function dateText({ y, m, d }: Parts, format: DateFormat) {
  const { order, month } = dateFormatParts(format);
  if (month === "number") {
    if (order === "dmy") return `${pad(d)}/${pad(m)}/${y}`;
    if (order === "mdy") return `${pad(m)}/${pad(d)}/${y}`;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  const name = (month === "short" ? MONTHS_SHORT : MONTHS_FULL)[m - 1];
  if (order === "dmy") return `${d} ${name} ${y}`;
  if (order === "mdy") return `${name} ${d}, ${y}`;
  return `${y} ${name} ${d}`;
}

// ----- formatting --------------------------------------------------------------------------------------------------------------------
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

/** A date in the person's format (default 21/10/2026). Empty for nothing; the value itself when it isn't a date. */
export function fmtDate(value?: string | Date | null, format: DateFormat = current) {
  if (!value) return "";
  const p = partsOf(value);
  return p ? dateText(p, format) : String(value);
}

/** A date and UK time (24-hour) in the person's format (default 21/10/2026, 14:05). */
export function fmtDateTime(value?: string | Date | null, format: DateFormat = current) {
  if (!value) return "";
  const p = partsOf(value instanceof Date || !/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(value));
  return p ? `${dateText(p, format)}, ${p.time}` : String(value);
}

/** The UK time alone (14:05). */
export function fmtTime(value?: string | Date | null) {
  if (!value) return "";
  const p = partsOf(value instanceof Date ? value : new Date(value));
  return p?.time ?? String(value);
}

export type DateTextOptions = {
  /** A weekday in front: Wed or Wednesday. */
  weekday?: "short" | "long";
  /** With the year (default: without, for labels like "Wed 21 Oct"). */
  year?: boolean;
  /**
   * How the month is written when the person shows months as numbers (default "short"): a label such as a timeline header or
   * "Wed 21 Oct" keeps a word; "number" gives 21/10. Someone who chose Oct or October always gets theirs.
   */
  numberAs?: DateMonth;
};

/**
 * A date written as a label: in the person's order, optionally with the weekday and without the year. With the default setting
 * this is exactly what the app showed before 109 ("Wed 21 Oct", "Wed, 21 Oct 2026", "Wednesday, 21 October 2026", "21/10").
 */
export function fmtDateText(value: string | Date | null | undefined, options: DateTextOptions = {}, format: DateFormat = current) {
  if (!value) return "";
  const p = partsOf(value);
  if (!p) return String(value);
  const { order, month: chosen } = dateFormatParts(format);
  const month = chosen === "number" ? options.numberAs ?? "short" : chosen;
  const weekday = options.weekday ? (options.weekday === "short" ? WEEKDAYS_SHORT : WEEKDAYS_FULL)[p.wd] : "";
  let body: string;
  if (options.year) {
    body = dateText(p, dateFormatOf(order, month));
  } else if (month === "number") {
    body = order === "dmy" ? `${pad(p.d)}/${pad(p.m)}` : order === "mdy" ? `${pad(p.m)}/${pad(p.d)}` : `${pad(p.m)}-${pad(p.d)}`;
  } else {
    const name = (month === "short" ? MONTHS_SHORT : MONTHS_FULL)[p.m - 1];
    body = order === "dmy" ? `${p.d} ${name}` : `${name} ${p.d}`;
  }
  if (!weekday) return body;
  // As en-GB and en-US write them: "Wed 21 Oct", "Wed, 21 Oct 2026"; "Wed, Oct 21", "Wed, Oct 21, 2026".
  return `${weekday}${order === "dmy" && !options.year ? " " : ", "}${body}`;
}

/** The weekday and the day of the month alone: "Sat 24" (no month, so no order or month style applies). */
export function fmtWeekdayDay(value: string | Date | null | undefined) {
  if (!value) return "";
  const p = partsOf(value);
  return p ? `${WEEKDAYS_SHORT[p.wd]} ${p.d}` : String(value);
}

/** A label and the UK time: "Wed 21 Oct, 14:05" (or, with { year: true }, "21 Oct 2026, 14:05"). */
export function fmtDateTimeText(value: string | Date | null | undefined, options: DateTextOptions = {}, format: DateFormat = current) {
  if (!value) return "";
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  return `${fmtDateText(at, options, format)}, ${fmtTime(at)}`;
}

/** The weekday, date and UK time a booking or plan shows: "Tue 20 Oct 10:00". */
export function fmtDayDateTime(value: string | Date | null | undefined, format: DateFormat = current) {
  if (!value) return "";
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  return `${fmtDateText(at, { weekday: "short" }, format)} ${fmtTime(at)}`;
}
