/** The payroll export (lib/time-payroll-export.ts): one row per person per week, the review's own rounding, approval flagged. */
import { describe, expect, it } from "vitest";

import { type SavedDayFlags, weekDayFlags } from "@/lib/time-day-flags";
import { type AttendanceEvent, DEFAULT_TIME_SETTINGS, hm, localInstant, weekTotals } from "@/lib/time-sheet";
import type { PersonWeek, WeekStatusRow } from "@/lib/time-week";
import { toCsv } from "@/lib/spreadsheet";
import { PAYROLL_COLUMNS, payrollFileBase, payrollRows, payrollWeeks, roundedHours, unapprovedCount } from "@/lib/time-payroll-export";

const NONE = new Map<string, string>();
const LATER = new Date("2027-06-01T00:00:00Z").getTime();
let n = 0;

function at(local: string, seconds = 0) {
  const [date, time] = local.split(" ");
  const r = localInstant(date, time);
  if (r.kind !== "ok") throw new Error(local);
  return new Date(r.at.getTime() + seconds * 1000).toISOString();
}
function ev(user: string, action: AttendanceEvent["action"], local: string, seconds = 0): AttendanceEvent {
  n += 1;
  return { id: `e${n}`, user_id: user, action, at: at(local, seconds), received_at: new Date(2026, 0, 1, 0, 0, n).toISOString() };
}
const overtime = (user: string, day: string): SavedDayFlags => ({ overtime: true, saturday: false, sunday: false, bank_holiday: false, user_id: user, day, updated_by: user, updated_at: "2026-10-30T12:00:00Z" });
function status(user: string, state: WeekStatusRow["state"]): WeekStatusRow {
  return { user_id: user, revision: "r", state, approved_revision: null, approved_at: state === "approved" ? "2026-10-27T09:15:00Z" : null, approved_by: state === "approved" ? "boss" : null, totals: null, note: null };
}
function person(user: string, weekStart: string, events: AttendanceEvent[], opts: { state?: WeekStatusRow["state"]; saved?: SavedDayFlags[] } = {}): PersonWeek {
  const week = weekTotals({ weekStart, events, labour: [], settings: DEFAULT_TIME_SETTINGS, bankHolidays: NONE, now: LATER });
  return { userId: user, status: opts.state ? status(user, opts.state) : null, week, dayFlags: weekDayFlags(week, opts.saved ?? [], NONE) };
}

const NAMES = { u1: "Pat Turner", u2: "Sam Ward", boss: "Rhys Boss" };

describe("payrollWeeks", () => {
  it("starts on the Monday of the chosen day and runs whole weeks, 1 to 5", () => {
    expect(payrollWeeks("2026-10-22", 2)).toEqual({ weekStarts: ["2026-10-19", "2026-10-26"], start: "2026-10-19", end: "2026-11-01" });
    expect(payrollWeeks("2026-10-19", 5).weekStarts).toHaveLength(5);
    expect(payrollWeeks("2026-10-19", 9).weekStarts).toHaveLength(5);
    expect(payrollWeeks("2026-10-19", 0).weekStarts).toHaveLength(1);
    expect(payrollWeeks("2026-10-19", Number.NaN).weekStarts).toHaveLength(1);
  });
  it("names the file with the company and the range", () => {
    expect(payrollFileBase("JNR Engineering", "2026-10-19", "2026-11-01")).toBe("JNR Engineering Payroll Hours 2026-10-19 to 2026-11-01");
    expect(payrollFileBase("  ", "2026-10-19", "2026-10-25")).toBe("Company Payroll Hours 2026-10-19 to 2026-10-25");
  });
});

