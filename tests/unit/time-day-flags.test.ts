/**
 * Day flags on the daily job sheet (migration 074, lib/time-day-flags.ts): the suggestions shown ticked for a day with nothing saved
 * (Saturday, Sunday, a bank holiday of the company's region; never Overtime, which only a person ticks), the
 * weekly totals per type (days and paid hours on them, no money), and the app before 074 is applied (GET probe, no boxes, no error).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DAY_FLAGS_LOADING, type DayFlagsLoadState, NO_FLAGS, type SavedDayFlags, createDayFlagsLoader, databaseHasDayFlags, dayFlagsEditable,
  effectiveDayFlags, flagTotals, flagTotalsSnapshot, flagsShort, loadDayFlags, resetDayFlagsCache, saveDayFlags, suggestDayFlags, weekDayFlags,
} from "@/lib/time-day-flags";
import { TimeDataError } from "@/lib/time-data";
import { type AttendanceEvent, DEFAULT_TIME_SETTINGS, approvalSnapshot, dayTotals, localInstant, weekTotals } from "@/lib/time-sheet";
import { loadWeek } from "@/lib/time-week";

const S = DEFAULT_TIME_SETTINGS;
const NONE = new Map<string, string>();
const LATER = new Date("2027-06-01T00:00:00Z").getTime();
let n = 0;
function ev(action: AttendanceEvent["action"], local: string): AttendanceEvent {
  n += 1;
  const [date, time] = local.split(" ");
  const r = localInstant(date, time);
  if (r.kind !== "ok") throw new Error(local);
  return { id: `e${n}`, user_id: "u", action, at: r.at.toISOString(), received_at: new Date(2026, 0, 1, 0, 0, n).toISOString() };
}
const shift = (date: string, from: string, to: string) => [ev("in", `${date} ${from}`), ev("out", `${date} ${to}`)];
const saved = (day: string, f: Partial<typeof NO_FLAGS>): SavedDayFlags => ({ ...NO_FLAGS, ...f, user_id: "u", day, updated_by: "u", updated_at: "2026-10-30T12:00:00Z" });

beforeEach(() => resetDayFlagsCache());

describe("suggestions (pre-ticked, not saved)", () => {
  it("Saturday and Sunday from the date; a weekday has neither", () => {
    expect(suggestDayFlags({ date: "2026-10-24", bankHolidays: NONE })).toEqual({ ...NO_FLAGS, saturday: true });
    expect(suggestDayFlags({ date: "2026-10-25", bankHolidays: NONE })).toEqual({ ...NO_FLAGS, sunday: true });
    expect(suggestDayFlags({ date: "2026-10-21", bankHolidays: NONE })).toEqual(NO_FLAGS);
  });

  it("a bank holiday of the company's region only (the map is the region's, as lib/time-data loads it)", () => {
    // First Monday in August: Scotland's summer bank holiday, an ordinary Monday in England and Wales (theirs is the last Monday).
    const scotland = new Map([["2026-08-03", "Summer bank holiday"]]);
    const englandWales = new Map([["2026-08-31", "Summer bank holiday"], ["2026-12-25", "Christmas Day"]]);
    expect(suggestDayFlags({ date: "2026-08-03", bankHolidays: scotland }).bank_holiday).toBe(true);
    expect(suggestDayFlags({ date: "2026-08-03", bankHolidays: englandWales }).bank_holiday).toBe(false);
    expect(suggestDayFlags({ date: "2026-08-31", bankHolidays: englandWales }).bank_holiday).toBe(true);
    // A bank holiday on a Saturday keeps both ticks (the date is a Saturday and a holiday).
    expect(suggestDayFlags({ date: "2026-12-26", bankHolidays: new Map([["2026-12-26", "Boxing Day"]]) })).toEqual({ ...NO_FLAGS, saturday: true, bank_holiday: true });
  });

  it("Overtime is never suggested: not over 8 hours of paid time, not on a Saturday (The JNR controller: a person ticks it)", () => {
    // 07:00 to 16:30 = 9:30 clocked, 45 minutes of unpaid breaks = 8:45 paid: over 8 hours, yet nothing is suggested.
    const long = dayTotals({ date: "2026-10-21", events: shift("2026-10-21", "07:00", "16:30"), labour: [], settings: S, bankHolidays: NONE, now: LATER });
    expect(long.paid).toBe(525);
    expect(suggestDayFlags({ date: long.date, bankHolidays: NONE })).toEqual(NO_FLAGS);
    expect(effectiveDayFlags(long, null, NONE)).toMatchObject({ source: "none", flags: NO_FLAGS });
    // A Saturday suggests Saturday only; a Sunday Sunday only; a bank holiday Bank holiday only.
    for (const date of ["2026-10-24", "2026-10-25", "2026-08-31"]) expect(suggestDayFlags({ date, bankHolidays: new Map([["2026-08-31", "Summer bank holiday"]]) }).overtime).toBe(false);
  });

  it("what counts for a day: saved ticks win (even all unticked); a day worked with nothing saved gets the suggestions; an idle day none", () => {
    const sat = dayTotals({ date: "2026-10-24", events: shift("2026-10-24", "08:00", "12:00"), labour: [], settings: S, bankHolidays: NONE, now: LATER });
    expect(effectiveDayFlags(sat, null, NONE)).toMatchObject({ source: "suggested", flags: { ...NO_FLAGS, saturday: true } });
    expect(effectiveDayFlags(sat, saved("2026-10-24", {}), NONE)).toMatchObject({ source: "saved", flags: NO_FLAGS });
    const idleSun = dayTotals({ date: "2026-10-25", events: [], labour: [], settings: S, bankHolidays: NONE, now: LATER });
    expect(effectiveDayFlags(idleSun, null, NONE)).toMatchObject({ source: "none", flags: NO_FLAGS });
    // The sheet itself shows the date's suggestions for any day (always).
    expect(effectiveDayFlags(idleSun, null, NONE, true)).toMatchObject({ source: "suggested", flags: { ...NO_FLAGS, sunday: true } });
    expect(flagsShort({ ...NO_FLAGS, saturday: true, overtime: true })).toBe("OT, Sat");
  });
});

describe("weekly totals per type", () => {
  it("days with a SAVED tick and the paid hours on those days, per type; suggestions are shown, not counted; no money", () => {
    const events = [
      ...shift("2026-10-19", "07:00", "16:30"), // Mon 8:45 paid (nothing suggested: Overtime is ticked by a person)
      ...shift("2026-10-20", "07:00", "15:00"), // Tue 7:15 paid; saved as overtime by the office
      ...shift("2026-10-21", "07:00", "16:30"), // Wed 8:45 paid; saved with overtime unticked by the person
      ...shift("2026-10-24", "08:00", "14:30"), // Sat 6:30 clocked, 5:45 paid (suggested: Saturday)
    ];
    const week = weekTotals({ weekStart: "2026-10-19", events, labour: [], settings: S, bankHolidays: NONE, now: LATER });
    const flags = weekDayFlags(week, [saved("2026-10-20", { overtime: true }), saved("2026-10-21", {}), saved("2026-10-25", { sunday: true })], NONE);
    expect(flags.days.map((d) => d.source)).toEqual(["none", "saved", "saved", "none", "none", "suggested", "saved"]);
    // Monday shows no Overtime suggestion (8:45 paid is over 8 hours, but overtime is ticked by a person); Saturday's suggested Saturday is
    // shown but not counted: only Tuesday's saved overtime is.
    expect(flags.days[0].flags.overtime).toBe(false);
    expect(flags.days[5].flags.saturday).toBe(true);
    expect(flags.totals.overtime).toEqual({ days: 1, paidMinutes: 435 });
    expect(flags.totals.saturday).toEqual({ days: 0, paidMinutes: 0 });
    // A Sunday ticked though not worked counts as a day with no paid hours.
    expect(flags.totals.sunday).toEqual({ days: 1, paidMinutes: 0 });
    expect(flags.totals.bank_holiday).toEqual({ days: 0, paidMinutes: 0 });
    expect(flags.anySuggested).toBe(true);
    expect(flags.suggestedDays).toBe(1);
    // Stored with an approval in whole minutes; left out entirely without 074.
    const snap = approvalSnapshot(week, flagTotalsSnapshot(flags.totals));
    expect(snap.day_flags).toEqual({ overtime: { days: 1, paid_minutes: 435 }, saturday: { days: 0, paid_minutes: 0 }, sunday: { days: 1, paid_minutes: 0 }, bank_holiday: { days: 0, paid_minutes: 0 } });
    expect("day_flags" in approvalSnapshot(week)).toBe(false);
    // overtime_minutes = the paid minutes on days with a SAVED Overtime tick (Tuesday's 435), basic_minutes = paid; 0 overtime before 074.
    expect([snap.overtime_minutes, snap.basic_minutes, snap.paid_minutes]).toEqual([435, snap.paid_minutes, Math.round(week.paid)]);
    expect(approvalSnapshot(week).overtime_minutes).toBe(0);
    expect(JSON.stringify(snap.day_flags)).not.toMatch(/rate|pay|£|multiplier/i);
  });

  it("flagTotals adds up the saved days of any list (a suggested day is skipped)", () => {
    const t = flagTotals([
      { date: "a", flags: { ...NO_FLAGS, bank_holiday: true, overtime: true }, source: "saved", paid: 600 },
      { date: "b", flags: { ...NO_FLAGS, bank_holiday: true }, source: "saved", paid: 120.4 },
      { date: "c", flags: { ...NO_FLAGS, bank_holiday: true }, source: "suggested", paid: 300 },
    ]);
    expect(t.bank_holiday).toEqual({ days: 2, paidMinutes: 720.4 });
    expect(t.overtime).toEqual({ days: 1, paidMinutes: 600 });
    expect(flagTotalsSnapshot(t).bank_holiday).toEqual({ days: 2, paid_minutes: 720 });
  });

  it("the counted figures follow the saved ticks only, as the week's revision does: suggestions, settings or holidays alone never move them", () => {
    const events = [...shift("2026-08-31", "07:00", "17:00"), ...shift("2026-09-05", "07:00", "17:00")]; // the E&W summer bank holiday (Mon), and Sat
    const week = weekTotals({ weekStart: "2026-08-31", events, labour: [], settings: S, bankHolidays: NONE, now: LATER });
    const holidays = new Map([["2026-08-31", "Summer bank holiday"]]);
    const zero = flagTotalsSnapshot(weekDayFlags(week, [], NONE).totals);
    // Nothing saved: whatever the suggestions (the holiday known or not), nothing counted; the approval stores zeros.
    expect(flagTotalsSnapshot(weekDayFlags(week, [], holidays).totals)).toEqual(zero);
    expect(weekDayFlags(week, [], holidays).suggestedDays).toBe(2);
    // Saving exactly what was suggested is a change of the saved ticks (the revision changes) and of the counted figures, together.
    const asSuggested = weekDayFlags(week, [], holidays).days.filter((d) => d.source === "suggested").map((d) => saved(d.date, d.flags));
    const after = weekDayFlags(week, asSuggested, holidays);
    expect(after.suggestedDays).toBe(0);
    expect(flagTotalsSnapshot(after.totals)).not.toEqual(zero);
    expect(after.totals.saturday.days).toBe(1);
    expect(after.totals.bank_holiday.days).toBe(1);
    // With saved ticks fixed, the holidays known don't move the counted figures either.
    expect(weekDayFlags(week, asSuggested, NONE).totals).toEqual(after.totals);
  });
});

describe("the sheet's tick boxes: future days, and loads that answer late", () => {
  it("today and earlier days can be ticked; a day still to come can't (the server refuses it: bad_day)", () => {
    expect(dayFlagsEditable("2026-10-18", "2026-10-18")).toBe(true);
    expect(dayFlagsEditable("2026-10-17", "2026-10-18")).toBe(true);
    expect(dayFlagsEditable("2026-10-19", "2026-10-18")).toBe(false);
  });

  /** A loader whose reads are answered by hand, in any order. */
  function harness() {
    const states: DayFlagsLoadState[] = [];
    const reads: { opts: { userId: string; from: string }; resolve: (r: { present: boolean; rows: SavedDayFlags[] }) => void; reject: (e: unknown) => void }[] = [];
    const loader = createDayFlagsLoader({
      probe: async () => true,
      read: (opts) => new Promise((resolve, reject) => { reads.push({ opts, resolve, reject }); }),
      onState: (s) => states.push(s),
      onError: () => "Couldn't load the day's ticks.",
    });
    const last = () => states.at(-1)!;
    return { loader, reads, states, last };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("an answer for the previous day that arrives after the next day's load is dropped", async () => {
    const h = harness();
    const first = h.loader.load("u", "2026-10-19");
    await flush();
    const second = h.loader.load("u", "2026-10-20");
    await flush();
    expect(h.reads.map((r) => r.opts.from)).toEqual(["2026-10-19", "2026-10-20"]);
    // The newer day answers first (nothing saved), then the older one (Saturday ticked) arrives late.
    h.reads[1].resolve({ present: true, rows: [] });
    await second;
    h.reads[0].resolve({ present: true, rows: [{ ...saved("2026-10-19", { overtime: true }) }] });
    await first;
    expect(h.last()).toEqual({ present: true, saved: null, loaded: true, error: null });
    expect(h.states.some((s) => s.saved?.day === "2026-10-19")).toBe(false);
  });

  it("the same when the person changes; a late failure for the old one is dropped too", async () => {
    const h = harness();
    const first = h.loader.load("u", "2026-10-19");
    await flush();
    const second = h.loader.load("v", "2026-10-19");
    await flush();
    h.reads[0].reject(new Error("timeout"));
    await first;
    expect(h.last()).toEqual(DAY_FLAGS_LOADING);
    h.reads[1].resolve({ present: true, rows: [{ ...saved("2026-10-19", { sunday: true }), user_id: "v" }] });
    await second;
    expect(h.last()).toMatchObject({ loaded: true, saved: { user_id: "v", sunday: true } });
  });

  it("every load starts from nothing, so a failure never leaves the previous day's ticks showing", async () => {
    const h = harness();
    const first = h.loader.load("u", "2026-10-19");
    await flush();
    h.reads[0].resolve({ present: true, rows: [saved("2026-10-19", { overtime: true })] });
    await first;
    expect(h.last().saved).toMatchObject({ overtime: true });
    const second = h.loader.load("u", "2026-10-20");
    expect(h.last()).toEqual(DAY_FLAGS_LOADING);
    await flush();
    h.reads[1].reject(new Error("boom"));
    await second;
    expect(h.last()).toEqual({ present: true, saved: null, loaded: false, error: "Couldn't load the day's ticks." });
  });

  it("a save's answer is kept only while no newer load has started", async () => {
    const h = harness();
    void h.loader.load("u", "2026-10-19");
    const token = h.loader.token();
    expect(h.loader.isCurrent(token)).toBe(true);
    void h.loader.load("u", "2026-10-20");
    expect(h.loader.isCurrent(token)).toBe(false);
  });

  it("before 074 the loader reports not present and reads nothing", async () => {
    const states: DayFlagsLoadState[] = [];
    let reads = 0;
    const loader = createDayFlagsLoader({ probe: async () => false, read: async () => { reads += 1; return { present: true, rows: [] }; }, onState: (s) => states.push(s), onError: () => "x" });
    await loader.load("u", "2026-10-19");
    expect(states.at(-1)).toEqual({ ...DAY_FLAGS_LOADING, present: false });
    expect(reads).toBe(0);
  });
});

