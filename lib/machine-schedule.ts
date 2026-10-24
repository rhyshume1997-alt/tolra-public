import { DEMO_MODE } from "@/lib/demo";
import { DEMO_MACHINES } from "@/lib/job-worksheet";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { fetchAll } from "@/lib/fetch-all";
import { DEFAULT_WORKING_HOURS, clockMinutes, hoursForDay, type WorkingHours } from "@/lib/company";

/** Working days use JS getDay() numbers (0 = Sun ... 6 = Sat) in code; stored in the DB as ISO 1..7 (Mon..Sun). */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
export const DAY_START_HOUR = 8;
const HOUR_MS = 3600000;

export type BookingStatus = "booked" | "running" | "complete";

export type Machine = {
  id: string;
  name: string;
  type: string;
  hoursPerDay: number;
  workingDays: number[];
  active: boolean;
};

/**
 * One day of a booking split by day (the booking day-plan migration): `date` is a local calendar day (YYYY-MM-DD), worked from `start`
 * ("HH:MM", 00:00 to 23:59) to `end` ("HH:MM", 00:01 to 24:00, after `start`; 24:00 is midnight at the end of the day).
 */
export type DayPlanEntry = { date: string; start: string; end: string };

/** The most days a split can have (the database refuses more). */
export const MAX_DAY_PLAN_DAYS = 62;

/** A stretch of machine time a booking occupies: one split day, `from` to `to` on the wall clock (`minutes` long, `hours` = minutes / 60). */
export type BookingSegment = { date: string; from: string; to: string; minutes: number; hours: number; start: Date; end: Date };

export type Booking = {
  id: string;
  machineId: string;
  jobId: string | null;
  jobNo: string;
  description: string;
  startAt: string;
  estimatedHours: number;
  hoursDone: number;
  status: BookingStatus;
  notes: string;
  /** Optional split by day (the booking day-plan migration). Empty or missing = the default rule below. */
  dayPlan?: DayPlanEntry[] | null;
};

export type ScheduleJob = {
  id: string;
  jobNo: string;
  description: string;
  customer: string;
  dateRequired: string;
  estimatedHours: number | null;
  /** The job's finished_at (ISO) once it was finished on the Job Board; empty while it is open. */
  finishedAt?: string;
};

export type ScheduledBooking = Booking & {
  machine: Machine;
  start: Date;
  finish: Date;
  hoursLeft: number;
  /** Set when the booking has a day plan: exactly the time it is worked, one segment per planned day (gaps between them are free). */
  segments?: BookingSegment[] | null;
};

type MachineLike = Pick<Machine, "hoursPerDay" | "workingDays">;

function dayStartOf(date: Date) {
  const d = new Date(date);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  return d;
}

export function windowFor(date: Date, machine: MachineLike) {
  const start = dayStartOf(date);
  return { start, end: new Date(start.getTime() + machine.hoursPerDay * HOUR_MS) };
}

export function isWorkingDay(date: Date, machine: MachineLike) {
  return machine.workingDays.includes(date.getDay());
}

/**
 * Weekend or overtime work is chosen, never automatic (Rhys, 12 Oct 2026). A booking that STARTS on a day the machine
 * doesn't normally work (a Saturday on a Mon-Fri machine) runs on consecutive calendar days, each day's 08:00 to
 * 08:00 + hoursPerDay window, until its hours are done (Sat 12h on an 8h machine: 8h Saturday, 4h Sunday). A booking
 * that starts on a working day keeps to the machine's working days, so a Friday overrun still moves to Monday.
 */
export function runsEveryDay(start: Date, machine: MachineLike) {
  return !isWorkingDay(start, machine);
}

/** Whether a booking starting at `bookingStart` is worked on `day` (for drawing it on the timeline). */
export function worksOn(day: Date, machine: MachineLike, bookingStart?: Date) {
  return isWorkingDay(day, machine) || (Boolean(bookingStart) && runsEveryDay(bookingStart!, machine));
}

function nextDayStart(date: Date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  return d;
}

/** First moment at or after `from` that falls inside the machine's working hours. */
export function normaliseStart(from: Date, machine: MachineLike, everyDay = false): Date {
  if (machine.hoursPerDay <= 0 || !machine.workingDays.length) return new Date(from);
  let cursor = new Date(from);
  for (let i = 0; i < 400; i++) {
    if (!everyDay && !isWorkingDay(cursor, machine)) { cursor = nextDayStart(cursor); continue; }
    const { start, end } = windowFor(cursor, machine);
    if (cursor < start) return start;
    if (cursor >= end) { cursor = nextDayStart(cursor); continue; }
    return cursor;
  }
  return cursor;
}

/**
 * Where a booking can start once the one before it ends at `clashEnd`: the next whole minute at or after it (the booking form's start box
 * holds minutes, and an end with seconds in it, such as a not-started booking counted from now, would otherwise leave the new start a
 * few seconds inside the clash), then the first working moment on the machine (the same rule as the card's next free slot).
 */
export function startAfterBooking(clashEnd: Date, machine: MachineLike, everyDay = false): Date {
  const minute = 60_000;
  return normaliseStart(new Date(Math.ceil(clashEnd.getTime() / minute) * minute), machine, everyDay);
}

