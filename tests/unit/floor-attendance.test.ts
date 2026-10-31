/**
 * The Whole floor's Clocked in count against Weekly hours' "Clocked in since" (lib/floor-attendance, lib/time-sheet clockStateOf).
 *
 * The two are ONE rule: for every person, in every case below, "the Whole floor counts them" is exactly "Weekly hours' day sheet says
 * Clocked in since ..." (and "on a break" the same way), worked out from the same clock records. Cases: clock in, break start, break end,
 * clock out, a clock-in and a clock-out on either side of midnight (UK time, BST and the night the clocks go back and forward), a session
 * left open too long, a stray break end, a corrected clock-in, a voided clock-in, a double clock-in. A naive "latest action" count would get
 * four of these wrong (asserted below, so the difference stays on record).
 * Also: the clock records are read over the very same window Weekly hours reads (checked against loadTimeData's own query), the count is for
 * admin and office only (the row rules), and a read that failed or filled its limit is a dash, never 0.
 */
import { describe, expect, it } from "vitest";

import { CLOCK_ROW_LIMIT, attendanceReadable, clockReadWindow, clockedInNow, loadClockedIn } from "@/lib/floor-attendance";
import { loadTimeData } from "@/lib/time-data";
import { DEFAULT_TIME_SETTINGS, clockStateOf, dayTotals, localDateOf, localDayBounds, pairAttendance, type AttendanceEvent, type ClockAction, type TimeSettings } from "@/lib/time-sheet";

let seq = 0;
function ev(user: string, action: ClockAction | "void", at: string, extra: Partial<AttendanceEvent> = {}): AttendanceEvent {
  seq += 1;
  return { id: extra.id ?? `e${seq}`, user_id: user, action, at, source: "clock", received_at: at, ...extra };
}

/** What Weekly hours' day sheet says for this person today (the components/time/day-sheet.tsx path: loadTimeData's window, dayTotals, clockStateOf). */
function weeklyHours(events: AttendanceEvent[], user: string, now: Date, settings: TimeSettings = DEFAULT_TIME_SETTINGS) {
  const { lo, hi } = clockReadWindow(now);
  const mine = events.filter((e) => e.user_id === user && e.at >= lo && e.at < hi);
  const day = dayTotals({ date: localDateOf(now), events: mine, labour: [], settings, bankHolidays: new Map(), now: now.getTime() });
  const { clockedIn, onBreak } = clockStateOf(day.sessions);
  return { clockedIn, onBreak };
}

/** What the Whole floor counts, from the same records (only those in the window, as the read returns). */
function floorCount(events: AttendanceEvent[], now: Date, settings: TimeSettings = DEFAULT_TIME_SETTINGS) {
  const { lo, hi } = clockReadWindow(now);
  return clockedInNow(events.filter((e) => e.at >= lo && e.at < hi), settings, now);
}

/** The naive rule (the latest action decides), kept to show where it differs. */
function naive(events: AttendanceEvent[], now: Date) {
  const { lo, hi } = clockReadWindow(now);
  const latest = new Map<string, AttendanceEvent>();
  for (const e of events.filter((x) => x.at >= lo && x.at < hi && x.action !== "void").sort((a, b) => a.at.localeCompare(b.at))) latest.set(e.user_id, e);
  return [...latest.values()].filter((e) => e.action === "in" || e.action === "break_start" || e.action === "break_end").length;
}

function expectAgreement(events: AttendanceEvent[], now: Date, settings: TimeSettings = DEFAULT_TIME_SETTINGS) {
  const people = [...new Set(events.map((e) => e.user_id))];
  const perPerson = people.map((p) => [p, weeklyHours(events, p, now, settings)] as const);
  const wantIn = perPerson.filter(([, s]) => s.clockedIn).length;
  const wantBreak = perPerson.filter(([, s]) => s.onBreak).length;
  expect(floorCount(events, now, settings)).toEqual({ clockedIn: wantIn, onBreak: wantBreak });
  return Object.fromEntries(perPerson);
}

// A BST morning: Thu 29 Oct 2026, 08:30 UK = 07:30Z.
const NOW = new Date("2026-10-29T07:30:00Z");

