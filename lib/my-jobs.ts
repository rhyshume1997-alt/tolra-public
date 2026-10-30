/** B45: operator "My jobs" — unfinished jobs assigned to the current user, soonest due first. */

import { toDateInput } from "@/lib/dates";
import { hasReworkTag, jobStatusOf } from "@/lib/job-flow";
import { hasRequiredDate, jobStatus } from "@/lib/job-status";

export type MyJobInput = {
  id: string;
  job_no?: string | null;
  customer?: string | null;
  description?: string | null;
  quantity_required?: number | null;
  stage?: string | null;
  status?: string | null;
  specification?: string | null;
  date_required?: string | null;
  due_date?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  assigned_to?: string | null;
};

/** The Job Board's due-date light (lib/job-status DUE_CHIPS values): always shown with its word. */
export type MyJobDue = "on_track" | "at_risk" | "overdue" | "no_due_date";

export type MyJob = {
  id: string;
  jobNo: string;
  customer: string;
  description: string;
  quantity: number | null;
  stage: string;
  /** Not started, or Running (started, or in rework): the job is unfinished, so never Waiting for inspection or Complete. */
  status: "not_started" | "running";
  due: string | null;
  dueLight: MyJobDue;
  /** The job's specification, as the office wrote it ("" when none). */
  notes: string;
};

export const MY_JOBS_LIMIT = 20;

/** Unfinished jobs assigned to userId, soonest required/due date first (no date last). `today` (YYYY-MM-DD, UK) sets the due light. */
export function myJobs(rows: MyJobInput[], userId: string | null | undefined, limit = MY_JOBS_LIMIT, today = toDateInput(new Date())): MyJob[] {
  if (!userId) return [];
  const mine = rows.filter((row) => !row.finished_at && row.assigned_to === userId);
  mine.sort((a, b) => {
    const da = a.date_required || a.due_date || "";
    const db = b.date_required || b.due_date || "";
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da.localeCompare(db);
  });
  return mine.slice(0, limit).map((row) => ({
    id: row.id,
    jobNo: row.job_no || "",
    customer: row.customer || "",
    description: row.description || "",
    quantity: row.quantity_required ?? null,
    stage: row.stage || "",
    status: jobStatusOf(row) === "running" ? "running" : "not_started",
    due: row.date_required || row.due_date || null,
    // As the Job Board's light: no date is "No due date"; otherwise overdue from the date, manual "at risk" kept.
    dueLight: hasRequiredDate(row) ? jobStatus(row, today) : "no_due_date",
    notes: (row.specification || "").trim(),
  }));
}

/**
 * The one big action a job gets on the dashboard. Each only opens the job on the Job Board (/jobs?job=<id>), where the board's own
 * Start, Pause, Finish and Rework buttons do the work (offline outbox, machine pick, paused-machine prompt): the label says so.
 */
export type MyJobAction = { kind: "start" | "finish" | "rework" | "view"; label: string };

export function myJobAction(job: Pick<MyJob, "stage" | "status">, role: string | null | undefined): MyJobAction {
  if (role === "viewer") return { kind: "view", label: "View on the Job Board" };
  if (hasReworkTag(job)) return { kind: "rework", label: "Open rework on the Job Board" };
  if (job.status === "running") return { kind: "finish", label: "Finish on the Job Board" };
  return { kind: "start", label: "Start on the Job Board" };
}

/** A running job (not in rework) also gets a Pause tap; the board shows Pause or Resume as the run stands, so it says both. */
export const myJobOffersPause = (job: Pick<MyJob, "stage" | "status">, role: string | null | undefined) =>
  myJobAction(job, role).kind === "finish";
