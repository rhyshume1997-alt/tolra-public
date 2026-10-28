import { describe, expect, it } from "vitest";

import { nowState, teamRows } from "@/lib/team-week";
import type { AttendanceEvent, LabourSession, WeekTotals } from "@/lib/time-sheet";

const week = (labour: number, paid: number, attendance: number, daysWorked: number) => ({ labour, paid, attendance, daysWorked } as WeekTotals);
const ev = (id: string, user_id: string, action: AttendanceEvent["action"], at: string, supersedes: string | null = null): AttendanceEvent => ({ id, user_id, action, at, supersedes });
const job = (id: string, user_id: string, job_id: string, started_at: string, ended_at: string | null, voided_at: string | null = null): LabourSession => ({ id, user_id, job_id, started_at, ended_at, voided_at });

describe("team view", () => {
  it("now: on an open job first, else the latest clock action, else out", () => {
    const events = [ev("1", "a", "in", "2026-10-28T08:00:00Z"), ev("2", "b", "in", "2026-10-28T08:00:00Z"), ev("3", "b", "break_start", "2026-10-28T10:00:00Z"), ev("4", "c", "in", "2026-10-28T08:00:00Z"), ev("5", "c", "out", "2026-10-28T12:00:00Z")];
    const labour = [job("j1", "a", "J1", "2026-10-28T08:10:00Z", null), job("j2", "c", "J2", "2026-10-28T09:00:00Z", null, "2026-10-28T09:05:00Z")];
    const nos = { J1: "J-2417" };
    expect(nowState("a", events, labour, nos)).toEqual({ state: "on_job", jobNo: "J-2417", since: "2026-10-28T08:10:00Z" });
    expect(nowState("b", events, labour, nos)).toEqual({ state: "on_break", since: "2026-10-28T10:00:00Z" });
    expect(nowState("c", events, labour, nos)).toEqual({ state: "out" });
    expect(nowState("d", events, labour, nos)).toEqual({ state: "out" });
  });

  it("a corrected clock-out replaces the original", () => {
    const events = [ev("1", "a", "in", "2026-10-28T08:00:00Z"), ev("2", "a", "out", "2026-10-28T09:00:00Z"), ev("3", "a", "void", "2026-10-28T09:30:00Z", "2")];
    expect(nowState("a", events, [], {}).state).toBe("clocked_in");
  });

  it("rows: busiest first by time on jobs, then jobs finished; share of clocked time on jobs", () => {
    const rows = teamRows({
      people: [{ userId: "a", week: week(600, 2000, 2100, 5) }, { userId: "b", week: week(900, 1900, 1800, 4) }, { userId: "c", week: week(0, 0, 0, 0) }],
      events: [], labour: [], jobNos: {},
      finishedBy: ["a", "a", "c", null, "d"],
      names: { a: "Charlie", b: "Lee", c: "Ian", d: "Dave" },
    });
    expect(rows.map((r) => [r.name, r.jobMinutes, r.onJobsPercent, r.jobsFinished])).toEqual([
      ["Lee", 900, 50, 0],
      ["Charlie", 600, 29, 2],
      ["Dave", 0, null, 1],
      ["Ian", 0, null, 1],
    ]);
  });
});