describe("the Whole floor count and Weekly hours agree on the same clock records", () => {
  const events = [
    // u1: clocked in at 08:00 UK, nothing since.
    ev("u1", "in", "2026-10-29T07:00:00Z"),
    // u2: in, then Break start: clocked in, on a break.
    ev("u2", "in", "2026-10-29T06:00:00Z"), ev("u2", "break_start", "2026-10-29T07:15:00Z"),
    // u3: in, Break start, Break end: clocked in, not on a break.
    ev("u3", "in", "2026-10-29T06:00:00Z"), ev("u3", "break_start", "2026-10-29T06:45:00Z"), ev("u3", "break_end", "2026-10-29T07:00:00Z"),
    // u4: in then out: not clocked in.
    ev("u4", "in", "2026-10-29T05:00:00Z"), ev("u4", "out", "2026-10-29T06:30:00Z"),
    // u5: clocked in at 22:00 UK last night, still in at 08:30 UK (10.5 h, across midnight).
    ev("u5", "in", "2026-10-28T21:00:00Z"),
    // u6: in 24.5 hours ago and never out: older than long_session_hours (14), so not clocked in (the day sheet flags it long).
    ev("u6", "in", "2026-10-28T07:00:00Z"),
    // u7: in, out, then a stray Break end: not clocked in (a break with nothing open is ignored).
    ev("u7", "in", "2026-10-29T05:00:00Z"), ev("u7", "out", "2026-10-29T06:00:00Z"), ev("u7", "break_end", "2026-10-29T06:10:00Z"),
    // u8: the clock-in was corrected to a later time: clocked in from the corrected time.
    ev("u8", "in", "2026-10-29T05:00:00Z", { id: "u8-in" }), ev("u8", "in", "2026-10-29T06:00:00Z", { source: "correction", supersedes: "u8-in", reason: "Forgot to clock in" }),
    // u9: the only clock-in was voided: not clocked in.
    ev("u9", "in", "2026-10-29T06:00:00Z", { id: "u9-in" }), ev("u9", "void", "2026-10-29T06:00:00Z", { source: "correction", supersedes: "u9-in", reason: "Clocked in by mistake" }),
    // u10: in twice (the first is left without an out): clocked in on the second.
    ev("u10", "in", "2026-10-29T05:00:00Z"), ev("u10", "in", "2026-10-29T06:00:00Z"),
    // u11: in, out, in again: clocked in.
    ev("u11", "in", "2026-10-29T04:00:00Z"), ev("u11", "out", "2026-10-29T05:00:00Z"), ev("u11", "in", "2026-10-29T06:00:00Z"),
    // u12: a break start with no clock-in at all: not clocked in.
    ev("u12", "break_start", "2026-10-29T06:00:00Z"),
  ];

  it("every case: the count is exactly the number of people Weekly hours says are Clocked in, and the same for on a break", () => {
    const people = expectAgreement(events, NOW);
    expect(people).toEqual({
      u1: { clockedIn: true, onBreak: false },
      u2: { clockedIn: true, onBreak: true },
      u3: { clockedIn: true, onBreak: false },
      u4: { clockedIn: false, onBreak: false },
      u5: { clockedIn: true, onBreak: false },
      u6: { clockedIn: false, onBreak: false },
      u7: { clockedIn: false, onBreak: false },
      u8: { clockedIn: true, onBreak: false },
      u9: { clockedIn: false, onBreak: false },
      u10: { clockedIn: true, onBreak: false },
      u11: { clockedIn: true, onBreak: false },
      u12: { clockedIn: false, onBreak: false },
    });
    expect(floorCount(events, NOW)).toEqual({ clockedIn: 7, onBreak: 1 });
  });

  it("a person on a break is counted once as clocked in and once as on a break; a break end puts them back", () => {
    expect(floorCount(events.filter((e) => e.user_id === "u2"), NOW)).toEqual({ clockedIn: 1, onBreak: 1 });
    expect(floorCount(events.filter((e) => e.user_id === "u3"), NOW)).toEqual({ clockedIn: 1, onBreak: 0 });
  });

  it("clock out takes a person out of the count; each step changes the count the same way Weekly hours changes", () => {
    const steps: AttendanceEvent[] = [];
    const counts: number[] = [];
    for (const step of [ev("a", "in", "2026-10-29T06:00:00Z"), ev("a", "break_start", "2026-10-29T06:30:00Z"), ev("a", "break_end", "2026-10-29T06:45:00Z"), ev("a", "out", "2026-10-29T07:00:00Z")]) {
      steps.push(step);
      expectAgreement(steps, NOW);
      counts.push(floorCount(steps, NOW).clockedIn);
    }
    expect(counts).toEqual([1, 1, 1, 0]);
  });

  it("a naive 'latest action' count differs from Weekly hours in exactly the cases the shared rule exists for (u6, u7, u9, u12)", () => {
    // Latest action in / break_start / break_end also counts u6 (in, never out, 24 h ago), u7 (stray break end), u9 (the clock-in was voided)
    // and u12 (break start with no clock-in): four more than Weekly hours, which is why the count reuses Weekly hours' rule.
    expect(naive(events, NOW)).toBe(11);
    expect(floorCount(events, NOW).clockedIn).toBe(7);
  });

  it("the company's long_session_hours decides how long an open session stays clocked in, on both sides", () => {
    const e = [ev("a", "in", "2026-10-28T22:30:00Z")]; // 9 hours before NOW (07:30Z)
    expect(expectAgreement(e, NOW, { ...DEFAULT_TIME_SETTINGS, longSessionHours: 14 }).a.clockedIn).toBe(true);
    expect(expectAgreement(e, NOW, { ...DEFAULT_TIME_SETTINGS, longSessionHours: 8 }).a.clockedIn).toBe(false);
  });
});

