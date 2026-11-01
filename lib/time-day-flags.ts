/**
 * Day flags on the daily job sheet (migration 074; The JNR controller, Sun 18 Oct 2026): four tick boxes per person and day, "Overtime", "Saturday",
 * "Sunday", "Bank holiday", ticked by the person or the office and shown on the weekly approval with totals per type. FLAGS ONLY: the
 * overtime is NOT worked out from hours (The JNR controller: "we just give overtime payments a box to tick"; bank holidays are holiday allowance, no rate),
 * so nothing here is multiplied or priced and "Overtime" is ticked by a person only.
 *
 * SUGGESTIONS (fewer taps): a day with nothing saved shows Saturday, Sunday and Bank holiday ticked from its date (bank holidays of the
 * company's region, 050's bank_holidays and time_settings.bank_holiday_region, as loaded by lib/time-data). Overtime is never suggested
 * (not from the 8 hour rule, not from Saturday). They are only suggestions: stored when someone saves the day's ticks (a
 * tick or untick saves all four; Confirm saves them as shown).
 *
 * WHAT COUNTS: the weekly totals per type, and the figures stored with an approval (totals.day_flags), count SAVED ticks only, the same
 * set 074's revision fingerprints (time_week_revision: the saved rows). So "changed since approval" appears exactly when the counted
 * figures can change, and an approved week's counts never move without it. The review still shows a worked day's unsaved suggestions,
 * starred and not counted, and an approver can save them for the week in one press. (Counting suggestions would need the revision to
 * fingerprint them, i.e. lib/time-sheet's pairing, breaks and overtime rebuilt in SQL, and an open shift's paid time grows with the
 * clock, so the revision would change by itself while someone is clocked in.)
 *
 * SAVING needs a connection (set_time_day_flags, keyed with a client_op_id so a retry is answered, never applied twice): ticks are not
 * queued on the device like clock actions; the sheet says so when offline.
 *
 * BEFORE 074 IS APPLIED (the app deploys first): the boxes stay hidden until a GET probe of time_day_flags answers. Never a head-only
 * count: with supabase-js a HEAD for a missing table comes back as "no error" (see tests/unit/db-probe-get.test.ts on the probe branch).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fmtWeekdayDay } from "@/lib/dates";
import { featurePresent, missingDbObject } from "@/lib/time-features";
import { TimeDataError } from "@/lib/time-data";
import { type DayTotals, type WeekTotals, roundMinutes, weekdayOf } from "@/lib/time-sheet";

export const DAY_FLAG_KEYS = ["overtime", "saturday", "sunday", "bank_holiday"] as const;
export type DayFlagKey = (typeof DAY_FLAG_KEYS)[number];
export type DayFlags = Record<DayFlagKey, boolean>;
export const DAY_FLAG_LABEL: Record<DayFlagKey, string> = { overtime: "Overtime", saturday: "Saturday", sunday: "Sunday", bank_holiday: "Bank holiday" };
export const DAY_FLAG_SHORT: Record<DayFlagKey, string> = { overtime: "OT", saturday: "Sat", sunday: "Sun", bank_holiday: "BH" };
export const NO_FLAGS: DayFlags = { overtime: false, saturday: false, sunday: false, bank_holiday: false };

export type SavedDayFlags = DayFlags & { user_id: string; day: string; updated_by: string | null; updated_at: string };

export const DAY_FLAGS_NEED_CONNECTION = "Day ticks need a connection: they aren't saved on this device. Tick them again when you're back online.";

// ----- suggestions ---------------------------------------------------------------------------------------------------------------------
/**
 * What the sheet pre-ticks for a day with nothing saved: Saturday / Sunday from the date, Bank holiday when the date is one in the
 * company's region (`bankHolidays`: date -> name for that region). Overtime is never pre-ticked: a person ticks it.
 */
export function suggestDayFlags(input: { date: string; bankHolidays: Map<string, string> }): DayFlags {
  const wd = weekdayOf(input.date);
  return {
    overtime: false,
    saturday: wd === 6,
    sunday: wd === 0,
    bank_holiday: input.bankHolidays.has(input.date),
  };
}

export const anyFlag = (f: DayFlags) => DAY_FLAG_KEYS.some((k) => f[k]);
export const sameFlags = (a: DayFlags, b: DayFlags) => DAY_FLAG_KEYS.every((k) => a[k] === b[k]);
export const pickFlags = (f: DayFlags): DayFlags => ({ overtime: f.overtime, saturday: f.saturday, sunday: f.sunday, bank_holiday: f.bank_holiday });