/** How many times nextClearStart moves on before it gives up. */
export const CLEAR_START_MAX_STEPS = 50;

/**
 * The first start, at or after `start`, where a booking clashes with nothing: while `overlapsAt(start)` finds clashes, move to just after
 * the latest of them ends (startAfterBooking), because a booking chained right behind the first clash would otherwise bring the clash back.
 * Null when `maxSteps` moves still find a clash (the caller says no free slot was found).
 */
export function nextClearStart(
  start: Date,
  machine: MachineLike,
  overlapsAt: (start: Date) => { finish: Date }[],
  opts: { everyDay?: boolean; maxSteps?: number } = {},
): Date | null {
  let cursor = start;
  for (let i = 0; i < (opts.maxSteps ?? CLEAR_START_MAX_STEPS); i++) {
    const clashes = overlapsAt(cursor);
    if (!clashes.length) return cursor;
    cursor = startAfterBooking(new Date(Math.max(...clashes.map((clash) => clash.finish.getTime()))), machine, opts.everyDay);
  }
  return null;
}

/**
 * Split by day, Start after current booking: how many days to move the whole split (same gaps between its dates, same times) so it clashes
 * with nothing. Each step begins the day after the latest clash ends, or that day when the clash ends by the first day's start time. The
 * split's days and times are exactly what the person entered, so a clash's end is only rounded to the minute (hoursPerDay 0), never moved to
 * the machine's working window: a window start of 08:00 would otherwise look later than a 06:00 first-day start and skip a free day.
 * A shifted plan that fails validation (a time that doesn't exist on a clock-change day) stops with its message: it is not "no clash".
 */
export type SplitClearShift = { ok: true; shift: number } | { ok: false; reason: "none" } | { ok: false; reason: "invalid"; message: string };

export function splitClearShift(rows: DayPlanRow[], first: string, firstStart: string, estimatedHours: number, machine: Machine, scheduled: ScheduledBooking[]): SplitClearShift {
  const shiftFor = (at: Date) => daysBetweenDates(first, localDateString(timeOf(at) > firstStart ? new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1) : at));
  let invalid = "";
  const clashesAt = (at: Date) => {
    const shift = shiftFor(at);
    const plan = validateDayPlan(rows.map((r) => (r.date ? { ...r, date: addDaysToDate(r.date, shift) } : r)), estimatedHours);
    if (!plan.ok) { invalid = plan.message; return []; } // [] ends the search; the flag below says it did not find a clear slot
    const segments = planSegments(plan.plan);
    return segments.length ? findOverlaps(machine, scheduled, segments[0].start, segments[segments.length - 1].end, undefined, segments) : [];
  };
  const clear = nextClearStart(localMoment(first, firstStart) ?? new Date(`${first}T00:00`), { ...machine, hoursPerDay: 0 }, clashesAt, { everyDay: true });
  if (invalid) return { ok: false, reason: "invalid", message: invalid };
  return clear ? { ok: true, shift: shiftFor(clear) } : { ok: false, reason: "none" };
}

/**
 * End time after consuming `hours` of work from `start`, counting only the machine's working hours
 * (08:00 to 08:00 + hoursPerDay on its working days). Example: 20h on an 8h Mon-Fri machine from Fri 08:00 ends Tue 12:00.
 */
export function computeFinish(start: Date, hours: number, machine: MachineLike, everyDay?: boolean): Date {
  if (machine.hoursPerDay <= 0 || !machine.workingDays.length) return new Date(start.getTime() + Math.max(0, hours) * HOUR_MS);
  // Left out, `start` decides (a booking form previewing a new booking). Callers counting from "now" pass the booking's
  // own rule explicitly, so a weekday job still running on a Saturday never makes that Saturday worked.
  const allDays = everyDay ?? runsEveryDay(start, machine);
  let cursor = normaliseStart(start, machine, allDays);
  let remaining = Math.max(0, hours);
  for (let i = 0; i < 800 && remaining > 0; i++) {
    const { end } = windowFor(cursor, machine);
    const available = (end.getTime() - cursor.getTime()) / HOUR_MS;
    if (remaining <= available) return new Date(cursor.getTime() + remaining * HOUR_MS);
    remaining -= available;
    cursor = normaliseStart(nextDayStart(cursor), machine, allDays);
  }
  return cursor;
}

// ---------- Split by day (the booking day-plan migration) ----------

/**
 * A booking with a day plan is worked exactly from each day's start to its end (local wall-clock time), on the dates listed. The machine's
 * working days and hours per day do not apply to it, and nor do the company's working hours: those only label time as basic or out of
 * hours (dayHoursSplit), never block or move it, and nothing here calculates pay. The booking's start is the first day's start and its
 * finish the last day's end; the form saves that start in start_at so lists sorted by start put it in the right place. A plan is a fixed
 * commitment and does not roll forward: days already gone are treated as worked, the finish stays where the plan puts it, and hours still
 * left after the last day show as such (edit the split to add days). Times are built with new Date(y, m, d, hh, mm) in the browser's own
 * time zone, so a day's minutes are wall-clock minutes; a time that doesn't exist on a clock-change day is refused by validateDayPlan.
 */
