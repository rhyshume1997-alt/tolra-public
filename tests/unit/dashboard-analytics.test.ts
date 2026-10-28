import { describe, expect, it } from "vitest";

import { isOpenJob } from "@/lib/job-flow";
import { jobStatus, requiredDate } from "@/lib/job-status";
import { jobsByStatus, lights, machineLoad, onTimeByMonth, owedByAge, quoteOutcomes, rightFirstTime, topCustomers, workloadDue } from "@/lib/dashboard-analytics";

const TODAY = "2026-10-28";

describe("dashboard analytics", () => {
  it("money owed by age: what is still owed, by days past the due date; no due date is not due", () => {
    const buckets = owedByAge([
      { status: "sent", total: 100, due_date: "2026-11-05" },
      { status: "sent", total: 200, amount_paid: 50, due_date: "2026-10-10" },
      { status: "sent", total: 300, due_date: "2026-09-10" },
      { status: "sent", total: 400, due_date: "2026-07-01" },
      { status: "sent", total: 50 },
      { status: "paid", total: 999, due_date: "2026-01-01" },
      { status: "sent", total: 70, due_date: "2026-01-01", payment_unverified: true },
    ], TODAY);
    expect(Object.fromEntries(buckets.map((b) => [b.key, b.value]))).toEqual({ not_due: 150, late_1_30: 150, late_31_60: 300, late_60_plus: 400 });
  });

  it("quote outcomes count only quotes sent since the date, with the win rate of decided quotes", () => {
    const { outcomes, winRate } = quoteOutcomes([
      { status: "accepted", sent_at: "2026-10-01T09:00:00Z", total_value: 10 },
      { status: "rejected", sent_at: "2026-09-15", total_value: 10 },
      { status: "sent", sent_at: "2026-10-20", valid_until: "2026-11-20", total_value: 10 },
      { status: "sent", sent_at: "2026-09-01", valid_until: "2026-10-01", total_value: 10 },
      { status: "accepted", sent_at: "2026-05-01", total_value: 10 },
      { status: "draft", total_value: 10 },
    ], "2026-07-30", TODAY);
    expect(Object.fromEntries(outcomes.map((o) => [o.key, o.count]))).toEqual({ accepted: 1, sent: 1, expired: 1, rejected: 1 });
    expect(winRate).toBe(33);
  });

  it("open jobs by status, overdue and due soon by required date", () => {
    const out = jobsByStatus([
      { started_at: null, date_required: "2026-10-20" },
      { started_at: "2026-10-01T08:00:00Z", date_required: "2026-11-02" },
      { started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-27T08:00:00Z", due_date: "2026-12-01" },
      { started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-27T08:00:00Z", inspected_at: "2026-10-27T09:00:00Z" },
    ], TODAY);
    expect(out).toEqual({ notStarted: 1, running: 1, waiting: 1, overdue: 1, dueSoon: 1 });
  });

  it("work coming due counts jobs per day from today", () => {
    const days = workloadDue([{ date_required: TODAY }, { due_date: "2026-10-30" }, { date_required: "2026-10-30" }, { date_required: "2026-12-30" }], TODAY, 3);
    expect(days).toEqual([{ date: "2026-10-28", count: 1 }, { date: "2026-10-29", count: 0 }, { date: "2026-10-30", count: 2 }]);
  });

  it("machine load: booked hours this week against hours per day x working days", () => {
    const monday = new Date("2026-10-26T00:00:00Z");
    const load = machineLoad(
      [{ id: "a", name: "DMU 50", hours_per_day: 8, working_days: [1, 2, 3, 4, 5] }, { id: "b", name: "Haas", hours_per_day: 10, working_days: [1, 2, 3, 4] }],
      [{ machine_id: "a", start_at: "2026-10-27T08:00:00Z", estimated_hours: 30 }, { machine_id: "a", start_at: "2026-11-03T08:00:00Z", estimated_hours: 40 }, { machine_id: "b", start_at: "2026-10-28T08:00:00Z", estimated_hours: 10 }],
      monday,
    );
    expect(load.map((m) => [m.name, m.booked, m.available, m.percent])).toEqual([["DMU 50", 30, 40, 75], ["Haas", 10, 40, 25]]);
  });

  it("on time by month leaves out jobs with no required date", () => {
    const months = [{ key: "2026-09", month: "Sep" }, { key: "2026-10", month: "Oct" }];
    const out = onTimeByMonth([
      { finished_at: "2026-10-05T10:00:00Z", date_required: "2026-10-05" },
      { finished_at: "2026-10-07T10:00:00Z", date_required: "2026-10-06" },
      { finished_at: "2026-10-08T10:00:00Z" },
    ], months);
    expect(out).toEqual([{ month: "Sep", percent: null, finished: 0 }, { month: "Oct", percent: 50, finished: 2 }]);
  });

  it("right first time uses each job's first inspection; a concession is not a pass", () => {
    expect(rightFirstTime([
      { job_id: "1", result: "pass", inspected_at: "2026-10-01T10:00:00Z" },
      { job_id: "2", result: "fail", inspected_at: "2026-10-01T10:00:00Z" },
      { job_id: "2", result: "pass", inspected_at: "2026-10-03T10:00:00Z" },
      { job_id: "3", result: "concession", inspected_at: "2026-10-02T10:00:00Z" },
      { job_id: "4", result: "pass", inspected_at: "2026-10-02T10:00:00Z" },
    ])).toEqual({ percent: 50, jobs: 4, failedFirst: 2 });
  });

  it("top customers by paid value, largest first", () => {
    expect(topCustomers([{ customer: "A", total: 10 }, { customer: "B", total: 30 }, { customer: "A", total: 25.5 }, { customer: "", total: 1 }], 2)).toEqual([{ customer: "A", value: 35.5 }, { customer: "B", value: 30 }]);
  });

  it("traffic lights", () => {
    expect(lights.moneyOwed(0, 0)).toBe("none");
    expect(lights.moneyOwed(500, 0)).toBe("green");
    expect(lights.moneyOwed(500, 100)).toBe("red");
    expect(lights.openJobs({ notStarted: 1, running: 0, waiting: 0, overdue: 0, dueSoon: 1 })).toBe("amber");
    expect([lights.percent(96, 95, 85), lights.percent(90, 95, 85), lights.percent(80, 95, 85), lights.percent(null, 95, 85)]).toEqual(["green", "amber", "red", "none"]);
    expect([lights.daysToPay(28), lights.daysToPay(40), lights.daysToPay(60)]).toEqual(["green", "amber", "red"]);
  });
});

describe("late jobs agree across the Dashboard and the Job Board", () => {
  // Open jobs of every kind: not started, running, in rework, finished and waiting for inspection, inspected (complete),
  // each with a required date in the past, today, soon, later, or none (and an older due_date fallback).
  const jobs = [
    { id: "a", started_at: null, date_required: "2026-10-20" },
    { id: "b", started_at: "2026-10-01T08:00:00Z", date_required: "2026-10-27" },
    { id: "c", started_at: "2026-10-01T08:00:00Z", stage: "rework", date_required: "2026-10-25" },
    { id: "d", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-26T10:00:00Z", date_required: "2026-10-24" },
    { id: "e", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-20T10:00:00Z", inspected_at: "2026-10-21T10:00:00Z", date_required: "2026-10-01" },
    { id: "f", started_at: null, date_required: TODAY },
    { id: "g", started_at: null, due_date: "2026-10-22" },
    { id: "h", started_at: null, date_required: "2026-12-01", due_date: "2026-10-01" },
    { id: "i", started_at: null },
    { id: "j", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-27T10:00:00Z", date_required: "2026-10-30" },
  ];

  it("a job finished and waiting for inspection is not late or due soon, whatever its date", () => {
    expect(jobsByStatus([jobs[3]], TODAY)).toEqual({ notStarted: 0, running: 0, waiting: 1, overdue: 0, dueSoon: 0 });
    expect(jobsByStatus([jobs[9]], TODAY)).toEqual({ notStarted: 0, running: 0, waiting: 1, overdue: 0, dueSoon: 0 });
  });

  it("the late count is the Jobs late tile's rule and the Job Board's due status, job for job", () => {
    const status = jobsByStatus(jobs, TODAY);
    // The Jobs late / on time tile: unfinished, required date (date_required, else due_date) before today.
    const tile = jobs.filter((job) => !job.finished_at && requiredDate(job) !== "" && requiredDate(job) < TODAY).length;
    // The Job Board's due badge (lib/job-status jobStatus) on its open jobs.
    const board = jobs.filter((job) => isOpenJob(job) && jobStatus({ ...job, status: "on_track" }, TODAY) === "overdue").length;
    expect(status.overdue).toBe(4); // a, b and c by date_required, g by its due_date; h is not late (date_required wins); d and j are finished
    expect(status.overdue).toBe(tile);
    expect(status.overdue).toBe(board);
  });

  it("a job required today is not late; it is due soon", () => {
    expect(jobsByStatus([{ started_at: null, date_required: TODAY }], TODAY)).toMatchObject({ overdue: 0, dueSoon: 1 });
  });

  it("no required date but a past due date: late, by the older due date", () => {
    expect(jobsByStatus([{ started_at: null, date_required: null, due_date: "2026-10-27" }], TODAY)).toMatchObject({ overdue: 1, dueSoon: 0 });
  });

  it("unfinished jobs past their date count as late whether not started, running or in rework without a finish", () => {
    const late = [
      { started_at: null, date_required: "2026-10-27" },
      { started_at: "2026-10-01T08:00:00Z", date_required: "2026-10-27" },
      { started_at: "2026-10-01T08:00:00Z", stage: "rework", date_required: "2026-10-27" },
    ];
    expect(jobsByStatus(late, TODAY)).toEqual({ notStarted: 1, running: 2, waiting: 0, overdue: 3, dueSoon: 0 });
  });

  it("a job put back to rework after a failed inspection keeps its finish time: the tile, the Job Board and the panel all leave it out of late", () => {
    // fail_job_inspection (037) sets stage rework and clears the inspection but keeps finished_at; the tile (finished_at is null)
    // and jobStatus (a finished job keeps its stored status) do the same, so the three still agree. Changing that is a rule change.
    const job = { started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-20T10:00:00Z", stage: "rework", date_required: "2026-10-25" };
    expect(jobsByStatus([job], TODAY)).toEqual({ notStarted: 0, running: 1, waiting: 0, overdue: 0, dueSoon: 0 });
    expect(jobStatus({ ...job, status: "on_track" }, TODAY)).toBe("on_track");
  });

  it("the status rows add up to the open jobs, the Dashboard's Open jobs tile", () => {
    const status = jobsByStatus(jobs, TODAY);
    expect(status.notStarted + status.running + status.waiting).toBe(jobs.filter((job) => isOpenJob(job)).length);
  });
});