// ----- before 074 is applied ------------------------------------------------------------------------------------------------------------
const MISSING_TABLE = { code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.time_day_flags' in the schema cache" };

/** A PostgREST stand-in without 074: time_day_flags is missing (404 + JSON body on GET, no body on HEAD); everything else is empty. */
function clientWithout074(methods: string[], paths: string[] = []) {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    methods.push(method);
    paths.push(url.pathname);
    if (url.pathname.endsWith("/time_day_flags")) {
      return method === "HEAD" ? new Response(null, { status: 404 }) : new Response(JSON.stringify(MISSING_TABLE), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/time_settings")) return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  return createClient("http://localhost:54321", "anon-key", { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
}

describe("before 074 is applied", () => {
  it("the probe is a GET and reads the missing table as not there (a head-only count would read it as present)", async () => {
    const methods: string[] = [];
    const client = clientWithout074(methods);
    expect(await databaseHasDayFlags(client)).toBe(false);
    expect(methods).toEqual(["GET"]);
    // Why not HEAD: the same stand-in answers a head-only count with no error.
    const head = await client.from("time_day_flags").select("day", { count: "exact", head: true }).limit(1);
    expect(head.error).toBeNull();
  });

  it("no probe or read in lib/time-day-flags.ts is head-only", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/time-day-flags.ts"), "utf8");
    expect(source).not.toMatch(/head:\s*true/);
  });

  it("'not yet' is cached for a minute, then asked again; 'present' is kept; no answer (offline) is not cached", async () => {
    let calls = 0;
    let answer: { error: { code: string; message: string } | null } | "throw" = { error: MISSING_TABLE };
    const probe = { from: () => ({ select: () => ({ limit: async () => { calls += 1; if (answer === "throw") throw new TypeError("Failed to fetch"); return answer; } }) }) };
    expect(await databaseHasDayFlags(probe, 0)).toBe(false);
    expect(await databaseHasDayFlags(probe, 30_000)).toBe(false);
    expect(calls).toBe(1);
    answer = "throw";
    expect(await databaseHasDayFlags(probe, 61_000)).toBeNull();
    answer = { error: null };
    expect(await databaseHasDayFlags(probe, 62_000)).toBe(true);
    expect(await databaseHasDayFlags(probe, 999_000)).toBe(true);
    expect(calls).toBe(3);
    expect(await databaseHasDayFlags(null, 0)).toBe(true);
  });

  it("reading the ticks gives none (present false), never an error; a real failure is still an error", async () => {
    const methods: string[] = [];
    expect(await loadDayFlags(clientWithout074(methods), { userId: "u", from: "2026-10-19", to: "2026-10-25" })).toEqual({ present: false, rows: [] });
    expect(methods).toEqual(["GET"]);
    const failing = { from: () => { const chain = { select: () => chain, gte: () => chain, lte: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: null, error: { code: "42501", message: "permission denied for table time_day_flags" } }) }; return chain; } };
    const err = await loadDayFlags(failing as never, { userId: null, from: "2026-10-19", to: "2026-10-25" }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeDataError);
  });

  it("the weekly review loads as before: no day ticks, no error", async () => {
    const methods: string[] = [];
    const paths: string[] = [];
    const loaded = await loadWeek(clientWithout074(methods, paths), "2026-10-19", null, LATER);
    expect(loaded.dayFlagsPresent).toBe(false);
    expect(loaded.people.every((p) => p.dayFlags === null)).toBe(true);
    // The revision (status) is read first, then the records and the ticks.
    expect(paths[0]).toMatch(/\/rpc\/time_week_status$/);
    expect(paths.some((p) => p.endsWith("/time_day_flags"))).toBe(true);
  });

  it("saving passes the key and all four ticks to set_time_day_flags", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: { ...NO_FLAGS, overtime: true, user_id: "u", day: "2026-10-19" }, error: null }; } };
    const row = await saveDayFlags(client as never, { clientOpId: "k1", userId: "u", day: "2026-10-19", flags: { ...NO_FLAGS, overtime: true } });
    expect(row).toMatchObject({ overtime: true });
    expect(calls).toEqual([{ fn: "set_time_day_flags", args: { p_client_op_id: "k1", p_user: "u", p_day: "2026-10-19", p_overtime: true, p_saturday: false, p_sunday: false, p_bank_holiday: false } }]);
    const refused = { rpc: async () => ({ data: null, error: { code: "42501", hint: "week_approved", message: "That week has been approved. Ask an admin to change it." } }) };
    await expect(saveDayFlags(refused as never, { clientOpId: "k2", userId: "u", day: "2026-10-19", flags: NO_FLAGS })).rejects.toMatchObject({ hint: "week_approved" });
  });
});