export function parseLocalDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), DAY_START_HOUR, 0, 0, 0);
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

export function localDateString(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "HH:MM" for minutes after midnight (1440 = "24:00"). */
export function clockText(minutes: number) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** "HH:MM" of a moment, local time. */
export function timeOf(date: Date) {
  return clockText(date.getHours() * 60 + date.getMinutes());
}

/**
 * The moment `time` ("HH:MM", or "24:00" = midnight at the end of the day) on the local calendar day `date`, or null when the date isn't
 * real or the time doesn't exist that day (the hour skipped when the clocks go forward: 01:30 on 29 March 2026 in the UK).
 */
export function localMoment(date: string, time: string): Date | null {
  const day = parseLocalDate(date);
  const minutes = clockMinutes(time, true);
  if (!day || minutes === null) return null;
  if (minutes === 1440) return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0);
  return d.getDate() === day.getDate() && d.getHours() === hh && d.getMinutes() === mm ? d : null;
}

/** `date` moved by `days` calendar days (negative = earlier), as YYYY-MM-DD. Calendar arithmetic, so a clock change can't move it a day. */
export function addDaysToDate(date: string, days: number) {
  const d = parseLocalDate(date);
  return d ? localDateString(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)) : date;
}

/** Whole calendar days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetweenDates(a: string, b: string) {
  const x = parseLocalDate(a);
  const y = parseLocalDate(b);
  return x && y ? Math.round((Date.UTC(y.getFullYear(), y.getMonth(), y.getDate()) - Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())) / 86400000) : 0;
}

/** Wall-clock minutes of a day of a plan (end - start), or null when the times aren't valid or the end isn't after the start. */
export function dayMinutes(entry: { start: string; end: string }): number | null {
  const start = clockMinutes(entry.start);
  const end = clockMinutes(entry.end, true);
  return start !== null && end !== null && end > start ? end - start : null;
}

/** ISO weekday (Mon = 1 ... Sun = 7) of a "YYYY-MM-DD" date; null when it isn't a real date. */
export function isoWeekday(date: string) {
  const d = parseLocalDate(date);
  return d ? (d.getDay() === 0 ? 7 : d.getDay()) : null;
}

export type DayHoursSplit = { total: number; basic: number; outOfHours: number; workingDay: boolean };

/**
 * How a day of a plan sits against the company's working hours, in minutes, for display only (never pay): basic is the part inside
 * that day's own hours (workHoursByDay, else workStart..workEnd) on one of the company's working days (0 on any other day), out of hours the rest.
 */
export function dayHoursSplit(entry: { date: string; start: string; end: string }, hours: WorkingHours = DEFAULT_WORKING_HOURS): DayHoursSplit {
  const total = dayMinutes(entry) ?? 0;
  const weekday = isoWeekday(entry.date);
  const dayHours = hoursForDay(hours, weekday);
  const workingDay = dayHours !== null;
  const ws = clockMinutes(dayHours?.start) ?? 0;
  const we = clockMinutes(dayHours?.end, true) ?? 0;
  const start = clockMinutes(entry.start) ?? 0;
  const basic = workingDay && total > 0 ? Math.max(0, Math.min(start + total, we) - Math.max(start, ws)) : 0;
  return { total, basic, outOfHours: total - basic, workingDay };
}

/** The time a plan occupies, one segment per day, in the order given. Entries that are not a real date with valid times are skipped. */
export function planSegments(plan: DayPlanEntry[] | null | undefined): BookingSegment[] {
  if (!plan?.length) return [];
  return plan.flatMap((entry) => {
    const minutes = dayMinutes(entry);
    const start = localMoment(entry.date, entry.start);
    const end = localMoment(entry.date, entry.end);
    if (minutes === null || !start || !end || end <= start) return [];
    return [{ date: entry.date, from: entry.start, to: entry.end, minutes, hours: minutes / 60, start, end }];
  });
}

/** Where the database's jsonb is read into a plan; anything that is not a well-formed plan reads as no plan (the default rule). */
export function dayPlanFromRow(raw: unknown): DayPlanEntry[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const plan: DayPlanEntry[] = [];
  for (const item of raw) {
    const v = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const { date, start, end } = v;
    if (typeof date !== "string" || typeof start !== "string" || typeof end !== "string" || !parseLocalDate(date) || dayMinutes({ start, end }) === null) return null;
    plan.push({ date, start, end });
  }
  return plan;
}

/** "6h" / "7.5h" / "0.25h": hours without trailing zeros (formatHours rounds to one decimal, too coarse for quarter hours). */
export function formatPlanHours(hours: number) {
  return `${Number(hours.toFixed(2))}h`;
}

/** "17h", "3h 20m", "45m": a number of minutes, exact to the minute. */
export function formatMinutes(minutes: number) {
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return h && m ? `${h}h ${m}m` : m ? `${m}m` : `${h}h`;
}

/** "Sat 10 Oct" for a plan date. */
export function formatPlanDate(date: string) {
  return parseLocalDate(date)?.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) ?? date;
}

/** One day as "Sat 10 Oct 05:00-13:00". */
export function formatPlanDay(entry: DayPlanEntry) {
  return `${formatPlanDate(entry.date)} ${entry.start}-${entry.end}`;
}

