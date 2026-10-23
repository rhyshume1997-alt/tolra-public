/**
 * The daily job sheet and weekly hours: the arithmetic (migrations 050 to 052; plan docs/plans/time-and-pay.md).
 *
 * The database stores facts only: clock actions (attendance_events, never changed; corrections are new rows), labour sessions
 * (operator_sessions) and the company's settings (time_settings). Everything below is worked out from them here, the same way for the
 * person's own sheet, the office's view of everyone, the printed sheet and the weekly approval. Pure functions, no I/O.
 *
 * RULES (The JNR controller, Sun 18 Oct 2026; each a company setting, defaults shown):
 *  - Paid time = clock in to clock out, minus breaks. Breaks are UNPAID and deducted (breaks_paid false).
 *  - Breaks: on a day with at least 6 hours of attendance (break_min_day_hours) the GREATER of the fixed allowances (30-minute lunch +
 *    15-minute break = 45 minutes) and the breaks clocked that day (Break start / Break end) is deducted: a clocked 15-minute tea break
 *    still deducts 45, a clocked 60-minute lunch deducts 60. On a shorter day only clocked breaks are deducted (none clocked: nothing).
 *    Never more than the day's attendance.
 *  - NO COMPUTED OVERTIME (The JNR controller, Sun 18 Oct 2026: "we just give overtime payments a box to tick"). Paid is paid: nothing here splits it into
 *    basic and overtime, by hours, by Saturday, by Sunday or by bank holiday, and there is no Sunday or bank-holiday rate. Overtime is the
 *    "Overtime" day tick (074, lib/time-day-flags), ticked by a person. Bank holidays are holiday allowance: a bank holiday worked is an
 *    ordinary day unless ticked. The settings columns for the old rules (daily_overtime_hours, saturday/sunday/bank_holiday_overtime,
 *    overtime_multiplier) are still read, because the database still has them and 052's revision fingerprint includes them, but they
 *    are not used for any figure.
 *  - Days are local dates in Europe/London. A shift that crosses midnight is split at local midnight and each part belongs to its own
 *    day. Durations come from the UTC instants, so the night the clocks go back (Sat 24 to Sun 25 Oct 2026, 22:00 to 06:00) is 9 hours
 *    and the night they go forward (27 to 28 Mar 2027) is 7.
 *  - Weeks run Monday 00:00 to Monday 00:00 local time.
 *
 * PAIRING: a person's effective clock actions (not replaced, not voided) are taken in time order (ties: the order they reached the
 * server), whatever order they arrived in. In opens a session, Out closes it. Nothing is guessed: an In while a session is open leaves
 * that session without an end (flag missing_out, counted as 0) and opens the new one; an Out with nothing open is flag missing_in
 * (counted as 0). The person's latest session, still open, counts up to now while it is younger than long_session_hours (else flag long,
 * counted as 0 until someone records the clock-out). Labour (Start/Pause/Finish, Join/Stop on the sheet) counts as recorded; the
 * person's labour is the UNION of their sessions (one hour on the clock is one hour, however many jobs), and each job's allocated share
 * splits a stretch worked on k jobs at once equally (1/k each), so the allocated shares add up to the union.
 */

export const TIME_ZONE = "Europe/London";
/** Clock actions are read this far either side of a day or week, so a shift crossing its edge pairs up (the server's revision uses the same). */
export const EDGE_MARGIN_HOURS = 24;

// ----- settings ---------------------------------------------------------------------------------------------------------------------
export type TimeSettings = {
  breaksPaid: boolean;
  lunchMinutes: number;
  breakMinutes: number;
  breakMinDayHours: number;
  /** The five overtime settings below are read and written back unchanged but NOT USED for any figure (The JNR controller, Sun 18 Oct 2026). */
  dailyOvertimeHours: number;
  saturdayOvertime: boolean;
  sundayOvertime: boolean;
  bankHolidayOvertime: boolean;
  overtimeMultiplier: number;
  bankHolidayRegion: string;
  approverRoles: string[];
  longSessionHours: number;
};

