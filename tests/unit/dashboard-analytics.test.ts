import { describe, expect, it } from "vitest";

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