/** The plan as one readable line: "Sat 10 Oct 08:00-14:00 (6h), Sun 11 Oct 08:00-10:00 (2h)". */
export function formatDayPlan(plan: DayPlanEntry[]) {
  return plan.map((entry) => `${formatPlanDay(entry)} (${formatMinutes(dayMinutes(entry) ?? 0)})`).join(", ");
}

/**
 * A row of the "Split by day" form, as the inputs hold it. `end` comes from a time input, which can't show 24:00: an end of "00:00" means
 * midnight at the end of that day and is stored as "24:00" (an end of 00:00 on the same day is otherwise never valid).
 */
export type DayPlanRow = { date: string; start: string; end: string };
export type DayPlanCheck = { ok: true; plan: DayPlanEntry[]; minutes: number; estimatedHours: number } | { ok: false; message: string; minutes: number };

/** The end as stored: an input's "00:00" end is midnight, "24:00". */
export const storedEnd = (end: string) => (end === "00:00" ? "24:00" : end);
/** The end as a time input shows it: "24:00" is "00:00". */
export const inputEnd = (end: string) => (end === "24:00" ? "00:00" : end);

const cents = (n: number) => Math.round(n * 100);

/** The first and last date a plan may use (the database's booking_day_plan_ok: 2000-01-01 to 2100-12-31). */
const MIN_PLAN_DATE = "2000-01-01";
const MAX_PLAN_DATE = "2100-12-31";

/** The estimate in whole minutes, as the database counts it: round(estimated_hours * 60). */
export const estimateMinutes = (estimatedHours: number) => Math.round(estimatedHours * 60);

/** Minutes of one form row, or 0 while its times aren't complete or the end isn't after the start. */
export function rowMinutes(row: DayPlanRow) {
  return dayMinutes({ start: row.start, end: storedEnd(row.end) }) ?? 0;
}

/** Sum of the minutes typed so far (rows not yet complete count as 0). */
export function dayPlanMinutes(rows: DayPlanRow[]) {
  return rows.reduce((sum, row) => sum + rowMinutes(row), 0);
}

/**
 * Checks the rows of the "Split by day" form against the booking's estimated hours, with a message a person can act on. Saving is
 * blocked until it is ok. The rules are the database's (booking_day_plan_ok): real dates, each once, from 2000 to 2100; a start and an end
 * on each, the end after the start on the same day (overnight work is two days); at most 62 days; the minutes adding up to the estimate
 * exactly (to the minute). Also refused here, because only the browser knows the time zone: a time that doesn't exist on a clock-change
 * day. Rows are sorted by date in the plan returned. Working hours are never a reason to refuse.
 */
export function validateDayPlan(rows: DayPlanRow[], estimatedHours: number): DayPlanCheck {
  const minutes = dayPlanMinutes(rows);
  const fail = (message: string): DayPlanCheck => ({ ok: false, message, minutes });
  if (!rows.length) return fail("Add at least one day, or turn off Split by day.");
  if (rows.length > MAX_DAY_PLAN_DAYS) return fail(`A split can have at most ${MAX_DAY_PLAN_DAYS} days.`);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.date || !parseLocalDate(row.date)) return fail("Pick a date for every day.");
    if (row.date < MIN_PLAN_DATE || row.date > MAX_PLAN_DATE) return fail(`${row.date} is out of range. Use dates from 2000 to 2100.`);
    if (seen.has(row.date)) return fail(`${formatPlanDate(row.date)} is listed twice. Each date can only be used once.`);
    seen.add(row.date);
    const day = formatPlanDate(row.date);
    if (clockMinutes(row.start) === null || clockMinutes(storedEnd(row.end), true) === null) return fail(`Enter a start and end time for ${day}.`);
    if (!rowMinutes(row)) return fail(`${day} ends at or before it starts. A day can't run past midnight: put the time after midnight on the next day (for example 22:00 to 00:00, then 00:00 to 06:00).`);
    for (const [label, time] of [["start", row.start], ["end", storedEnd(row.end)]] as const) {
      if (!localMoment(row.date, time)) return fail(`The ${label} time ${time} doesn't exist on ${day}: the clocks go forward that night. Pick a time outside the skipped hour.`);
    }
  }
  if (!(estimatedHours > 0)) return fail("Enter the estimated hours first, then split them across the days.");
  if (Math.abs(estimatedHours * 100 - cents(estimatedHours)) > 1e-6) return fail("The estimated hours need at most 2 decimal places to be split by day.");
  const want = estimateMinutes(estimatedHours);
  if (minutes !== want) {
    return fail(`The days add up to ${formatMinutes(minutes)} but the job is ${formatMinutes(want)} (${formatMinutes(want - minutes)} ${minutes < want ? "short" : "over"}). Make them match to save.`);
  }
  const plan = rows.map((row) => ({ date: row.date, start: row.start, end: storedEnd(row.end) })).sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, plan, minutes, estimatedHours: cents(estimatedHours) / 100 };
}

/** The stretches of machine time a scheduled booking occupies: its plan days, or one stretch from start to finish. */
function intervalsOf(b: Pick<ScheduledBooking, "start" | "finish" | "segments">) {
  return b.segments?.length ? b.segments : [{ start: b.start, end: b.finish }];
}