export const DEFAULT_TIME_SETTINGS: TimeSettings = {
  breaksPaid: false,
  lunchMinutes: 30,
  breakMinutes: 15,
  breakMinDayHours: 6,
  dailyOvertimeHours: 8,
  saturdayOvertime: true,
  sundayOvertime: true,
  bankHolidayOvertime: true,
  overtimeMultiplier: 1.5,
  bankHolidayRegion: "england-and-wales",
  approverRoles: ["admin"],
  longSessionHours: 14,
};

/** Settings from a time_settings row (missing row or field: the default). */
export function settingsFromRow(row: Record<string, unknown> | null | undefined): TimeSettings {
  if (!row) return { ...DEFAULT_TIME_SETTINGS };
  const num = (v: unknown, d: number) => (v === null || v === undefined || Number.isNaN(Number(v)) ? d : Number(v));
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    breaksPaid: bool(row.breaks_paid, DEFAULT_TIME_SETTINGS.breaksPaid),
    lunchMinutes: num(row.lunch_minutes, DEFAULT_TIME_SETTINGS.lunchMinutes),
    breakMinutes: num(row.break_minutes, DEFAULT_TIME_SETTINGS.breakMinutes),
    breakMinDayHours: num(row.break_min_day_hours, DEFAULT_TIME_SETTINGS.breakMinDayHours),
    dailyOvertimeHours: num(row.daily_overtime_hours, DEFAULT_TIME_SETTINGS.dailyOvertimeHours),
    saturdayOvertime: bool(row.saturday_overtime, DEFAULT_TIME_SETTINGS.saturdayOvertime),
    sundayOvertime: bool(row.sunday_overtime, DEFAULT_TIME_SETTINGS.sundayOvertime),
    bankHolidayOvertime: bool(row.bank_holiday_overtime, DEFAULT_TIME_SETTINGS.bankHolidayOvertime),
    overtimeMultiplier: num(row.overtime_multiplier, DEFAULT_TIME_SETTINGS.overtimeMultiplier),
    bankHolidayRegion: typeof row.bank_holiday_region === "string" ? row.bank_holiday_region : DEFAULT_TIME_SETTINGS.bankHolidayRegion,
    approverRoles: Array.isArray(row.approver_roles) ? (row.approver_roles as string[]) : DEFAULT_TIME_SETTINGS.approverRoles,
    longSessionHours: num(row.long_session_hours, DEFAULT_TIME_SETTINGS.longSessionHours),
  };
}

