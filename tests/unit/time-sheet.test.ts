/**
 * The daily job sheet arithmetic (lib/time-sheet.ts): pairing clock actions in any arrival order, local days and the clock changes,
 * break deductions, overtime (The JNR controller's rules), labour union and the equal split, and the plan's acceptance figures
 * (docs/plans/time-and-pay.md section 8).
 */
import { describe, expect, it } from "vitest";

import {
  type AttendanceEvent, type LabourSession, DEFAULT_TIME_SETTINGS, addDays, allocate, dayTotals, effectiveEvents, hm, localDateOf, localDayBounds,
  approvalSnapshot, localInstant, localTimeOf, pairAttendance, settingsFromRow, weekStartOf, weekTotals, zoneLabel,
} from "@/lib/time-sheet";

const S = DEFAULT_TIME_SETTINGS;
const NONE = new Map<string, string>();
let n = 0;
/** A clock action at a local wall time ("2026-10-19 08:00", BST/GMT picked by the date unless given). */
function ev(action: AttendanceEvent["action"], local: string, extra: Partial<AttendanceEvent> = {}): AttendanceEvent {
  n += 1;
  return { id: `e${n}`, user_id: "u", action, at: at(local), received_at: new Date(2026, 0, 1, 0, 0, n).toISOString(), ...extra };
}
function at(local: string, zone?: "BST" | "GMT") {
  const [date, time] = local.split(" ");
  const r = localInstant(date, time, zone);
  if (r.kind !== "ok") throw new Error(`${local}: ${r.kind}`);
  return r.at.toISOString();
}
function lab(job: string, from: string, to: string | null, extra: Partial<LabourSession> = {}): LabourSession {
  n += 1;
  return { id: `l${n}`, user_id: "u", job_id: job, started_at: at(from), ended_at: to ? at(to) : null, ...extra };
}
const LATER = new Date("2027-06-01T00:00:00Z").getTime();
const day = (date: string, events: AttendanceEvent[], labour: LabourSession[] = [], settings = S, holidays = NONE, now = LATER) =>
  dayTotals({ date, events, labour, settings, bankHolidays: holidays, now });