describe("payrollRows", () => {
  // Pat, week of 19 Oct: Tue 07:00-16:30 (9.5 h clocked, 45 min unpaid breaks, 8.75 h paid; Overtime saved) and Wed 07:00-12:00 (5 h, no break allowance).
  const patWk1 = person("u1", "2026-10-19", [ev("u1", "in", "2026-10-20 07:00"), ev("u1", "out", "2026-10-20 16:30"), ev("u1", "in", "2026-10-21 07:00"), ev("u1", "out", "2026-10-21 12:00")], { state: "approved", saved: [overtime("u1", "2026-10-20")] });
  const patWk2 = person("u1", "2026-10-26", [ev("u1", "in", "2026-10-26 08:00"), ev("u1", "out", "2026-10-26 12:00")], { state: "changed_since_approval" });
  const samWk1 = person("u2", "2026-10-19", [ev("u2", "in", "2026-10-22 07:00"), ev("u2", "out", "2026-10-22 15:00")]);
  const emptyWk2 = person("u2", "2026-10-26", []);
  const weeks = [{ weekStart: "2026-10-19", people: [samWk1, patWk1] }, { weekStart: "2026-10-26", people: [patWk2, emptyWk2] }];
  const rows = payrollRows(weeks, NAMES);

  it("has one row per person per week, people in name order then weeks in date order, and leaves out a week with nothing", () => {
    expect(rows.map((r) => `${r.person} ${r.weekStart}`)).toEqual(["Pat Turner 2026-10-19", "Pat Turner 2026-10-26", "Sam Ward 2026-10-19"]);
    expect(rows[0].weekEnd).toBe("2026-10-25");
  });

  it("writes the columns, the week summed across days, with overtime as the saved ticked days only", () => {
    const lines = toCsv(PAYROLL_COLUMNS, rows).slice(1).split("\r\n");
    expect(lines[0]).toBe("Person,Week Starting,Week Ending,Days Worked,Clocked (hours),Breaks Deducted (hours),Paid (hours),Paid (h:mm),Overtime Days,Overtime Paid (hours),Saturday Days,Saturday Paid (hours),Sunday Days,Sunday Paid (hours),Bank holiday Days,Bank holiday Paid (hours),Unsaved Suggested Tick Days,Approval,Approved By,Approved On,Checks");
    // 14.5 h clocked, 0.75 h breaks, 13.75 h paid; Overtime on the Tuesday (8.75 h); approved by Rhys Boss on 27 Oct.
    expect(lines[1]).toBe("Pat Turner,2026-10-19,2026-10-25,2,14.5,0.75,13.75,13:45,1,8.75,0,0,0,0,0,0,0,Approved,Rhys Boss,2026-10-27,");
    expect(lines[2].startsWith("Pat Turner,2026-10-26,2026-11-01,1,4,0,4,4:00,0,0,0,0,0,0,0,0,0,Changed since approval,,,")).toBe(true);
    expect(lines[3]).toBe("Sam Ward,2026-10-19,2026-10-25,1,8,0.75,7.25,7:15,0,0,0,0,0,0,0,0,0,Not approved,,,");
  });

  it("flags what is not approved (not approved, and changed since approval)", () => {
    expect(rows.map((r) => [r.approval, r.approved])).toEqual([["Approved", true], ["Changed since approval", false], ["Not approved", false]]);
    expect(unapprovedCount(rows)).toBe(2);
  });

  it("counts a suggested (unsaved) tick as a suggestion, never as overtime", () => {
    const sunday = person("u1", "2026-10-19", [ev("u1", "in", "2026-10-25 08:00"), ev("u1", "out", "2026-10-25 12:00")]);
    const [row] = payrollRows([{ weekStart: "2026-10-19", people: [sunday] }], NAMES);
    expect(row.suggestedDays).toBe(1);
    expect(row.ticks.sunday).toEqual({ days: 0, paidMinutes: 0 });
  });

  it("names an unknown person without losing the row", () => {
    expect(payrollRows([{ weekStart: "2026-10-19", people: [samWk1] }], {}, "—")[0].person).toBe("—");
  });

  it("quotes a name that starts with a formula character in the CSV", () => {
    const [row] = payrollRows([{ weekStart: "2026-10-19", people: [samWk1] }], { u2: "=HYPERLINK(\"x\")" });
    const line = toCsv(PAYROLL_COLUMNS, [row]).slice(1).split("\r\n")[1];
    expect(line.startsWith(`"'=HYPERLINK(""x"")",`)).toBe(true);
    for (const name of ["+1", "-1 Smith", "@home", "Ann, Bo"]) {
      const l = toCsv(PAYROLL_COLUMNS, payrollRows([{ weekStart: "2026-10-19", people: [samWk1] }], { u2: name })).slice(1).split("\r\n")[1];
      expect(l.startsWith(name.includes(",") ? `"${name}",` : `'${name},`)).toBe(true);
    }
  });
});

describe("rounding: once, to the whole minute, the way the review does", () => {
  // Two days of 8 h 0 min 20 s (5 h days: under the break allowance threshold): exact paid 5 h 0 min 20 s each, week 10 h 0 min 40 s.
  // Rounding each day first would give 10:00; rounding the week once gives 10:01, which is what the screen (hm of the week's paid) shows.
  const w = person("u1", "2026-10-19", [
    ev("u1", "in", "2026-10-20 07:00"), ev("u1", "out", "2026-10-20 12:00", 20),
    ev("u1", "in", "2026-10-21 07:00"), ev("u1", "out", "2026-10-21 12:00", 20),
  ]);
  it("Paid equals the review's hm() of the exact week sum, as hours and as h:mm", () => {
    const [row] = payrollRows([{ weekStart: "2026-10-19", people: [w] }], NAMES);
    expect(w.week.paid).toBeCloseTo(10 * 60 + 40 / 60, 6);
    expect(hm(w.week.paid)).toBe("10:01");
    expect(roundedHours(row.paidMinutes)).toBe(10.02); // 601 min / 60 = 10.0166...
    const line = toCsv(PAYROLL_COLUMNS, [row]).slice(1).split("\r\n")[1].split(",");
    expect(line[6]).toBe("10.02");
    expect(line[7]).toBe(hm(w.week.paid));
  });
  it("goes to the whole minute first, then to hours (never straight from fractional minutes), and never below 0", () => {
    expect(roundedHours(0)).toBe(0);
    expect(roundedHours(-5)).toBe(0);
    expect(roundedHours(29.5)).toBe(0.5); // 30 min
    expect(roundedHours(29.4)).toBe(0.48); // 29 min = 0.4833 h
  });
});