export type DayFlagSource = "saved" | "suggested" | "none";
export type EffectiveDayFlags = { date: string; flags: DayFlags; source: DayFlagSource; paid: number };

/**
 * The ticks that count for one day: what is saved; else, for a day worked (or when `always`, the sheet), the suggestions; else none.
 */
export function effectiveDayFlags(day: Pick<DayTotals, "date" | "paid" | "worked">, saved: DayFlags | null | undefined,
  bankHolidays: Map<string, string>, always = false): EffectiveDayFlags {
  if (saved) return { date: day.date, flags: pickFlags(saved), source: "saved", paid: day.paid };
  if (!day.worked && !always) return { date: day.date, flags: { ...NO_FLAGS }, source: "none", paid: day.paid };
  const flags = suggestDayFlags({ date: day.date, bankHolidays });
  return { date: day.date, flags, source: anyFlag(flags) ? "suggested" : "none", paid: day.paid };
}

// ----- weekly totals -------------------------------------------------------------------------------------------------------------------
export type FlagTotals = Record<DayFlagKey, { days: number; paidMinutes: number }>;
/** totals: saved ticks only (see WHAT COUNTS); suggestedDays: worked days showing unsaved suggestions (shown, not counted). */
export type WeekDayFlags = { days: EffectiveDayFlags[]; totals: FlagTotals; anySuggested: boolean; suggestedDays: number };

/** Per type: the number of days with a SAVED tick and the paid minutes on those days. Counts only; no rates, no multipliers. */
export function flagTotals(days: EffectiveDayFlags[]): FlagTotals {
  const totals = Object.fromEntries(DAY_FLAG_KEYS.map((k) => [k, { days: 0, paidMinutes: 0 }])) as FlagTotals;
  for (const d of days) if (d.source === "saved") for (const k of DAY_FLAG_KEYS) if (d.flags[k]) {
    totals[k].days += 1;
    totals[k].paidMinutes += d.paid;
  }
  return totals;
}

/** One person's week: each day's ticks (saved, or suggested for a day worked) and the totals per type. `saved`: that person's rows. */
export function weekDayFlags(week: WeekTotals, saved: SavedDayFlags[], bankHolidays: Map<string, string>): WeekDayFlags {
  const byDay = new Map(saved.map((s) => [s.day, s]));
  const days = week.days.map((d) => effectiveDayFlags(d, byDay.get(d.date), bankHolidays));
  const suggestedDays = days.filter((d) => d.source === "suggested").length;
  return { days, totals: flagTotals(days), anySuggested: suggestedDays > 0, suggestedDays };
}

/** For the approval record (what the JNR controller saw): per type, days and whole paid minutes. */
export function flagTotalsSnapshot(totals: FlagTotals) {
  return Object.fromEntries(DAY_FLAG_KEYS.map((k) => [k, { days: totals[k].days, paid_minutes: roundMinutes(totals[k].paidMinutes) }]));
}

/** Ticks can be saved for today and earlier days, not a day still to come (the server refuses it: bad_day). */
export const dayFlagsEditable = (date: string, today: string) => date <= today;
export const DAY_FLAGS_FUTURE = "Ticks can be saved from the day itself, not before.";

export type DayFlagsLoadState = { present: boolean | null; saved: SavedDayFlags | null; loaded: boolean; error: string | null };
export const DAY_FLAGS_LOADING: DayFlagsLoadState = { present: null, saved: null, loaded: false, error: null };

/**
 * Loads one person's day for the sheet, LATEST REQUEST ONLY: every load first resets to nothing (so a failure never leaves the
 * previous day's ticks showing) and an answer that arrives after a newer load started (the date or person changed meanwhile) is
 * dropped, so one day's ticks never show on another. `onError` turns a failure into the message shown.
 */