describe("overnight, in UK time", () => {
  it("in at 23:50 UK and still in at 00:10 UK the next day (BST): clocked in on both", () => {
    const now = new Date("2026-10-23T23:10:00Z"); // 00:10 BST on Sat 24 Oct
    expect(localDateOf(now)).toBe("2026-10-24");
    const e = [ev("n", "in", "2026-10-23T22:50:00Z")]; // 23:50 BST on Fri 23 Oct
    expect(expectAgreement(e, now).n).toEqual({ clockedIn: true, onBreak: false });
    expect(floorCount(e, now)).toEqual({ clockedIn: 1, onBreak: 0 });
  });

  it("the night the clocks go back (Sat 24 to Sun 25 Oct 2026): in at 22:00 BST, at 05:30 GMT that is 8.5 hours, still clocked in", () => {
    const now = new Date("2026-10-25T05:30:00Z");
    expect(localDateOf(now)).toBe("2026-10-25");
    const e = [ev("n", "in", "2026-10-24T21:00:00Z")];
    expect(expectAgreement(e, now).n.clockedIn).toBe(true);
    // The same person who clocked out at 02:30 GMT is not.
    const out = [...e, ev("n", "out", "2026-10-25T02:30:00Z")];
    expect(expectAgreement(out, now).n.clockedIn).toBe(false);
  });

  it("the night the clocks go forward (Sat 27 to Sun 28 Mar 2027): in at 22:30 GMT, at 02:30 BST that is 3 hours, still clocked in", () => {
    const now = new Date("2027-03-28T01:30:00Z"); // 02:30 BST
    expect(localDateOf(now)).toBe("2027-03-28");
    const e = [ev("n", "in", "2027-03-27T22:30:00Z")];
    expect(expectAgreement(e, now).n.clockedIn).toBe(true);
  });

  it("a clock-in just before midnight UK belongs to the day it was made but counts as clocked in after midnight", () => {
    const now = new Date("2026-07-01T23:20:00Z"); // 00:20 BST on Thu 2 Jul
    const e = [ev("n", "in", "2026-07-01T22:55:00Z")]; // 23:55 BST on Wed 1 Jul
    expect(expectAgreement(e, now).n.clockedIn).toBe(true);
  });
});