/** Whether the booking occupies the machine at `t` (inside a planned day, or between start and finish when there is no plan). */
function occupiesAt(b: ScheduledBooking, t: Date) {
  return intervalsOf(b).some((i) => i.start <= t && t < i.end);
}

/** The next moment after `now` the booking starts being worked: its start, or the next planned day. */
function upcomingStart(b: ScheduledBooking, now: Date): Date | null {
  if (b.segments?.length) return b.segments.find((s) => s.start > now)?.start ?? null;
  return b.start > now ? b.start : null;
}

type HoursBooking = Pick<Booking, "estimatedHours" | "hoursDone" | "status">;

/**
 * Hours left WITHOUT the floor at zero: negative once the job has run past its estimate. `liveHours` is the open run's time so far;
 * hoursDone only holds runs that have ended (the database adds a run to it when the run ends), so the two never double count.
 */
export function hoursLeftSigned(booking: HoursBooking, liveHours = 0) {
  if (booking.status === "complete") return 0;
  return booking.estimatedHours - booking.hoursDone - Math.max(0, liveHours);
}

export function hoursLeft(booking: HoursBooking, liveHours = 0) {
  return Math.max(0, hoursLeftSigned(booking, liveHours));
}

/** A running job's clock, in whole minutes: how long this run has been going, and the live "left" (negative = over); null without an estimate. */
export type RunClock = { elapsedMinutes: number; leftMinutes: number | null };

/**
 * The one calculation behind the Job Board's timer and the Machine Schedule's "Hours left" for a running booking: left = estimated hours
 * minus hours done minus this run's time so far (booking.hoursDone excludes the open run). No booking, a complete booking or no estimate
 * (0 hours): elapsed only. An invalid start gives null (nothing is shown). `now` is passed in, so a ticking page re-renders it.
 */
export function runClock(startedAt: string, booking: HoursBooking | null | undefined, now: Date): RunClock | null {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return null;
  const elapsedMs = Math.max(0, now.getTime() - started);
  const hasEstimate = Boolean(booking) && booking!.status !== "complete" && booking!.estimatedHours > 0;
  return {
    elapsedMinutes: Math.floor(elapsedMs / 60_000),
    leftMinutes: hasEstimate ? Math.round(hoursLeftSigned(booking!, elapsedMs / HOUR_MS) * 60) : null,
  };
}

