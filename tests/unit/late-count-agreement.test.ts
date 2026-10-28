import { describe, expect, it } from "vitest";

import { buildAttention, type AttentionInput } from "@/lib/attention-items";
import { jobsByStatus } from "@/lib/dashboard-analytics";
import { isOpenJob } from "@/lib/job-flow";
import { jobStatus } from "@/lib/job-status";

/**
 * One late count everywhere (round 3 review): the Today list's "Jobs past their required date", the Dashboard's Late row and
 * the Job Board's due status (Late tab) all count the same jobs: not finished and past their required date (date_required,
 * else due_date). Needs PR #36 (jobsByStatus counts unfinished jobs only).
 */
const TODAY = "2026-10-28";
const jobs = [
  { id: "a", job_no: "J-a", started_at: null, finished_at: null, inspected_at: null, stage: "planning", date_required: "2026-10-20" }, // not started, late
  { id: "b", job_no: "J-b", started_at: "2026-10-01T08:00:00Z", finished_at: null, inspected_at: null, stage: "machining", date_required: "2026-10-27" }, // running, late
  { id: "c", job_no: "J-c", started_at: "2026-10-01T08:00:00Z", finished_at: null, inspected_at: null, stage: "machining", due_date: "2026-10-10" }, // running, late on due_date
  { id: "d", job_no: "J-d", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-25T15:00:00Z", inspected_at: null, stage: "inspection", date_required: "2026-10-20" }, // waiting for inspection: not late
  { id: "e", job_no: "J-e", started_at: null, finished_at: null, inspected_at: null, stage: "planning", date_required: TODAY }, // due today: not late
  { id: "f", job_no: "J-f", started_at: null, finished_at: null, inspected_at: null, stage: "planning", date_required: "2026-11-02", due_date: "2026-10-01" }, // date_required wins: not late
  { id: "g", job_no: "J-g", started_at: null, finished_at: null, inspected_at: null, stage: "planning" }, // no date: not late
];
const empty: AttentionInput = { quotes: [], rfqs: [], quotedRfqIds: [], purchaseOrders: [], lateJobs: [], finishedJobs: [], invoices: [], deliveryNotes: [] };

describe("late jobs agree across Today, the Dashboard and the Job Board", () => {
  it("counts the same 3 jobs in all three places", () => {
    // Today reads unfinished jobs (lib/attention-load: finished_at is null), the Dashboard reads open jobs (lib/job-flow).
    const today = buildAttention({ ...empty, lateJobs: jobs.filter((job) => !job.finished_at) }, "admin", TODAY).find((s) => s.id === "jobs-late")!;
    const dashboard = jobsByStatus(jobs.filter(isOpenJob), TODAY).overdue;
    const board = jobs.filter((job) => jobStatus({ ...job, status: "on_track" }, TODAY) === "overdue").map((job) => job.id);
    expect(board).toEqual(["a", "b", "c"]);
    expect(dashboard).toBe(3);
    expect(today.count).toBe(3);
  });
});
