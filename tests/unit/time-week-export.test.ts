/** The weekly hours export (lib/time-week-export.ts): the week as the review shows it, one row per person per day, hours only. */
import { describe, expect, it } from "vitest";

import { NO_FLAGS, type SavedDayFlags, weekDayFlags } from "@/lib/time-day-flags";
import { type AttendanceEvent, DEFAULT_TIME_SETTINGS, type LabourSession, localInstant, weekTotals } from "@/lib/time-sheet";
import type { PersonWeek } from "@/lib/time-week";
import { toCsv } from "@/lib/spreadsheet";
import { WEEK_COLUMNS, weekExportRows } from "@/lib/time-week-export";

const NONE = new Map<string, string>();
const LATER = new Date("2027-06-01T00:00:00Z").getTime();
let n = 0;

function at(local: string) {
  const [date, time] = local.split(" ");
  const r = localInstant(date, time);
  if (r.kind !== "ok") throw new Error(local);
  return r.at.toISOString();
}
function ev(action: AttendanceEvent["action"], local: string): AttendanceEvent {
  n += 1;
  return { id: `e${n}`, user_id: "u1", action, at: at(local), received_at: new Date(2026, 0, 1, 0, 0, n).toISOString() };
}
const labour: LabourSession = { id: "l1", user_id: "u1", job_id: "j1", started_at: at("2026-10-20 07:30"), ended_at: at("2026-10-20 09:00") };
const savedOvertime: SavedDayFlags = { overtime: true, saturday: false, sunday: false, bank_holiday: false, user_id: "u1", day: "2026-10-20", updated_by: "u1", updated_at: "2026-10-30T12:00:00Z" };

function personWeek(): PersonWeek {
  const week = weekTotals({
    weekStart: "2026-10-19",
    // Tuesday 07:00 to 16:30 (45 minutes of unpaid breaks); Sunday 08:00 to 12:00 with nothing saved; Wednesday a person still clocked in is not here.
    events: [ev("in", "2026-10-20 07:00"), ev("out", "2026-10-20 16:30"), ev("in", "2026-10-25 08:00"), ev("out", "2026-10-25 12:00")],
    labour: [labour], settings: DEFAULT_TIME_SETTINGS, bankHolidays: NONE, now: LATER,
  });
  return { userId: "u1", status: null, week, dayFlags: weekDayFlags(week, [savedOvertime], NONE) };
}

describe("weekExportRows", () => {
  const rows = weekExportRows([personWeek()], { u1: "Pat Turner" }, { j1: { job_no: "J-0001" } });

  it("has a row for each day with time, and none for the empty days", () => {
    expect(rows.map((r) => r.date)).toEqual(["2026-10-20", "2026-10-25"]);
  });

  it("writes person, clock in/out (UK time), hours, ticks and job time lines", () => {
    const lines = toCsv(WEEK_COLUMNS, rows).slice(1).split("\r\n");
    expect(lines[0]).toBe("Person,Date,Clock In,Clock Out,Clocked (hours),Breaks Deducted (hours),Paid (hours),Overtime,Saturday,Sunday,Bank holiday,Job Time (hours)");
    // 9.5 h clocked, 0.75 h unpaid breaks, 8.75 h paid; Overtime saved; 1.5 h on J-0001.
    expect(lines[1]).toBe("Pat Turner,2026-10-20,07:00,16:30,9.5,0.75,8.75,Yes,,,,J-0001 1.50");
    // Sunday: ticked by suggestion only, so "Suggested" (not counted in the totals); no job time.
    expect(lines[2]).toBe("Pat Turner,2026-10-25,08:00,12:00,4,0,4,,,Suggested,,");
  });

  it("names an unknown person and a job the review hasn't got, without losing the row", () => {
    const [row] = weekExportRows([personWeek()], {}, {}, "Unknown");
    expect(row.person).toBe("Unknown");
    expect(row.jobs).toBe("Job 1.50");
  });

  it("is empty for a person with no time and no ticks", () => {
    const empty = weekTotals({ weekStart: "2026-10-19", events: [], labour: [], settings: DEFAULT_TIME_SETTINGS, bankHolidays: NONE, now: LATER });
    expect(weekExportRows([{ userId: "u2", status: null, week: empty, dayFlags: weekDayFlags(empty, [], NONE) }], {}, {})).toEqual([]);
    expect(NO_FLAGS.overtime).toBe(false);
  });
});