// ----- local dates (Europe/London) ----------------------------------------------------------------------------------------------------
const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function localParts(at: Date) {
  const p: Record<string, number> = {};
  for (const part of partsFormat.formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Local minus UTC, in ms, at that instant (3 600 000 in BST, 0 in GMT). */
export function zoneOffsetMs(at: Date) {
  const p = localParts(at);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date (YYYY-MM-DD) of an instant. */
export function localDateOf(at: Date | string) {
  const p = localParts(typeof at === "string" ? new Date(at) : at);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** "HH:MM" local time of an instant. */
export function localTimeOf(at: Date | string) {
  const p = localParts(typeof at === "string" ? new Date(at) : at);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** "BST" or "GMT" at that instant. */
export const zoneLabel = (at: Date | string) => (zoneOffsetMs(typeof at === "string" ? new Date(at) : at) === 0 ? "GMT" : "BST");

function ymd(date: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !t || t.getUTCMonth() !== Number(m[2]) - 1 || t.getUTCDate() !== Number(m[3])) throw new Error(`not a date: ${date}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** `date` moved by `days` calendar days. */
export function addDays(date: string, days: number) {
  const { y, m, d } = ymd(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Day of the week of a local date: 0 Sunday ... 6 Saturday. */
export function weekdayOf(date: string) {
  const { y, m, d } = ymd(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Monday of the week a local date is in. */
export function weekStartOf(date: string) {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/**
 * The instant of local wall-clock `time` ("HH:MM") on `date`. On the night the clocks go back the hour 01:00 to 01:59 happens twice:
 * `zone` says which (BST, the first; GMT, the second); without it the answer is `ambiguous` with both. On the night they go forward
 * 01:00 to 01:59 doesn't exist: `missing`.
 */
export function localInstant(date: string, time: string, zone?: "BST" | "GMT"):
  | { kind: "ok"; at: Date } | { kind: "ambiguous"; bst: Date; gmt: Date } | { kind: "missing" } | { kind: "invalid" } {
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) return { kind: "invalid" };
  let parts;
  try { parts = ymd(date); } catch { return { kind: "invalid" }; }
  const wall = Date.UTC(parts.y, parts.m - 1, parts.d, Number(t[1]), Number(t[2]));
  const matches = [0, 3_600_000].map((offset) => new Date(wall - offset)).filter((at) => zoneOffsetMs(at) === wall - at.getTime());
  if (!matches.length) return { kind: "missing" };
  if (matches.length === 1) return { kind: "ok", at: matches[0] };
  const bst = matches.find((at) => zoneOffsetMs(at) === 3_600_000)!;
  const gmt = matches.find((at) => zoneOffsetMs(at) === 0)!;
  if (zone === "BST") return { kind: "ok", at: bst };
  if (zone === "GMT") return { kind: "ok", at: gmt };
  return { kind: "ambiguous", bst, gmt };
}

/** Local midnight at the start of `date`, as an instant (midnight always exists in Europe/London). */
export function startOfLocalDay(date: string): Date {
  const r = localInstant(date, "00:00", "BST");
  if (r.kind !== "ok") throw new Error(`no midnight on ${date}`);
  return r.at;
}

/** The instants that bound a local day [start, end). A clock-change day is 23 or 25 hours long. */
export function localDayBounds(date: string) {
  return { start: startOfLocalDay(date), end: startOfLocalDay(addDays(date, 1)) };
}

// ----- intervals --------------------------------------------------------------------------------------------------------------------
export type Interval = { start: number; end: number };
const MIN = 60_000;

/** The union of intervals, sorted, overlaps merged. Empty intervals drop out. */
export function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}
export const totalMs = (intervals: Interval[]) => union(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
export function clip(intervals: Interval[], window: Interval): Interval[] {
  return intervals.map((i) => ({ start: Math.max(i.start, window.start), end: Math.min(i.end, window.end) })).filter((i) => i.end > i.start);
}
/** The part of `a` that is also in `b` (both as unions). */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of union(a)) for (const y of union(b)) {
    const s = Math.max(x.start, y.start);
    const e = Math.min(x.end, y.end);
    if (e > s) out.push({ start: s, end: e });
  }
  return union(out);
}

// ----- attendance ---------------------------------------------------------------------------------------------------------------------
export type ClockAction = "in" | "out" | "break_start" | "break_end";
export type AttendanceEvent = {
  id: string;
  user_id: string;
  action: ClockAction | "void";
  at: string;
  source?: "clock" | "correction";
  supersedes?: string | null;
  reason?: string | null;
  device_at?: string | null;
  received_at?: string | null;
  /** Still in this device's outbox (not on the server yet): shown as "saved on this device". */
  pending?: boolean;
};

export type SessionFlag = "missing_out" | "missing_in" | "long" | "open" | "break_not_ended" | "break_outside" | "time_adjusted";
export type AttendanceSession = {
  start: number | null;
  end: number | null;
  /** Up to now for the latest open session (still clocked in), else end. Null when the session can't be counted (flagged). */
  countedEnd: number | null;
  breaks: Interval[];
  flags: SessionFlag[];
  events: AttendanceEvent[];
};

/** The clock actions that count: not replaced by a correction, not voided; one copy of each id. */
export function effectiveEvents(events: AttendanceEvent[]): AttendanceEvent[] {
  const byId = new Map<string, AttendanceEvent>();
  for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e);
  const replaced = new Set([...byId.values()].map((e) => e.supersedes).filter((id): id is string => Boolean(id)));
  return [...byId.values()].filter((e) => !replaced.has(e.id) && e.action !== "void");
}

const order = (a: AttendanceEvent, b: AttendanceEvent) =>
  new Date(a.at).getTime() - new Date(b.at).getTime() || String(a.received_at ?? "").localeCompare(String(b.received_at ?? "")) || a.id.localeCompare(b.id);

/** Pairs a person's clock actions into sessions (see PAIRING above). `now`: for the open session's running total. */
export function pairAttendance(events: AttendanceEvent[], settings: TimeSettings, now: number): { sessions: AttendanceSession[]; issues: { at: number; flag: SessionFlag }[] } {
  const sorted = effectiveEvents(events).sort(order);
  const sessions: AttendanceSession[] = [];
  const issues: { at: number; flag: SessionFlag }[] = [];
  let cur: AttendanceSession | null = null;
  let openBreak: number | null = null;
  for (const e of sorted) {
    const at = new Date(e.at).getTime();
    const adjusted = Boolean(e.device_at) && new Date(e.device_at as string).getTime() !== at;
    if (e.action === "in") {
      if (cur) {
        if (openBreak !== null) cur.flags.push("break_not_ended");
        cur.flags.push("missing_out");
        sessions.push(cur);
      }
      cur = { start: at, end: null, countedEnd: null, breaks: [], flags: adjusted ? ["time_adjusted"] : [], events: [e] };
      openBreak = null;
    } else if (e.action === "out") {
      if (cur) {
        if (openBreak !== null) {
          cur.flags.push("break_not_ended");
          cur.breaks.push({ start: openBreak, end: at });
          openBreak = null;
        }
        cur.end = at;
        cur.countedEnd = at;
        cur.events.push(e);
        if (adjusted) cur.flags.push("time_adjusted");
        sessions.push(cur);
        cur = null;
      } else {
        sessions.push({ start: null, end: at, countedEnd: null, breaks: [], flags: ["missing_in"], events: [e] });
      }
    } else if (e.action === "break_start") {
      if (!cur) issues.push({ at, flag: "break_outside" });
      else if (openBreak !== null) cur.flags.push("break_not_ended");
      else { openBreak = at; cur.events.push(e); }
    } else if (e.action === "break_end") {
      if (!cur || openBreak === null) issues.push({ at, flag: "break_outside" });
      else { cur.breaks.push({ start: openBreak, end: at }); cur.events.push(e); openBreak = null; }
    }
  }
  if (cur) {
    const age = now - (cur.start as number);
    if (age > settings.longSessionHours * 3_600_000) {
      cur.flags.push("long", "missing_out");
    } else {
      cur.flags.push("open");
      cur.countedEnd = Math.max(now, cur.start as number);
      if (openBreak !== null) cur.breaks.push({ start: openBreak, end: cur.countedEnd });
    }
    sessions.push(cur);
  }
  for (const s of sessions) s.flags = [...new Set(s.flags)];
  return { sessions, issues };
}

// ----- labour ------------------------------------------------------------------------------------------------------------------------
export type LabourSession = {
  id: string;
  user_id: string;
  job_id: string;
  started_at: string;
  ended_at: string | null;
  voided_at?: string | null;
  source?: string | null;
  device_started_at?: string | null;
  device_ended_at?: string | null;
  original_started_at?: string | null;
  original_ended_at?: string | null;
  correction_reason?: string | null;
  /** How it ended (051): 'admin_released' when an admin's Release machine ended it (092), with who (ended_by) and why (end_reason). */
  end_source?: string | null;
  ended_by?: string | null;
  end_reason?: string | null;
  pending?: boolean;
};

/** A labour session's interval: open sessions count up to now (flagged long past long_session_hours, then counted to that limit). */
export function labourInterval(s: LabourSession, settings: TimeSettings, now: number): { interval: Interval; open: boolean; long: boolean } {
  const start = new Date(s.started_at).getTime();
  if (s.ended_at) return { interval: { start, end: new Date(s.ended_at).getTime() }, open: false, long: false };
  const limit = start + settings.longSessionHours * 3_600_000;
  return { interval: { start, end: Math.min(Math.max(now, start), limit) }, open: true, long: now > limit };
}

/** Each job's equal share of `labour` (one person's): a stretch worked on k jobs at once gives each 1/k. Values in ms; they add up to the union. */
export function allocate(labour: { job: string; interval: Interval }[]): Map<string, number> {
  const points = [...new Set(labour.flatMap((l) => [l.interval.start, l.interval.end]))].sort((a, b) => a - b);
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < points.length; i += 1) {
    const s = points[i];
    const e = points[i + 1];
    const jobs = [...new Set(labour.filter((l) => l.interval.start <= s && l.interval.end >= e).map((l) => l.job))];
    for (const job of jobs) out.set(job, (out.get(job) ?? 0) + (e - s) / jobs.length);
  }
  return out;
}

// ----- one day ------------------------------------------------------------------------------------------------------------------------
export type DayKind = "weekday" | "saturday" | "sunday" | "bank_holiday";
export type JobLine = { jobId: string; minutes: number; allocatedMinutes: number; sessions: LabourSession[]; open: boolean };
export type DayTotals = {
  date: string;
  kind: DayKind;
  bankHolidayName: string | null;
  /** Clock in to clock out, the part on this day (minutes). */
  attendance: number;
  clockedBreaks: number;
  /** Deducted from attendance (0 when breaks are paid). */
  breakDeduction: number;
  breakRule: "clocked" | "allowance" | "none" | "paid";
  paid: number;
  /** Union of the person's labour on this day. */
  labour: number;
  labourInAttendance: number;
  labourOutsideAttendance: number;
  /** Clock in to clock out with no labour recorded (before breaks). */
  attendanceWithoutLabour: number;
  /** Paid time not covered by labour: paid minus labour inside attendance (never below 0). */
  unallocated: number;
  jobs: JobLine[];
  sessions: AttendanceSession[];
  flags: string[];
  worked: boolean;
};

const minutes = (ms: number) => ms / MIN;
export const roundMinutes = (m: number) => Math.round(m);

export function dayKind(date: string, bankHolidays: Map<string, string>): { kind: DayKind; name: string | null } {
  const name = bankHolidays.get(date) ?? null;
  if (name) return { kind: "bank_holiday", name };
  const wd = weekdayOf(date);
  return { kind: wd === 6 ? "saturday" : wd === 0 ? "sunday" : "weekday", name: null };
}

/**
 * One person's day. `events`: their clock actions (with EDGE_MARGIN_HOURS either side); `labour`: their labour sessions overlapping
 * the day; `bankHolidays`: date -> name for the company's region.
 */
export function dayTotals(input: {
  date: string; events: AttendanceEvent[]; labour: LabourSession[]; settings: TimeSettings; bankHolidays: Map<string, string>; now: number;
}): DayTotals {
  const { date, settings, now } = input;
  const bounds = localDayBounds(date);
  const window = { start: bounds.start.getTime(), end: bounds.end.getTime() };
  const { sessions, issues } = pairAttendance(input.events, settings, now);
  const counted = sessions.filter((s) => s.start !== null && s.countedEnd !== null).map((s) => ({ start: s.start as number, end: s.countedEnd as number }));
  const attendanceIv = clip(union(counted), window);
  const touching = sessions.filter((s) => {
    const a = s.start ?? s.end ?? 0;
    const b = s.countedEnd ?? s.end ?? s.start ?? 0;
    return b >= window.start && a < window.end;
  });
  const breakIv = intersect(clip(sessions.flatMap((s) => s.breaks), window), attendanceIv);
  const attendance = minutes(totalMs(attendanceIv));
  const clockedBreaks = minutes(totalMs(breakIv));
  let breakRule: DayTotals["breakRule"] = "none";
  let breakDeduction = 0;
  if (settings.breaksPaid) {
    breakRule = attendance > 0 ? "paid" : "none";
  } else {
    // A day long enough for breaks: the 30 + 15 minutes are unpaid whatever was clocked; longer clocked breaks are deducted as clocked.
    const allowance = attendance > 0 && attendance >= settings.breakMinDayHours * 60 ? settings.lunchMinutes + settings.breakMinutes : 0;
    if (clockedBreaks > allowance) {
      breakRule = "clocked";
      breakDeduction = clockedBreaks;
    } else if (allowance > 0) {
      breakRule = "allowance";
      breakDeduction = Math.min(attendance, allowance);
    }
  }
  const paid = Math.max(0, attendance - breakDeduction);
  const { kind, name } = dayKind(date, input.bankHolidays);

  const live = input.labour.filter((l) => !l.voided_at);
  const pieces = live.map((l) => ({ l, ...labourInterval(l, settings, now) })).map((p) => ({ ...p, clipped: clip([p.interval], window) }));
  const labourIv = union(pieces.flatMap((p) => p.clipped));
  const labour = minutes(totalMs(labourIv));
  const labourInAttendance = minutes(totalMs(intersect(labourIv, attendanceIv)));
  const shares = allocate(pieces.flatMap((p) => p.clipped.map((interval) => ({ job: p.l.job_id, interval }))));
  const jobIds = [...new Set(pieces.filter((p) => p.clipped.length).map((p) => p.l.job_id))];
  const jobs: JobLine[] = jobIds.map((jobId) => {
    const mine = pieces.filter((p) => p.l.job_id === jobId && p.clipped.length);
    return {
      jobId,
      minutes: minutes(totalMs(mine.flatMap((p) => p.clipped))),
      allocatedMinutes: minutes(shares.get(jobId) ?? 0),
      sessions: mine.map((p) => p.l),
      open: mine.some((p) => p.open),
    };
  });

  const flags = new Set<string>();
  for (const s of touching) for (const f of s.flags) if (f !== "open") flags.add(f);
  for (const i of issues) if (i.at >= window.start && i.at < window.end) flags.add(i.flag);
  // A session left running too long is flagged on every day from its start to now (it is counted only up to the limit).
  for (const p of pieces) if (p.long && p.interval.start < window.end && now >= window.start) flags.add("labour_long");
  if (labour - labourInAttendance > 0.5) flags.add("labour_outside_attendance");
  if (live.some((l) => l.pending) || input.events.some((e) => e.pending)) flags.add("saved_on_device");

  return {
    date, kind, bankHolidayName: name,
    attendance, clockedBreaks, breakDeduction, breakRule, paid,
    labour, labourInAttendance, labourOutsideAttendance: labour - labourInAttendance,
    attendanceWithoutLabour: Math.max(0, attendance - labourInAttendance),
    unallocated: Math.max(0, paid - labourInAttendance),
    jobs, sessions: touching, flags: [...flags], worked: attendance > 0 || labour > 0,
  };
}

// ----- one week ------------------------------------------------------------------------------------------------------------------------
export type WeekTotals = {
  weekStart: string;
  days: DayTotals[];
  attendance: number;
  breakDeduction: number;
  paid: number;
  labour: number;
  unallocated: number;
  daysWorked: number;
  flags: string[];
};

/** A person's week (Monday `weekStart`): seven days and their sums (minutes). */
export function weekTotals(input: {
  weekStart: string; events: AttendanceEvent[]; labour: LabourSession[]; settings: TimeSettings; bankHolidays: Map<string, string>; now: number;
}): WeekTotals {
  const days = Array.from({ length: 7 }, (_, i) => dayTotals({ ...input, date: addDays(input.weekStart, i) }));
  const sum = (k: keyof Pick<DayTotals, "attendance" | "breakDeduction" | "paid" | "labour" | "unallocated">) => days.reduce((s, d) => s + d[k], 0);
  const flags = [...new Set(days.flatMap((d) => d.flags))];
  return {
    weekStart: input.weekStart, days,
    attendance: sum("attendance"), breakDeduction: sum("breakDeduction"), paid: sum("paid"),
    labour: sum("labour"), unallocated: sum("unallocated"), daysWorked: days.filter((d) => d.attendance > 0).length, flags,
  };
}

/**
 * The figures stored with an approval (what the JNR controller saw), in whole minutes. `dayFlags` (074): the week's day ticks per type, days and paid
 * minutes on those days (lib/time-day-flags flagTotalsSnapshot, SAVED ticks only), stored as they were shown; left out before 074.
 *
 * No computed overtime (The JNR controller, Sun 18 Oct 2026). 052's approve_time_week only needs an object of at most 16 KB, so no key is required;
 * the keys older approvals carry are kept so a record reads the same way: basic_minutes = paid_minutes (paid is paid), and
 * overtime_minutes = the paid minutes on days with a SAVED "Overtime" tick (0 when none, or before 074), the same figure as
 * day_flags.overtime.paid_minutes. overtime_multiplier and the per-day basic/overtime are no longer written.
 */
export function approvalSnapshot(week: WeekTotals, dayFlags?: Record<string, { days: number; paid_minutes: number }> | null) {
  const paid = roundMinutes(week.paid);
  return {
    ...(dayFlags ? { day_flags: dayFlags } : {}),
    week_start: week.weekStart,
    attendance_minutes: roundMinutes(week.attendance),
    break_deduction_minutes: roundMinutes(week.breakDeduction),
    paid_minutes: paid,
    basic_minutes: paid,
    overtime_minutes: dayFlags?.overtime?.paid_minutes ?? 0,
    labour_minutes: roundMinutes(week.labour),
    days_worked: week.daysWorked,
    flags: week.flags,
    days: week.days.map((d) => ({ date: d.date, paid: roundMinutes(d.paid), breaks: roundMinutes(d.breakDeduction) })),
  };
}

// ----- display --------------------------------------------------------------------------------------------------------------------------
/** "7:15" (hours:minutes), rounded to the minute; "0:00" for nothing. */
export function hm(mins: number) {
  const m = Math.max(0, roundMinutes(mins));
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

/**
 * A signed duration: "−0:45" for -45 minutes, "7:15" for 435, and "0:00" for nothing. Rounded to the minute first, and zero (including
 * negative zero, which -0 and a deduction of nothing both give) never carries a sign: "−0:00" is not a time. Breaks are shown as
 * hmSigned(-deduction).
 */
export function hmSigned(mins: number) {
  const m = roundMinutes(mins);
  if (!m) return "0:00";
  return `${m < 0 ? "\u2212" : ""}${hm(Math.abs(m))}`;
}

export const FLAG_TEXT: Record<string, string> = {
  missing_out: "Clock-out missing",
  missing_in: "Clock-in missing",
  long: "Still clocked in after a long time: check the clock-out",
  break_not_ended: "Break not ended",
  break_outside: "Break recorded while not clocked in",
  time_adjusted: "Device time could not be used; server time recorded",
  labour_long: "Job time left running a long time",
  labour_outside_attendance: "Job time outside clock in / out",
  saved_on_device: "Some changes are saved on this device and not sent yet",
};
