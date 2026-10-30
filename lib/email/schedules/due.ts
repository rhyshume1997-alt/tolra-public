// When an e-mail schedule (migration 108) is due, and when it runs next. PURE: no database, no clock of its own, no server-only import,
// so the Settings card shows "Next run: ..." from the very same functions the cron route uses to decide.
//
// A schedule is "daily at a time", "weekly on a weekday at a time" or "once at a moment" in a time zone (Europe/London unless the row says
// otherwise). Rules the cron relies on:
//   - The occurrence is the most recent scheduled moment at or before `now`. It is DUE when it is within CATCH_UP_MS and not before the
//     schedule was last changed (`updated_at`): switching a daily 8am schedule on at 2pm waits for tomorrow instead of sending at once.
//   - The cron may run only once a day (Vercel Hobby: DAILY_PASS_UTC_HOUR). An occurrence whose time has passed since the last pass is
//     simply the latest occurrence at the next pass, so it is sent then (a daily 08:00 reminder at the next 05:00 pass, about 21 hours
//     late) and never skipped; the period key and the database's one run per key keep it from going out twice. The catch-up window is
//     wide enough for a once-a-day pass that Vercel starts anywhere in its hour, and for one missed pass.
//   - Each occurrence has a period key (daily: the local date; weekly: the ISO week of the local date; once: the moment). The database
//     holds one run per schedule per key, so an occurrence is never sent twice however often the cron calls.
//   - Clocks changing: a local time that does not exist (01:30 on the last Sunday of March in London) happens an hour later; a local time
//     that happens twice (01:30 on the last Sunday of October) is the first one.

export type EmailScheduleKind = "invoice_reminder" | "timesheet";
export type EmailScheduleFrequency = "daily" | "weekly" | "once";

export const DEFAULT_TIME_ZONE = "Europe/London";
/** An occurrence older than this is skipped, not sent late: two days, so a once-a-day pass (up to ~25 h apart) never misses one, nor does a single missed pass. */
export const CATCH_UP_MS = 48 * 3_600_000;
/** The daily pass runs at this hour UTC (vercel.json "0 5 * * *": 05:00 UK in winter, 06:00 in summer). */
export const DAILY_PASS_UTC_HOUR = 5;

/** The fields of an email_schedules row that decide when it runs. `weekday`: 0 = Sunday ... 6 = Saturday. `time_of_day`: "08:00" or "08:00:00". */
export type ScheduleTiming = {
  enabled: boolean;
  frequency: EmailScheduleFrequency;
  weekday: number | null;
  time_of_day: string;
  run_at: string | null;
  timezone: string | null;
  /** When the schedule was last changed by a person (not by the cron noting a run). Absent: no lower bound. */
  updated_at?: string | null;
};

export type Occurrence = { at: Date; periodKey: string };

// ----- time zones -----------------------------------------------------------------------------------------------------------------
const formatters = new Map<string, Intl.DateTimeFormat>();

/** A zone name Intl knows, else Europe/London (a bad zone must never stop a company's other schedules). */
export function safeZone(zone: string | null | undefined): string {
  const name = (zone ?? "").trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return name;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(zone, f);
  }
  return f;
}

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };

function localParts(at: Date, zone: string): Parts {
  const p: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Local minus UTC, in ms, at that instant. */
function offsetMs(at: Date, zone: string): number {
  const p = localParts(at, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date (YYYY-MM-DD) of an instant in `zone`. */
export function localDate(at: Date, zone: string): string {
  const p = localParts(at, safeZone(zone));
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function addDaysToDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday, of a calendar date. */
export function weekdayOfDate(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The Monday of the week that holds `date`. */
export function mondayOf(date: string): string {
  return addDaysToDate(date, -((weekdayOfDate(date) + 6) % 7));
}

/** ISO 8601 week of a calendar date, "2026-W44". */
export function isoWeekKey(date: string): string {
  const thursday = addDaysToDate(mondayOf(date), 3);
  const year = Number(thursday.slice(0, 4));
  const jan1 = Date.parse(`${year}-01-01T00:00:00Z`);
  const week = Math.floor((Date.parse(`${thursday}T00:00:00Z`) - jan1) / 86_400_000 / 7) + 1;
  return `${year}-W${pad(week)}`;
}

/** "08:00" or "08:00:00" to [hours, minutes]; null when it is not a time of day. */
export function parseTimeOfDay(value: string | null | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec((value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? [h, mi] : null;
}

/** The instant a local date and time of day happen in `zone` (see the clock rules at the top). */
export function localInstant(date: string, hours: number, minutes: number, zoneName: string): Date {
  const zone = safeZone(zoneName);
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hours, minutes, 0);
  const before = offsetMs(new Date(wall - 86_400_000), zone);
  const after = offsetMs(new Date(wall + 86_400_000), zone);
  const matches = [...new Set([before, after])]
    .map((off) => new Date(wall - off))
    .filter((at) => {
      const p = localParts(at, zone);
      return p.y === y && p.m === m && p.d === d && p.h === hours && p.mi === minutes;
    });
  if (matches.length) return new Date(Math.min(...matches.map((t) => t.getTime())));
  // The local time does not exist (the clocks went forward over it): the same wall time with the offset from before the change.
  return new Date(wall - before);
}

// ----- occurrences ----------------------------------------------------------------------------------------------------------------
function timeOf(s: ScheduleTiming): [number, number] {
  return parseTimeOfDay(s.time_of_day) ?? [8, 0];
}

function keyFor(s: ScheduleTiming, at: Date, date: string): string {
  if (s.frequency === "weekly") return isoWeekKey(date);
  if (s.frequency === "once") return at.toISOString();
  return date;
}

/** The scheduled moment on a local date, or null when the schedule has none that day. */
function onDate(s: ScheduleTiming, date: string, zone: string): Occurrence | null {
  if (s.frequency === "weekly" && weekdayOfDate(date) !== s.weekday) return null;
  const [h, mi] = timeOf(s);
  const at = localInstant(date, h, mi, zone);
  return { at, periodKey: keyFor(s, at, date) };
}

function validWeekday(s: ScheduleTiming): boolean {
  return s.frequency !== "weekly" || (Number.isInteger(s.weekday) && (s.weekday as number) >= 0 && (s.weekday as number) <= 6);
}

function onceAt(s: ScheduleTiming): Date | null {
  const t = s.run_at ? new Date(s.run_at) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

/** The most recent scheduled moment at or before `now` (enabled or not), or null when there has been none. */
export function latestOccurrence(s: ScheduleTiming, now: Date): Occurrence | null {
  if (!validWeekday(s)) return null;
  if (s.frequency === "once") {
    const at = onceAt(s);
    return at && at.getTime() <= now.getTime() ? { at, periodKey: at.toISOString() } : null;
  }
  const zone = safeZone(s.timezone);
  const today = localDate(now, zone);
  for (let back = 0; back <= (s.frequency === "weekly" ? 7 : 1); back += 1) {
    const occ = onDate(s, addDaysToDate(today, -back), zone);
    if (occ && occ.at.getTime() <= now.getTime()) return occ;
  }
  return null;
}

/** The occurrence to run now, or null: enabled, recent enough, and not before the schedule was last changed. */
export function dueOccurrence(s: ScheduleTiming, now: Date): Occurrence | null {
  if (!s.enabled) return null;
  const occ = latestOccurrence(s, now);
  if (!occ) return null;
  if (now.getTime() - occ.at.getTime() > CATCH_UP_MS) return null;
  const changed = s.updated_at ? Date.parse(s.updated_at) : NaN;
  if (!Number.isNaN(changed) && occ.at.getTime() <= changed) return null;
  return occ;
}

/**
 * Whether the schedule has a period to run at `now`: true from the scheduled moment until the catch-up window ends. It stays true after the
 * run; dueOccurrence's period key says WHICH period, and the database (one run per schedule per key) stops a second one.
 */
export function isDue(s: ScheduleTiming, now: Date): boolean {
  return dueOccurrence(s, now) !== null;
}

/** The first scheduled moment after `now` for an enabled schedule; null when it is off, or a "once" that has passed. */
export function nextRun(s: ScheduleTiming, now: Date): Date | null {
  if (!s.enabled || !validWeekday(s)) return null;
  if (s.frequency === "once") {
    const at = onceAt(s);
    return at && at.getTime() > now.getTime() ? at : null;
  }
  const zone = safeZone(s.timezone);
  const today = localDate(now, zone);
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const occ = onDate(s, addDaysToDate(today, ahead), zone);
    if (occ && occ.at.getTime() > now.getTime()) return occ.at;
  }
  return null;
}

/** When a once-a-day pass first sends an occurrence at `at`: the first pass (DAILY_PASS_UTC_HOUR:00 UTC) at or after it. */
export function nextDailyPassAtOrAfter(at: Date, passHourUtc: number = DAILY_PASS_UTC_HOUR): Date {
  const pass = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), passHourUtc, 0, 0));
  return pass.getTime() < at.getTime() ? new Date(pass.getTime() + 86_400_000) : pass;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekdayName = (day: number) => DAY_NAMES[day] ?? "";

/** "Mon 2 Nov 2026 at 09:30 (GMT)" in the schedule's zone, for the "Next run" line. */
export function describeInstant(at: Date, zoneName: string | null): string {
  const zone = safeZone(zoneName);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(at).replace(",", "");
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(at);
  const part = (t: string) => time.find((x) => x.type === t)?.value ?? "";
  return `${date} at ${part("hour")}:${part("minute")} (${part("timeZoneName")})`;
}
