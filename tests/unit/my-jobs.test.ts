import { describe, expect, it } from "vitest";
import { MY_JOBS_LIMIT, myJobAction, myJobOffersPause, myJobs } from "@/lib/my-jobs";

const rows = [
  { id: "1", job_no: "J-1", description: "A", stage: "setup", date_required: "2026-10-20", assigned_to: "u1" },
  { id: "2", job_no: "J-2", description: "B", stage: "machining", date_required: "2026-10-18", assigned_to: "u1", finished_at: "2026-10-17" },
  { id: "3", job_no: "J-3", description: "C", stage: "material", due_date: "2026-10-19", assigned_to: "u1" },
  { id: "4", job_no: "J-4", description: "D", stage: "setup", date_required: "2026-10-17", assigned_to: "u2" },
  { id: "5", job_no: "J-5", description: "E", stage: "setup", assigned_to: "u1" },
];
const TODAY = "2026-10-18";

describe("myJobs", () => {
  it("returns only unfinished jobs assigned to the user, soonest due first", () => {
    expect(myJobs(rows, "u1").map((j) => j.id)).toEqual(["3", "1", "5"]);
  });
  it("returns empty when there is no user", () => {
    expect(myJobs(rows, null)).toEqual([]);
    expect(myJobs(rows, undefined)).toEqual([]);
  });
  it("ignores other users and finished jobs", () => {
    expect(myJobs(rows, "u2", MY_JOBS_LIMIT, TODAY)).toEqual([
      { id: "4", jobNo: "J-4", customer: "", description: "D", quantity: null, stage: "setup", status: "not_started", due: "2026-10-17", dueLight: "overdue", notes: "" },
    ]);
  });
  it("keeps a due_date-only job when 20+ dated jobs exist, capping display at 20", () => {
    const dated = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, date_required: `2026-11-${String(i + 1).padStart(2, "0")}`, assigned_to: "u1" }));
    const out = myJobs([...dated, { id: "only-due", due_date: "2026-10-01", assigned_to: "u1" }], "u1");
    expect(out).toHaveLength(20);
    expect(out[0].id).toBe("only-due");
  });
  it("carries customer, quantity and the specification as notes (trimmed; none is empty)", () => {
    const [job] = myJobs([{ id: "n", job_no: "J-N", customer: "Severn Valve Co", quantity_required: 4, specification: "  Deburr all edges \n", assigned_to: "u1" }], "u1", MY_JOBS_LIMIT, TODAY);
    expect(job).toMatchObject({ customer: "Severn Valve Co", quantity: 4, notes: "Deburr all edges" });
    expect(myJobs([{ id: "e", assigned_to: "u1" }], "u1")[0].notes).toBe("");
  });
  it("status: started or in rework is Running, otherwise Not started", () => {
    const out = myJobs([
      { id: "a", assigned_to: "u1" },
      { id: "b", started_at: "2026-10-18T08:05:00Z", assigned_to: "u1" },
      { id: "c", stage: "rework", assigned_to: "u1" },
    ], "u1", MY_JOBS_LIMIT, TODAY);
    expect(Object.fromEntries(out.map((j) => [j.id, j.status]))).toEqual({ a: "not_started", b: "running", c: "running" });
  });
  it("due light as the Job Board: no date, past the date, today, manual at risk, a stale overdue", () => {
    const out = myJobs([
      { id: "none", assigned_to: "u1" },
      { id: "late", date_required: "2026-10-17", assigned_to: "u1" },
      { id: "today", date_required: TODAY, assigned_to: "u1" },
      { id: "risk", date_required: "2026-10-30", status: "at_risk", assigned_to: "u1" },
      { id: "stale", due_date: "2026-11-01", status: "overdue", assigned_to: "u1" },
    ], "u1", MY_JOBS_LIMIT, TODAY);
    expect(Object.fromEntries(out.map((j) => [j.id, j.dueLight]))).toEqual({ none: "no_due_date", late: "overdue", today: "on_track", risk: "at_risk", stale: "on_track" });
  });
});

describe("myJobAction: the one main action, which only opens the job on the Job Board", () => {
  const notStarted = { stage: "setup", status: "not_started" as const };
  const running = { stage: "machining", status: "running" as const };
  const rework = { stage: "rework", status: "running" as const };
  it("not started: Start; running: Finish; in rework: Open rework", () => {
    expect(myJobAction(notStarted, "workshop")).toEqual({ kind: "start", label: "Start on the Job Board" });
    expect(myJobAction(running, "workshop")).toEqual({ kind: "finish", label: "Finish on the Job Board" });
    expect(myJobAction(rework, "workshop")).toEqual({ kind: "rework", label: "Open rework on the Job Board" });
  });
  it("a viewer only views, whatever the job's state", () => {
    for (const job of [notStarted, running, rework]) expect(myJobAction(job, "viewer")).toEqual({ kind: "view", label: "View on the Job Board" });
  });
  it("Pause is offered for a running job only (not before it starts, not in rework, never to a viewer)", () => {
    expect(myJobOffersPause(running, "workshop")).toBe(true);
    expect(myJobOffersPause(notStarted, "workshop")).toBe(false);
    expect(myJobOffersPause(rework, "workshop")).toBe(false);
    expect(myJobOffersPause(running, "viewer")).toBe(false);
  });
});