describe("the same window of clock records as Weekly hours reads", () => {
  /** A stand-in client that records every query and answers with nothing. */
  function recorder() {
    const queries: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
    const client = {
      from(table: string) {
        const query = { table, ops: [] as Array<[string, unknown[]]> };
        queries.push(query);
        const chain: unknown = new Proxy({}, {
          get(_target, prop) {
            if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
            return (...args: unknown[]) => { query.ops.push([String(prop), args]); return chain; };
          },
        });
        return chain;
      },
    };
    return { client, queries };
  }

  it("the floor reads attendance_events over exactly the window loadTimeData reads for today, and no more", async () => {
    for (const now of [NOW, new Date("2026-10-25T05:30:00Z"), new Date("2027-03-28T01:30:00Z")]) {
      const bounds = localDayBounds(localDateOf(now));
      const weekly = recorder();
      await loadTimeData(weekly.client as never, { userId: "me", from: bounds.start, to: bounds.end });
      const wq = weekly.queries.find((q) => q.table === "attendance_events")!;
      const floor = recorder();
      await loadClockedIn(floor.client as never, now);
      const fq = floor.queries.find((q) => q.table === "attendance_events")!;
      const bound = (q: typeof wq, op: string) => q.ops.find(([name]) => name === op)![1];
      expect(bound(fq, "gte")).toEqual(bound(wq, "gte"));
      expect(bound(fq, "lt")).toEqual(bound(wq, "lt"));
      expect(bound(wq, "gte")).toEqual(["at", clockReadWindow(now).lo]);
      expect(bound(wq, "lt")).toEqual(["at", clockReadWindow(now).hi]);
      // The floor asks for everyone (no per-person filter) and for the company's own settings, as Weekly hours does.
      expect(fq.ops.map(([name]) => name)).not.toContain("eq");
      expect(floor.queries.map((q) => q.table).sort()).toEqual(["attendance_events", "time_settings"]);
    }
  });

  it("pairs the very events loadTimeData would return: the same sessions as pairAttendance", () => {
    const e = [ev("a", "in", "2026-10-29T06:00:00Z"), ev("a", "break_start", "2026-10-29T07:00:00Z")];
    const sessions = pairAttendance(e, DEFAULT_TIME_SETTINGS, NOW.getTime()).sessions;
    expect(clockStateOf(sessions)).toMatchObject({ clockedIn: true, onBreak: true });
    expect(clockedInNow(e, DEFAULT_TIME_SETTINGS, NOW)).toEqual({ clockedIn: 1, onBreak: 1 });
  });
});

describe("who sees the count, and fail closed", () => {
  it("only admin and office can read everyone's clock records (migration 050), so only they are shown the count", () => {
    expect(attendanceReadable("admin")).toBe(true);
    expect(attendanceReadable("office")).toBe(true);
    for (const role of ["workshop", "viewer", null, undefined, ""]) expect(attendanceReadable(role)).toBe(false);
  });

  function stub(events: { data: unknown; error: unknown }, settings: { data: unknown; error: unknown } = { data: null, error: null }) {
    const answer = (result: unknown) => new Proxy({}, { get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => unknown) => resolve(result) : () => answer(result)) });
    return { from: (table: string) => answer(table === "attendance_events" ? events : settings) } as never;
  }

  it("counts what it read", async () => {
    const rows = [ev("a", "in", "2026-10-29T06:00:00Z"), ev("b", "in", "2026-10-29T06:00:00Z"), ev("b", "break_start", "2026-10-29T07:00:00Z")];
    expect(await loadClockedIn(stub({ data: rows, error: null }), NOW)).toEqual({ clockedIn: 2, onBreak: 1 });
  });

  it("a failed read of the records or of the settings is null (a dash), never 0", async () => {
    expect(await loadClockedIn(stub({ data: null, error: { message: "boom" } }), NOW)).toBeNull();
    expect(await loadClockedIn(stub({ data: [], error: null }, { data: null, error: { message: "boom" } }), NOW)).toBeNull();
    const throwing = { from: () => { throw new Error("offline"); } } as never;
    expect(await loadClockedIn(throwing, NOW)).toBeNull();
  });

  it("a read that filled its row limit may be missing records, so it is not trusted", async () => {
    const full = Array.from({ length: CLOCK_ROW_LIMIT }, (_, i) => ev(`p${i}`, "in", "2026-10-29T06:00:00Z"));
    expect(await loadClockedIn(stub({ data: full, error: null }), NOW)).toBeNull();
    expect(await loadClockedIn(stub({ data: full.slice(1), error: null }), NOW)).toMatchObject({ clockedIn: CLOCK_ROW_LIMIT - 1 });
  });

  it("no one clocked in is a real 0 (the read worked)", async () => {
    expect(await loadClockedIn(stub({ data: [], error: null }), NOW)).toEqual({ clockedIn: 0, onBreak: 0 });
  });
});
