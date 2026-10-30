import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HAS_REQUIRED_DATE_FILTER, hasRequiredDate, jobMatchesStatus, onTimeJobCount } from "@/lib/job-status";

describe("a job with no due date is never on time", () => {
  it("hasRequiredDate: the worksheet date or the board date, nothing else", () => {
    expect(hasRequiredDate({ date_required: "2026-10-20" })).toBe(true);
    expect(hasRequiredDate({ due_date: "2026-10-20" })).toBe(true);
    expect(hasRequiredDate({})).toBe(false);
    expect(hasRequiredDate({ date_required: null, due_date: "" })).toBe(false);
    expect(hasRequiredDate({ due_date: "soon" })).toBe(false);
  });

  it("the On time tile and On Track filter match only dated on-track jobs", () => {
    expect(jobMatchesStatus({ status: "on_track", due_date: "2026-10-20" }, "on_track")).toBe(true);
    expect(jobMatchesStatus({ status: "on_track", due_date: "" }, "on_track")).toBe(false);
    expect(jobMatchesStatus({ status: "on_track" }, "on_track")).toBe(false);
  });

  it("the No due date chip matches only jobs with no required date", () => {
    expect(jobMatchesStatus({ status: "on_track" }, "no_due_date")).toBe(true);
    expect(jobMatchesStatus({ status: "at_risk", due_date: "" }, "no_due_date")).toBe(true);
    expect(jobMatchesStatus({ status: "on_track", due_date: "2026-10-20" }, "no_due_date")).toBe(false);
  });

  it("other statuses are the job's own, dated or not", () => {
    expect(jobMatchesStatus({ status: "at_risk", due_date: "2026-10-20" }, "at_risk")).toBe(true);
    expect(jobMatchesStatus({ status: "overdue", due_date: "2026-10-01" }, "overdue")).toBe(true);
    expect(jobMatchesStatus({ status: "at_risk", due_date: "2026-10-20" }, "overdue")).toBe(false);
    expect(jobMatchesStatus({ status: "on_track", due_date: "2026-10-20" }, "at_risk")).toBe(false);
  });

  it("an undated job counts only in No due date, never also At risk, Overdue or On time", () => {
    for (const status of ["on_track", "at_risk", "overdue"]) {
      const job = { status, date_required: null, due_date: "" };
      const chips = ["on_track", "at_risk", "overdue", "no_due_date"].filter((chip) => jobMatchesStatus(job, chip));
      expect(chips).toEqual(["no_due_date"]);
    }
  });

  it("a dated job is in exactly one chip, so the chips add up to the jobs in scope", () => {
    const jobs = [{ status: "on_track", due_date: "2026-10-20" }, { status: "at_risk", due_date: "2026-10-20" }, { status: "overdue", due_date: "2026-10-01" }, { status: "on_track" }, { status: "overdue" }];
    const total = ["on_track", "at_risk", "overdue", "no_due_date"].reduce((sum, chip) => sum + jobs.filter((job) => jobMatchesStatus(job, chip)).length, 0);
    expect(total).toBe(jobs.length);
  });

  it("the dashboard's on-time count is the dated unfinished jobs less the late ones, never negative", () => {
    // 10 active jobs, 3 of them with no date, 2 of the dated ones late: 5 on time (not 8).
    expect(onTimeJobCount(7, 2)).toBe(5);
    expect(onTimeJobCount(0, 0)).toBe(0);
    expect(onTimeJobCount(1, 3)).toBe(0);
  });

  it("the dashboard counts dated jobs with the shared filter, and the Job Board uses the shared matcher", () => {
    // The dashboard's browser-side reads moved verbatim to lib/dashboard-figures-legacy.ts (E6); with 111 the database counts them
    // (unfinished, with date_required or due_date) and the same onTimeJobCount works out the on-time figure.
    const dashboard = readFileSync("lib/dashboard-figures-legacy.ts", "utf8");
    expect(readFileSync("lib/dashboard-figures.ts", "utf8")).toContain("onTimeJobCount(dated, late)");
    expect(readFileSync("supabase/migrations/111_dashboard_figures.sql", "utf8")).toContain("'dated', count(*) FILTER (WHERE j.finished_at IS NULL AND (j.date_required IS NOT NULL OR j.due_date IS NOT NULL))");
    expect(HAS_REQUIRED_DATE_FILTER).toBe("date_required.not.is.null,due_date.not.is.null");
    expect(dashboard).toContain("q(activeJobs().or(HAS_REQUIRED_DATE_FILTER))");
    expect(dashboard).toContain("onTimeJobCount(datedJobsCount.count, lateJobsCount.count)");
    expect(dashboard).not.toContain("jobsActive.count - lateJobsCount.count");
    const board = readFileSync("app/(dashboard)/jobs/page.tsx", "utf8");
    // The due-date chips (On time, At risk, Overdue, No due date) count Not started and Running jobs with the shared matcher.
    expect(board).toContain("dueScopeJobs.filter((job) => jobMatchesStatus(job, status)).length");
    expect(board).toContain("const dueScopeJobs = jobs.filter((job) => inDueScope(job));");
    expect(board).toContain("[...statusFilters].some((status) => jobMatchesStatus(job, status))");
  });
});