/** "2:35" for minutes (the Settings page's paid-hours format). */
const durationText = (minutes: number) => `${Math.floor(Math.abs(minutes) / 60)}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;

/** Hours as h:mm, the live figures' format: 6 -> "6:00", 2.5 -> "2:30". */
export function formatHoursClock(hours: number) {
  return durationText(Math.round(hours * 60));
}

/** "2:35 left", or "0:20 over" once past the estimate (never a negative). */
export function liveLeftText(leftMinutes: number) {
  return leftMinutes >= 0 ? `${durationText(leftMinutes)} left` : `${durationText(leftMinutes)} over`;
}

/** The Job Board's timer words: "running for 1:25, 2:35 left" / "running for 4:20, 0:20 over" / "running for 1:25" (no estimate). */
export function runTimerText(clock: RunClock) {
  return `running for ${durationText(clock.elapsedMinutes)}${clock.leftMinutes === null ? "" : `, ${liveLeftText(clock.leftMinutes)}`}`;
}

/** Resolve a booking to its start/finish. Remaining hours are counted from now once the start has passed. */
export function scheduleBooking(booking: Booking, machine: Machine, now: Date = new Date()): ScheduledBooking {
  const left = hoursLeft(booking);
  const segments = planSegments(booking.dayPlan);
  if (segments.length) {
    // Split by day: exactly the planned days. `now` does not move it (see "Split by day" above).
    return { ...booking, machine, start: segments[0].start, finish: segments[segments.length - 1].end, hoursLeft: left, segments };
  }
  const start = new Date(booking.startAt);
  const everyDay = runsEveryDay(start, machine);
  const finish = booking.status === "complete"
    ? computeFinish(start, booking.estimatedHours, machine, everyDay)
    : computeFinish(start > now ? start : now, left, machine, everyDay);
  return { ...booking, machine, start, finish: finish < start ? start : finish, hoursLeft: left };
}

/**
 * "Booked" until a run starts, but once the booking's start time has passed with no run started (nothing done against it) it reads
 * "Booked, not started". Derived on read for display only: the stored status and the machine blocking are unchanged, so the machine
 * is never shown as free. A booking that has had hours done (paused) keeps "Booked".
 */
export function bookedNotStarted(booking: Pick<Booking, "status" | "hoursDone"> & { start: Date }, now: Date = new Date()): boolean {
  return booking.status === "booked" && !(booking.hoursDone > 0) && booking.start.getTime() <= now.getTime();
}

/**
 * A booking whose job has been finished is complete, whatever the booking row says. finish_job (migration 044) completes only the
 * bookings of runs it ends, so a job finished without an open run (never started on the machine, or paused) left its booking
 * "booked". Derived on read: no stored data changes, and a database that already completed the row is unchanged.
 */
export function completeFinishedJobBookings(bookings: Booking[], jobs: Pick<ScheduleJob, "id" | "finishedAt">[]): Booking[] {
  const finished = new Set(jobs.filter((j) => j.finishedAt).map((j) => j.id));
  if (!finished.size) return bookings;
  return bookings.map((b) => (b.jobId && b.status !== "complete" && finished.has(b.jobId) ? { ...b, status: "complete" as const } : b));
}

export function scheduleAll(bookings: Booking[], machines: Machine[], now: Date = new Date()): ScheduledBooking[] {
  const byId = new Map(machines.map((m) => [m.id, m]));
  return bookings.flatMap((b) => {
    const machine = byId.get(b.machineId);
    return machine ? [scheduleBooking(b, machine, now)] : [];
  });
}

export type MachineStatus = {
  machine: Machine;
  busy: boolean;
  current: ScheduledBooking | null;
  /** Next moment the machine can take a new job. */
  nextFree: Date;
  next: ScheduledBooking | null;
  /** When `next` is next worked: its start, or for a booking split by day its next planned day. */
  nextStart: Date | null;
};

export function machineStatus(machine: Machine, scheduled: ScheduledBooking[], now: Date = new Date()): MachineStatus {
  const active = scheduled
    .filter((b) => b.machine.id === machine.id && b.status !== "complete")
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const current = active.find((b) => occupiesAt(b, now)) || null;
  let free = normaliseStart(now, machine);
  if (current) {
    free = current.finish;
    // Follow back-to-back bookings so "next free" is genuinely free.
    for (let i = 0; i < active.length; i++) {
      const chained = active.find((b) => b !== current && b.finish > free
        && (b.segments?.length ? occupiesAt(b, free) : normaliseStart(b.start, machine, runsEveryDay(b.start, machine)) <= free));
      if (!chained) break;
      free = chained.finish;
    }
  }
  const upcoming = active
    .flatMap((b) => { const at = b === current ? null : upcomingStart(b, now); return at ? [{ b, at }] : []; })
    .sort((x, y) => x.at.getTime() - y.at.getTime())[0];
  return { machine, busy: Boolean(current), current, nextFree: free, next: upcoming?.b ?? null, nextStart: upcoming?.at ?? null };
}

/**
 * Existing active bookings on the machine that overlap [start, finish). Pass `ignoreId` when editing. When the booking being checked is
 * split by day, pass its planned days as `segments`: it then overlaps only where those days do (a free Sunday between two planned days
 * is not a clash), and an existing booking split by day clashes only on its own planned days.
 */
export function findOverlaps(machine: Machine, scheduled: ScheduledBooking[], start: Date, finish: Date, ignoreId?: string, segments?: BookingSegment[] | null) {
  const mine = segments?.length ? segments : [{ start, end: finish }];
  return scheduled.filter((b) => b.machine.id === machine.id && b.id !== ignoreId && b.status !== "complete"
    && intervalsOf(b).some((i) => mine.some((m) => i.start < m.end && i.end > m.start)));
}

export function suggestedHours(job: Pick<ScheduleJob, "estimatedHours">) {
  return job.estimatedHours;
}

// ---------- Formatting (en-GB) ----------

export function formatDayTime(date: Date) {
  const day = date.toLocaleDateString("en-GB", { weekday: "short" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

export function formatDateTimeShort(date: Date) {
  return `${date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

export function formatHours(hours: number) {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

export function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function mondayOf(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export const WEEKDAY_OPTIONS = [
  { dow: 1, label: "Mon" }, { dow: 2, label: "Tue" }, { dow: 3, label: "Wed" }, { dow: 4, label: "Thu" },
  { dow: 5, label: "Fri" }, { dow: 6, label: "Sat" }, { dow: 0, label: "Sun" },
];

// ---------- Self-check (pure; run from a script or test) ----------

export function selfCheckFinish(): boolean {
  const machine = { hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS };
  const fri = new Date(2026, 9, 9, 8, 0); // Fri 9 Oct 2026 08:00
  const end = computeFinish(fri, 20, machine);
  return end.getFullYear() === 2026 && end.getMonth() === 9 && end.getDate() === 13 && end.getHours() === 12 && end.getMinutes() === 0;
}

// ---------- Demo data ----------

function at(base: Date, dayOffset: number, hour = DAY_START_HOUR) {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Sample data is only produced in DEMO_MODE; otherwise these return nothing so no tenant ever sees fake machines. */
export function demoMachines(): Machine[] {
  if (!DEMO_MODE) return [];
  const types = ["Vertical machining centre", "CNC lathe", "Turn-mill centre", "Vertical machining centre", "Manual mill", "Manual lathe"];
  return DEMO_MACHINES.map((name, i) => ({ id: `demo-m${i + 1}`, name, type: types[i] || "", hoursPerDay: 8, workingDays: [...DEFAULT_WORKING_DAYS], active: true }));
}

export function demoBookings(today: Date = new Date()): Booking[] {
  if (!DEMO_MODE) return [];
  const mon = mondayOf(today);
  const mk = (n: number, machine: number, jobNo: string, description: string, startAt: string, estimatedHours: number, hoursDone: number, status: BookingStatus): Booking => ({
    id: `demo-b${n}`, machineId: `demo-m${machine}`, jobId: null, jobNo, description, startAt, estimatedHours, hoursDone, status, notes: "",
  });
  return [
    mk(1, 1, "JNR-J-218", "Titanium brackets", at(mon, 0), 22, 14, "running"),
    mk(2, 1, "JNR-J-221", "Components", at(mon, 4), 14, 0, "booked"),
    mk(3, 2, "JNR-J-220", "SS shafts", at(mon, 1), 12, 12, "complete"),
    mk(4, 2, "JNR-J-219", "Aluminium plates", at(mon, 3), 18, 0, "booked"),
    mk(5, 4, "JNR-J-222", "Bronze fittings", at(mon, 2), 30, 20, "running"),
  ];
}

export function demoJobs(today: Date = new Date()): ScheduleJob[] {
  if (!DEMO_MODE) return [];
  const mon = mondayOf(today);
  const due = (offset: number) => at(mon, offset).slice(0, 10);
  return [
    { id: "demo-j1", jobNo: "JNR-J-218", description: "Titanium brackets", customer: "Aerospace Components", dateRequired: due(9), estimatedHours: 22 },
    { id: "demo-j2", jobNo: "JNR-J-219", description: "Aluminium plates", customer: "Industrial Systems", dateRequired: due(8), estimatedHours: 18 },
    { id: "demo-j3", jobNo: "JNR-J-220", description: "SS shafts", customer: "Precision Engineering", dateRequired: due(2), estimatedHours: 12 },
    { id: "demo-j4", jobNo: "JNR-J-221", description: "Components", customer: "Defence Manufacturing", dateRequired: due(11), estimatedHours: 14 },
    { id: "demo-j5", jobNo: "JNR-J-222", description: "Bronze fittings", customer: "Marine Engineering", dateRequired: due(4), estimatedHours: 30 },
  ];
}

// ---------- Supabase access ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
const toIso = (days: number[]) => days.map((d) => (d === 0 ? 7 : d));
const fromIso = (days: unknown): number[] => (Array.isArray(days) ? days.map((d) => Number(d) % 7) : [...DEFAULT_WORKING_DAYS]);

function machineFromRow(row: any): Machine {
  return {
    id: String(row.id),
    name: String(row.name || row.machine_name || row.machine || "Machine"),
    type: row.type ? String(row.type) : "",
    hoursPerDay: Number(row.hours_per_day ?? 8) || 8,
    workingDays: fromIso(row.working_days),
    active: row.active !== false,
  };
}

function bookingFromRow(row: any): Booking {
  return {
    id: String(row.id),
    machineId: String(row.machine_id),
    jobId: row.job_id ? String(row.job_id) : null,
    jobNo: row.job_no || "",
    description: row.description || "",
    startAt: row.start_at,
    estimatedHours: Number(row.estimated_hours || 0),
    hoursDone: Number(row.hours_done || 0),
    status: (["booked", "running", "complete"].includes(row.status) ? row.status : "booked") as BookingStatus,
    notes: row.notes || "",
    dayPlan: dayPlanFromRow(row.day_plan),
  };
}

export async function fetchSchedule(): Promise<{ machines: Machine[]; bookings: Booking[]; jobs: ScheduleJob[] }> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const client = supabase;
  // Bookings and jobs: every row, page by page (lib/fetch-all); the API returns at most 1,000 per request.
  const [machinesRes, bookings, jobsAll] = await Promise.all([
    client.from("machines").select("*"),
    fetchAll((from, to) => client.from("machine_bookings").select("*").order("start_at", { ascending: true }).order("id").range(from, to)),
    fetchAll((from, to) => client.from("jobs").select("*").order("created_at", { ascending: false }).order("id").range(from, to)),
  ]);
  if (machinesRes.error) throw machinesRes.error;
  const bookingsRes = { data: bookings.rows };
  const jobsRes = { data: jobsAll.rows };
  const jobs: ScheduleJob[] = (jobsRes.data || []).map((row: any) => {
    const setup = Number(row.setup_time_hr) || 0;
    const run = Number(row.run_time_hr) || 0;
    const quoted = Number(row.job_time_quoted_hr) || 0;
    const est = setup + run > 0 ? setup + run : quoted > 0 ? quoted : null;
    return {
      id: String(row.id),
      jobNo: row.job_no || row.reference || `JOB-${String(row.id).slice(0, 8)}`,
      description: row.description || "",
      customer: row.customer || row.customer_name || "",
      dateRequired: /^\d{4}-\d{2}-\d{2}/.test(String(row.date_required || "")) ? String(row.date_required).slice(0, 10) : "",
      estimatedHours: est,
      finishedAt: row.finished_at ? String(row.finished_at) : "",
    };
  });
  return {
    machines: (machinesRes.data || []).map(machineFromRow).sort((a, b) => a.name.localeCompare(b.name)),
    bookings: (bookingsRes.data || []).map(bookingFromRow),
    jobs,
  };
}

export async function saveMachine(machine: Omit<Machine, "id"> & { id?: string }): Promise<Machine> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const payload = { name: machine.name, type: machine.type || null, hours_per_day: machine.hoursPerDay, working_days: toIso(machine.workingDays), active: machine.active };
  if (machine.id) {
    const { data, error } = await supabase.from("machines").update(payload).eq("id", machine.id).select("*").single();
    if (error) throw error;
    return machineFromRow(data);
  }
  const organization_id = await getCurrentOrganizationId();
  const { data, error } = await supabase.from("machines").insert({ ...payload, organization_id }).select("*").single();
  if (error) throw error;
  return machineFromRow(data);
}

export type BookingSaveOptions = {
  /** Removes a plan the booking had (back to the default rule). A save without a plan otherwise leaves an existing plan alone. */
  clearDayPlan?: boolean;
  /** Admin only: book over another job, with the reason the database records (OVERRIDE_MACHINE_CLASH). */
  clashOverride?: boolean;
  overrideReason?: string;
};

/**
 * Every booking write goes through the database's save_machine_booking (migration 042): the same per-company lock as the Job Board's
 * create_job, then the clash check against the schedule's own rule (booking_intervals), then the write. A clash is refused (error hint
 * machine_clash) unless an admin books anyway with a reason, which is recorded. Nothing writes machine_bookings directly any more.
 */
export async function saveBooking(booking: Omit<Booking, "id"> & { id?: string }, options: BookingSaveOptions = {}): Promise<Booking> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("save_machine_booking", {
    p_id: booking.id ?? null,
    p_machine: booking.machineId,
    p_job: booking.jobId,
    p_job_no: booking.jobNo,
    p_description: booking.description || null,
    p_start: booking.startAt,
    p_hours: booking.estimatedHours,
    p_hours_done: booking.hoursDone,
    p_status: booking.status,
    p_notes: booking.notes || null,
    p_day_plan: booking.dayPlan?.length ? booking.dayPlan : null,
    p_clear_day_plan: Boolean(options.clearDayPlan),
    p_clash_override: Boolean(options.clashOverride),
    p_override_reason: options.overrideReason?.trim() || null,
  });
  if (error) throw error;
  return bookingFromRow(data);
}

/** A failed save that names a clash or asks for the override reason: its message is the one to show. */
export function bookingSaveMessage(err: unknown): string | null {
  const e = err as { hint?: string; message?: string } | null;
  return e && (e.hint === "machine_clash" || e.hint === "override_reason") && e.message ? e.message : null;
}

export async function deleteBooking(id: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  // The database removes the row or says why it didn't (already removed, or not this company's); nothing deletes the table directly.
  const { error } = await supabase.rpc("delete_machine_booking", { p_id: id });
  if (error) throw new Error(error.message);
}

/** One machine on a new job (Job Board "New job", migration 042): the hours it runs and, if chosen by hand, its start. */
export type NewJobMachine = { machineId: string; hours: number; start?: Date | null };
/** That machine's booking as the new job would make it, with the active bookings it would overlap. */
export type PlannedJobBooking = { machine: Machine; hours: number; start: Date; finish: Date; clashes: ScheduledBooking[] };
export type JobBookingPlan = {
  bookings: PlannedJobBooking[];
  /** Every clash, one per machine and existing job number, as create_job takes them. */
  clashes: { machine_id: string; job_no: string }[];
  /** What create_job takes as p_machines. */
  payload: { machine_id: string; hours: number; start_at: string }[];
};

/** Where a new booking on the machine starts by default: its next free slot, as the schedule's booking dialog suggests it. */
export function defaultJobStart(machine: Machine, scheduled: ScheduledBooking[], now: Date = new Date()) {
  return machineStatus(machine, scheduled, now).nextFree;
}

/**
 * The bookings a new job makes, one per machine, all in parallel: each from its own start (by default the machine's next free slot) for
 * its hours, with the finish worked out by the same rule as the schedule (the machine's working days and hours). Clashes are found the
 * same way as the schedule's overlap warning. Machines that are unknown are left out. saveBooking is not used: the job, its number and
 * its bookings are made together by create_job.
 */
export function planJobBookings(rows: NewJobMachine[], machines: Machine[], scheduled: ScheduledBooking[], now: Date = new Date()): JobBookingPlan {
  const byId = new Map(machines.map((m) => [m.id, m]));
  const bookings = rows.flatMap((row): PlannedJobBooking[] => {
    const machine = byId.get(row.machineId);
    if (!machine) return [];
    const start = row.start && !Number.isNaN(row.start.getTime()) ? row.start : defaultJobStart(machine, scheduled, now);
    const hours = Number.isFinite(row.hours) && row.hours > 0 ? row.hours : 0;
    const finish = hours > 0 ? computeFinish(start, hours, machine) : start;
    const clashes = hours > 0 ? findOverlaps(machine, scheduled, start, finish) : [];
    return [{ machine, hours, start, finish, clashes }];
  });
  const clashes = bookings.flatMap((b) => [...new Set(b.clashes.map((c) => c.jobNo || "(no job number)"))].map((jobNo) => ({ machine_id: b.machine.id, job_no: jobNo })));
  const payload = bookings.map((b) => ({ machine_id: b.machine.id, hours: b.hours, start_at: b.start.toISOString() }));
  return { bookings, clashes, payload };
}