export function createDayFlagsLoader(deps: {
  probe: () => Promise<boolean | null>;
  read: (opts: { userId: string; from: string; to: string }) => Promise<{ present: boolean; rows: SavedDayFlags[] }>;
  onState: (state: DayFlagsLoadState) => void;
  onError: (err: unknown) => string;
}) {
  let latest = 0;
  return {
    async load(personId: string, date: string) {
      const id = ++latest;
      const current = () => id === latest;
      deps.onState({ ...DAY_FLAGS_LOADING });
      const present = await deps.probe();
      if (!current()) return;
      if (present !== true) {
        deps.onState({ ...DAY_FLAGS_LOADING, present });
        return;
      }
      try {
        const result = await deps.read({ userId: personId, from: date, to: date });
        if (!current()) return;
        if (!result.present) {
          deps.onState({ ...DAY_FLAGS_LOADING, present: false });
          return;
        }
        deps.onState({ present: true, saved: result.rows.find((r) => r.user_id === personId && r.day === date) ?? null, loaded: true, error: null });
      } catch (err) {
        if (current()) deps.onState({ present: true, saved: null, loaded: false, error: deps.onError(err) });
      }
    },
    /** For a save: take token() before it, apply its answer only if isCurrent(token) (no newer load started meanwhile). */
    token: () => latest,
    isCurrent: (token: number) => token === latest,
  };
}

/** "Sat 24" for a local date. */
export const shortDay = (date: string) => fmtWeekdayDay(date);

/** "Sat, OT" for a day's ticks (empty when none). */
export const flagsShort = (f: DayFlags) => DAY_FLAG_KEYS.filter((k) => f[k]).map((k) => DAY_FLAG_SHORT[k]).join(", ");

// ----- database -----------------------------------------------------------------------------------------------------------------------
type DbError = { code?: string | null; message?: string | null } | null | undefined;
type Probe = { from: (table: string) => { select: (columns: string) => { limit: (n: number) => PromiseLike<{ error: DbError }> } } };

let cached: boolean | null = null;
let cachedAt = 0;
let pending: Promise<boolean | null> | null = null;
/** "Not yet" is asked again after this long, so a page left open picks up 074 once it is applied. "Present" is kept. */
export const DAY_FLAGS_RECHECK_MS = 60_000;

/**
 * Does the database have 074? A one-row GET of time_day_flags (row rules: the caller's own at most). true: present; false: the table
 * isn't there yet (hide the boxes); null: no answer (offline, a timeout): ask again later, show nothing.
 */
export async function databaseHasDayFlags(client: Probe | null, now = Date.now()): Promise<boolean | null> {
  if (cached === true || (cached === false && now - cachedAt < DAY_FLAGS_RECHECK_MS)) return cached;
  if (!client) return null;
  pending ??= (async () => {
    try {
      const present = featurePresent(await client.from("time_day_flags").select("day").limit(1));
      if (present !== null) {
        cached = present;
        cachedAt = now;
      }
      return present;
    } catch {
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** For tests: forget the cached answer. */
export function resetDayFlagsCache() {
  cached = null;
  cachedAt = 0;
  pending = null;
}

const COLUMNS = "user_id, day, overtime, saturday, sunday, bank_holiday, updated_by, updated_at";

/**
 * Saved ticks for days `from` to `to` (local dates, inclusive) and one person (null: everyone the caller may see). Before 074 is
 * applied: present false and no rows (never an error page). Any other failure is thrown like the other time reads.
 */
export async function loadDayFlags(client: Pick<SupabaseClient, "from">, opts: { userId: string | null; from: string; to: string }): Promise<{ present: boolean; rows: SavedDayFlags[] }> {
  let query = client.from("time_day_flags").select(COLUMNS).gte("day", opts.from).lte("day", opts.to);
  if (opts.userId) query = query.eq("user_id", opts.userId);
  const { data, error } = await query.order("day").limit(5000);
  if (error) {
    if (missingDbObject(error)) return { present: false, rows: [] };
    throw new TimeDataError(error);
  }
  return { present: true, rows: (data ?? []) as SavedDayFlags[] };
}

/** Saves one day's four ticks (online only; the key makes a retry safe). Resolves with the stored row. */
export async function saveDayFlags(client: Pick<SupabaseClient, "rpc">, input: { clientOpId: string; userId: string; day: string; flags: DayFlags }): Promise<SavedDayFlags> {
  const { data, error } = await client.rpc("set_time_day_flags", {
    p_client_op_id: input.clientOpId, p_user: input.userId, p_day: input.day,
    p_overtime: input.flags.overtime, p_saturday: input.flags.saturday, p_sunday: input.flags.sunday, p_bank_holiday: input.flags.bank_holiday,
  });
  if (error) throw error;
  return data as SavedDayFlags;
}
