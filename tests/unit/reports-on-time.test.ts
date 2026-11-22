import { describe, expect, it } from "vitest";

import { londonMonthsEnding } from "@/lib/numbers";
import { lastDespatchByJob } from "@/lib/reports/last-despatch";
import { onTimeCompletion, type OnTimeJob } from "@/lib/reports/on-time-completion";

const periods = londonMonthsEnding(new Date("2026-11-11T12:00:00Z"), 12); // Dec 2025 .. Nov 2026
let n = 0;
const job = (over: Partial<OnTimeJob>): OnTimeJob => ({ id: `j${++n}`, job_no: `J-${n}`, customer: "Acme", is_internal: false, finished_at: null, date_required: null, due_date: null, ...over });
const month = (jobs: OnTimeJob[], key: string) => onTimeCompletion(jobs, periods).months.find((m) => m.key === key)!;

describe("on-time completion", () => {
  it("finished on the due day is on time (zero grace days)", () => {
    const m = month([job({ finished_at: "2026-10-05T14:00:00Z", date_required: "2026-10-05" })], "2026-10");
    expect(m).toMatchObject({ finished: 1, dated: 1, onTime: 1, late: 0, percent: 100 });
  });
  it("one day late is late, and the audit row says how many days", () => {
    const r = onTimeCompletion([job({ finished_at: "2026-10-06T09:00:00Z", date_required: "2026-10-05" })], periods);
    expect(r.months.find((m) => m.key === "2026-10")).toMatchObject({ onTime: 0, late: 1, percent: 0 });
    expect(r.rows[0]).toMatchObject({ result: "Late", daysLate: 1, finishedDate: "2026-10-06", dueDate: "2026-10-05" });
  });
  it("early is on time", () => {
    expect(month([job({ finished_at: "2026-10-01T09:00:00Z", date_required: "2026-10-05" })], "2026-10").onTime).toBe(1);
  });
  it("uses due_date when date_required is empty (requiredDate)", () => {
    expect(month([job({ finished_at: "2026-10-04T09:00:00Z", due_date: "2026-10-05" })], "2026-10").onTime).toBe(1);
  });
  it("no due date: counted apart, not in the percentage", () => {
    const m = month([job({ finished_at: "2026-10-04T09:00:00Z" }), job({ finished_at: "2026-10-04T09:00:00Z", date_required: "2026-10-09" })], "2026-10");
    expect(m).toMatchObject({ finished: 2, dated: 1, onTime: 1, noDueDate: 1, percent: 100 });
  });
  it("a month with only undated jobs, or none, has no percentage (null, never 0)", () => {
    expect(month([job({ finished_at: "2026-10-04T09:00:00Z" })], "2026-10").percent).toBeNull();
    expect(month([], "2026-09").percent).toBeNull();
  });
  it("internal jobs are excluded", () => {
    const r = onTimeCompletion([job({ is_internal: true, finished_at: "2026-10-06T09:00:00Z", date_required: "2026-10-05" })], periods);
    expect(r.total.finished).toBe(0);
    expect(r.rows).toHaveLength(0);
  });
  it("a reopened job (finished_at cleared) drops out", () => {
    expect(onTimeCompletion([job({ finished_at: null, date_required: "2026-10-05" })], periods).total.finished).toBe(0);
  });
  it("London month edge, summer: 23:30 UTC on 30 Jun is 1 Jul", () => {
    const j = job({ finished_at: "2026-06-30T23:30:00Z", date_required: "2026-06-30" });
    expect(month([j], "2026-06").finished).toBe(0);
    expect(month([j], "2026-07")).toMatchObject({ finished: 1, late: 1 }); // 1 Jul London, due 30 Jun
  });
  it("London month edge, winter: 23:30 UTC on 31 Dec is still 31 Dec", () => {
    const j = job({ finished_at: "2026-12-31T23:30:00Z" });
    const periodsDec = londonMonthsEnding(new Date("2026-12-20T12:00:00Z"), 2);
    const r = onTimeCompletion([j], periodsDec);
    expect(r.months.find((m) => m.key === "2026-12")!.finished).toBe(1);
  });
  it("jobs outside the months are ignored; totals add up", () => {
    const r = onTimeCompletion([job({ finished_at: "2024-01-01T10:00:00Z", date_required: "2024-01-01" }), job({ finished_at: "2026-10-04T09:00:00Z", date_required: "2026-10-05" }), job({ finished_at: "2026-11-04T09:00:00Z", date_required: "2026-11-01" })], periods);
    expect(r.total).toMatchObject({ finished: 2, dated: 2, onTime: 1, late: 1, percent: 50 });
  });
  it("last despatch is information only: it never changes the result", () => {
    const j = job({ finished_at: "2026-10-04T09:00:00Z", date_required: "2026-10-05" });
    const late = lastDespatchByJob([{ job_id: j.id, despatched_at: "2026-12-01T10:00:00Z" }]);
    const r = onTimeCompletion([j], periods, late);
    expect(r.rows[0]).toMatchObject({ result: "On time", lastDespatch: "2026-12-01" });
    expect(r.total.onTime).toBe(1);
  });
  it("last despatch keeps the latest per job and ignores empty rows", () => {
    const m = lastDespatchByJob([
      { job_id: "a", despatched_at: "2026-10-01T10:00:00Z" }, { job_id: "a", despatched_at: "2026-10-09T10:00:00Z" }, { job_id: "a", despatched_at: "2026-10-03T10:00:00Z" },
      { job_id: "b", despatched_at: null }, { job_id: null, despatched_at: "2026-10-01T10:00:00Z" }, { job_id: "c", despatched_at: "not a date" },
    ]);
    expect([...m]).toEqual([["a", "2026-10-09T10:00:00Z"]]);
  });
});