describe("local dates (Europe/London)", () => {
  it("knows BST and GMT, and the length of the clock-change days", () => {
    expect(zoneLabel("2026-10-24T12:00:00Z")).toBe("BST");
    expect(zoneLabel("2026-10-26T12:00:00Z")).toBe("GMT");
    const back = localDayBounds("2026-10-25");
    expect((back.end.getTime() - back.start.getTime()) / 3_600_000).toBe(25);
    const fwd = localDayBounds("2027-03-28");
    expect((fwd.end.getTime() - fwd.start.getTime()) / 3_600_000).toBe(23);
    expect(localDateOf("2026-10-18T23:30:00Z")).toBe("2026-10-19"); // 00:30 BST on Monday
    expect(localTimeOf("2026-10-18T23:30:00Z")).toBe("00:30");
  });

  it("01:30 on 25 Oct 2026 happens twice (BST then GMT); 01:30 on 28 Mar 2027 doesn't exist", () => {
    const r = localInstant("2026-10-25", "01:30");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect([r.bst.toISOString(), r.gmt.toISOString()]).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
    expect(localInstant("2027-03-28", "01:30").kind).toBe("missing");
    expect(localInstant("2026-10-25", "01:30", "GMT")).toEqual({ kind: "ok", at: new Date("2026-10-25T01:30:00.000Z") });
    expect(localInstant("2026-13-01", "08:00").kind).toBe("invalid");
    expect(localInstant("2026-10-19", "25:00").kind).toBe("invalid");
  });

  it("weeks start on Monday", () => {
    expect(weekStartOf("2026-10-25")).toBe("2026-10-19");
    expect(weekStartOf("2026-10-19")).toBe("2026-10-19");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("pairing clock actions", () => {
  it("pairs by time whatever order they arrived in (two devices, the clock-out first)", () => {
    const out = ev("out", "2026-10-19 16:30", { received_at: "2026-10-19T15:31:00Z" });
    const inn = ev("in", "2026-10-19 07:55", { received_at: "2026-10-19T15:40:00Z" });
    const a = pairAttendance([out, inn], S, LATER);
    const b = pairAttendance([inn, out], S, LATER);
    expect(a.sessions).toEqual(b.sessions);
    expect(a.sessions).toHaveLength(1);
    expect(a.sessions[0].flags).toEqual([]);
    expect(hm(day("2026-10-19", [out, inn]).attendance)).toBe("8:35");
  });

  it("a duplicate delivery (same id twice) counts once", () => {
    const inn = ev("in", "2026-10-19 08:00");
    const out = ev("out", "2026-10-19 12:00");
    expect(day("2026-10-19", [inn, out, { ...inn }, { ...out }]).attendance).toBe(240);
  });

  it("never guesses: In after In leaves the first without an end; Out with nothing open is flagged", () => {
    const d = day("2026-10-19", [ev("in", "2026-10-19 08:00"), ev("in", "2026-10-19 09:00"), ev("out", "2026-10-19 12:00"), ev("out", "2026-10-19 13:00")]);
    expect(d.attendance).toBe(180);
    expect(d.flags.sort()).toEqual(["missing_in", "missing_out"]);
  });

  it("corrections: a replaced action and a voided one stop counting; the replacement counts", () => {
    const inn = ev("in", "2026-10-19 09:00");
    const fix = ev("in", "2026-10-19 08:00", { source: "correction", supersedes: inn.id });
    const stray = ev("out", "2026-10-19 10:00");
    const voided = ev("void", "2026-10-19 10:00", { source: "correction", supersedes: stray.id });
    const out = ev("out", "2026-10-19 16:00");
    expect(effectiveEvents([inn, fix, stray, voided, out]).map((e) => e.id)).toEqual([fix.id, out.id]);
    expect(day("2026-10-19", [inn, fix, stray, voided, out]).attendance).toBe(480);
  });

  it("the open session counts to now; past the long-session limit it is flagged and not counted", () => {
    const inn = ev("in", "2026-10-19 08:00");
    const now = new Date(at("2026-10-19 10:30")).getTime();
    const live = day("2026-10-19", [inn], [], S, NONE, now);
    expect(live.attendance).toBe(150);
    expect(live.flags).toEqual([]);
    const stale = day("2026-10-19", [inn], [], S, NONE, new Date(at("2026-10-20 08:00")).getTime());
    expect(stale.attendance).toBe(0);
    expect(stale.flags.sort()).toEqual(["long", "missing_out"]);
  });
});

describe("The JNR controller's rules: breaks, and no computed overtime", () => {
  const shift = (date: string, from: string, to: string) => [ev("in", `${date} ${from}`), ev("out", `${date} ${to}`)];

  it("a full weekday: 07:30 to 17:00 = 9:30, minus 45 minutes of breaks = 8:45 paid (nothing is split into basic and overtime)", () => {
    const d = day("2026-10-19", shift("2026-10-19", "07:30", "17:00"));
    expect([hm(d.attendance), d.breakRule, hm(d.breakDeduction), hm(d.paid)]).toEqual(["9:30", "allowance", "0:45", "8:45"]);
    expect("basic" in d).toBe(false);
    expect("overtime" in d).toBe(false);
  });

  it("a short day (under 6 hours) has nothing deducted", () => {
    const d = day("2026-10-20", shift("2026-10-20", "08:00", "13:00"));
    expect([d.breakRule, d.breakDeduction, hm(d.paid)]).toEqual(["none", 0, "5:00"]);
  });

  it("on a full day the greater of the 45-minute allowance and the clocked breaks is deducted", () => {
    // A clocked 15-minute tea break: the 30 + 15 are still unpaid (The JNR controller's rule).
    const tea = day("2026-10-21", [ev("in", "2026-10-21 08:00"), ev("break_start", "2026-10-21 10:00"), ev("break_end", "2026-10-21 10:15"), ev("out", "2026-10-21 16:00")]);
    expect([tea.breakRule, hm(tea.clockedBreaks), hm(tea.breakDeduction), hm(tea.paid)]).toEqual(["allowance", "0:15", "0:45", "7:15"]);
    // A clocked hour's lunch: the hour is deducted.
    const lunch = day("2026-10-21", [ev("in", "2026-10-21 08:00"), ev("break_start", "2026-10-21 12:00"), ev("break_end", "2026-10-21 13:00"), ev("out", "2026-10-21 16:00")]);
    expect([lunch.breakRule, hm(lunch.breakDeduction), hm(lunch.paid)]).toEqual(["clocked", "1:00", "7:00"]);
    // A short day: only what was clocked.
    const short = day("2026-10-21", [ev("in", "2026-10-21 08:00"), ev("break_start", "2026-10-21 10:00"), ev("break_end", "2026-10-21 10:10"), ev("out", "2026-10-21 12:00")]);
    expect([short.breakRule, hm(short.breakDeduction), hm(short.paid)]).toEqual(["clocked", "0:10", "3:50"]);
    // The threshold is a setting: at 4 hours, a 5-hour day gets the allowance.
    const set = day("2026-10-21", [ev("in", "2026-10-21 08:00"), ev("out", "2026-10-21 13:00")], [], { ...S, breakMinDayHours: 4 });
    expect([set.breakRule, hm(set.breakDeduction)]).toEqual(["allowance", "0:45"]);
  });

  it("breaks paid (a company setting): nothing deducted", () => {
    const d = day("2026-10-19", shift("2026-10-19", "08:00", "16:00"), [], { ...S, breaksPaid: true });
    expect([d.breakRule, d.breakDeduction, hm(d.paid)]).toEqual(["paid", 0, "8:00"]);
  });

  it("Saturday, Sunday and bank holidays are paid as hours worked: no overtime figure, no 'rule to confirm' flag, whatever the settings columns say", () => {
    const satEvents = shift("2026-10-24", "08:00", "12:00");
    const sunEvents = shift("2026-10-18", "08:00", "12:00");
    const sat = day("2026-10-24", satEvents);
    expect([sat.kind, hm(sat.paid), sat.flags]).toEqual(["saturday", "4:00", []]);
    const sun = day("2026-10-18", sunEvents);
    expect([sun.kind, hm(sun.paid), sun.flags]).toEqual(["sunday", "4:00", []]);
    // The old overtime settings are still read (the database has the columns) but change no figure.
    const old = { ...S, sundayOvertime: false, saturdayOvertime: false, bankHolidayOvertime: false, dailyOvertimeHours: 1, overtimeMultiplier: 2 };
    expect(day("2026-10-18", sunEvents, [], old)).toEqual(sun);
    expect(day("2026-10-24", satEvents, [], old)).toEqual(sat);
    const xmas = new Map([["2026-12-28", "Boxing Day (substitute day)"]]);
    const bh = day("2026-12-28", shift("2026-12-28", "08:00", "16:00"), [], S, xmas);
    expect([bh.kind, hm(bh.paid), bh.flags]).toEqual(["bank_holiday", "7:15", []]);
  });

  it("the plan's 17-hour day: 05:00 to 22:00 on a Monday is 17:00, 16:15 paid", () => {
    const d = day("2026-10-19", shift("2026-10-19", "05:00", "22:00"));
    expect([hm(d.attendance), hm(d.paid)]).toEqual(["17:00", "16:15"]);
  });
});

describe("overnight and the clock changes", () => {
  it("Sat 24 Oct 2026 22:00 BST to Sun 25 Oct 06:00 GMT is 9 hours: 2 on Saturday, 7 on Sunday", () => {
    const events = [ev("in", "2026-10-24 22:00"), ev("out", "2026-10-25 06:00")];
    const sat = day("2026-10-24", events, [], { ...S, breakMinDayHours: 24 });
    const sun = day("2026-10-25", events, [], { ...S, breakMinDayHours: 24 });
    expect([hm(sat.attendance), hm(sun.attendance), hm(sat.attendance + sun.attendance)]).toEqual(["2:00", "7:00", "9:00"]);
    expect([hm(sat.paid), hm(sun.paid)]).toEqual(["2:00", "7:00"]);
    const week = weekTotals({ weekStart: "2026-10-19", events, labour: [], settings: { ...S, breakMinDayHours: 24 }, bankHolidays: NONE, now: LATER });
    expect(hm(week.attendance)).toBe("9:00");
    expect(week.daysWorked).toBe(2);
  });

  it("Sat 27 Mar 2027 22:00 GMT to Sun 28 Mar 06:00 BST is 7 hours", () => {
    const events = [ev("in", "2027-03-27 22:00"), ev("out", "2027-03-28 06:00")];
    const total = day("2027-03-27", events).attendance + day("2027-03-28", events).attendance;
    expect(hm(total)).toBe("7:00");
  });

  it("a shift crossing the week boundary splits into both weeks", () => {
    const events = [ev("in", "2026-10-25 20:00"), ev("out", "2026-10-26 04:00")];
    const w1 = weekTotals({ weekStart: "2026-10-19", events, labour: [], settings: S, bankHolidays: NONE, now: LATER });
    const w2 = weekTotals({ weekStart: "2026-10-26", events, labour: [], settings: S, bankHolidays: NONE, now: LATER });
    expect([hm(w1.attendance), hm(w2.attendance)]).toEqual(["4:00", "4:00"]);
  });
});

describe("labour", () => {
  it("one person on two jobs for the same hour: 1 hour of labour, 30 + 30 minutes allocated", () => {
    const d = day("2026-10-19", [ev("in", "2026-10-19 08:00"), ev("out", "2026-10-19 16:00")], [lab("A", "2026-10-19 09:00", "2026-10-19 10:00"), lab("B", "2026-10-19 09:00", "2026-10-19 10:00")]);
    expect(hm(d.labour)).toBe("1:00");
    expect(d.jobs.map((j) => [j.jobId, hm(j.minutes), hm(j.allocatedMinutes)])).toEqual([["A", "1:00", "0:30"], ["B", "1:00", "0:30"]]);
  });

  it("the plan's figure: attendance 09:00 to 17:00, labour 08:00 to 12:00 = 5 h without labour, 1 h of labour outside attendance", () => {
    const d = day("2026-10-19", [ev("in", "2026-10-19 09:00"), ev("out", "2026-10-19 17:00")], [lab("A", "2026-10-19 08:00", "2026-10-19 12:00")]);
    expect([hm(d.attendanceWithoutLabour), hm(d.labourOutsideAttendance), hm(d.labourInAttendance)]).toEqual(["5:00", "1:00", "3:00"]);
    expect(hm(d.unallocated)).toBe("4:15"); // 7:15 paid - 3:00 labour inside attendance
    expect(d.flags).toContain("labour_outside_attendance");
  });

  it("allocated shares always add up to the union", () => {
    const shares = allocate([
      { job: "A", interval: { start: 0, end: 90 } },
      { job: "B", interval: { start: 30, end: 120 } },
      { job: "C", interval: { start: 60, end: 70 } },
    ]);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(120, 9);
  });

  it("voided sessions don't count; an open session runs to now and is flagged when left too long", () => {
    const now = new Date(at("2026-10-19 11:00")).getTime();
    const d = day("2026-10-19", [], [lab("A", "2026-10-19 08:00", null), lab("B", "2026-10-19 08:00", "2026-10-19 09:00", { voided_at: "2026-10-19T09:30:00Z" })], S, NONE, now);
    expect([hm(d.labour), d.jobs.map((j) => j.jobId), d.jobs[0].open]).toEqual(["3:00", ["A"], true]);
    const later = day("2026-10-20", [], [lab("A", "2026-10-19 08:00", null)], S, NONE, new Date(at("2026-10-20 12:00")).getTime());
    expect(later.flags).toContain("labour_long");
  });
});

describe("the weekly summary and what an approval stores", () => {
  it("a Mon-Fri 07:30-16:30 week plus a Saturday morning: 45:15 paid, no computed overtime; the snapshot is whole minutes, no money, and overtime_minutes is only what was ticked", () => {
    const events = ["19", "20", "21", "22", "23"].flatMap((d) => [ev("in", `2026-10-${d} 07:30`), ev("out", `2026-10-${d} 16:30`)]);
    events.push(ev("in", "2026-10-24 08:00"), ev("out", "2026-10-24 12:00"));
    const week = weekTotals({ weekStart: "2026-10-19", events, labour: [], settings: S, bankHolidays: NONE, now: LATER });
    expect([week.daysWorked, hm(week.attendance), hm(week.breakDeduction), hm(week.paid)]).toEqual([6, "49:00", "3:45", "45:15"]);
    // No ticks saved (or no 074): overtime_minutes 0, basic_minutes = paid. Never worked out from the hours or the Saturday.
    const snap = approvalSnapshot(week);
    expect(snap).toMatchObject({ week_start: "2026-10-19", paid_minutes: 2715, basic_minutes: 2715, overtime_minutes: 0, break_deduction_minutes: 225, days_worked: 6 });
    expect("overtime_multiplier" in snap).toBe(false);
    expect(snap.days).toHaveLength(7);
    expect(snap.days[0]).toEqual({ date: "2026-10-19", paid: 495, breaks: 45 });
    // With saved ticks (074): overtime_minutes = the paid minutes on the days ticked Overtime (here Saturday's 240).
    const ticked = approvalSnapshot(week, { overtime: { days: 1, paid_minutes: 240 }, saturday: { days: 1, paid_minutes: 240 } });
    expect([ticked.paid_minutes, ticked.basic_minutes, ticked.overtime_minutes]).toEqual([2715, 2715, 240]);
    expect(JSON.stringify(snap)).not.toMatch(/rate|pay_|£|amount/i);
  });
});

describe("settings", () => {
  it("defaults for a missing row; values from a row", () => {
    expect(settingsFromRow(null)).toEqual(S);
    expect(settingsFromRow({ breaks_paid: true, daily_overtime_hours: "7.5", approver_roles: ["admin", "office"] })).toMatchObject({ breaksPaid: true, dailyOvertimeHours: 7.5, approverRoles: ["admin", "office"], lunchMinutes: 30 });
  });
});
