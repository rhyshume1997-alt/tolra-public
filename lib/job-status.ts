/**
 * Job dates and lateness (audit D6, A4). One rule for the job board, dashboard and worksheet.
 *
 *   - Required date: date_required (the worksheet's date), else due_date for older rows (migration 022 keeps the two
 *     equal from now on).
 *   - Overdue: an unfinished job whose required date is before today (UK date). Due today is not overdue.
 *   - "At risk" set by hand is kept. A stored "overdue" on a job whose date has since moved to today or later shows
 *     as on track. Finished jobs keep their stored status. Nothing is written.
 */
export type JobStatus = "on_track" | "at_risk" | "overdue";

export function requiredDate(job: { date_required?: string | null; due_date?: string | null }): string {
  const value = job.date_required || job.due_date || "";
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
}

export function jobStatus(
  job: { status?: string | null; finished_at?: string | null; date_required?: string | null; due_date?: string | null },
  today: string,
): JobStatus {
  const stored: JobStatus = job.status === "at_risk" || job.status === "overdue" ? job.status : "on_track";
  if (job.finished_at) return stored;
  const date = requiredDate(job);
  if (!date) return stored;
  if (date < today.slice(0, 10)) return "overdue";
  return stored === "overdue" ? "on_track" : stored;
}

/**
 * "On time" (the Job Board's On time tile and On Track filter, the dashboard's Jobs Late / On Time): an unfinished job that HAS a
 * required date and is not past it. A job with no date at all is "No due date" and is never counted as on time (nor as late).
 */
export function hasRequiredDate(job: { date_required?: string | null; due_date?: string | null }): boolean {
  return requiredDate(job) !== "";
}

/**
 * The Job Board's due-date filter chips for one job: "on_track" means on time, so it needs a date; "no_due_date" is a job with no
 * required date; at risk and overdue are the job's own status and need a date too (an undated job is only "No due date").
 */
export function jobMatchesStatus(job: { status: string; date_required?: string | null; due_date?: string | null }, status: string): boolean {
  if (status === "on_track") return job.status === "on_track" && hasRequiredDate(job);
  if (status === "no_due_date") return !hasRequiredDate(job);
  // An undated job counts only in "No due date", never also At risk or Overdue (so the chips add up to the jobs in scope).
  if (status === "at_risk" || status === "overdue") return job.status === status && hasRequiredDate(job);
  return job.status === status;
}

/** The due-date chips, in order, with their words (the same on the chips and on the badge beside a job's status). */
export const DUE_CHIPS = [
  { value: "on_track", label: "On time" }, { value: "at_risk", label: "At risk" }, { value: "overdue", label: "Overdue" }, { value: "no_due_date", label: "No due date" },
] as const;

/** Database filter (PostgREST or) for unfinished jobs that have a required date: the dashboard's "dated" jobs. */
export const HAS_REQUIRED_DATE_FILTER = "date_required.not.is.null,due_date.not.is.null";

/** The dashboard's on-time count: the unfinished jobs with a required date, less the late ones (those are among them). */
export function onTimeJobCount(datedActive: number, late: number): number {
  return Math.max(0, datedActive - late);
}

/**
 * The Job Board's average job time in the unit the person chose (issue #3 item 3). The toggle is always honoured: an average under an
 * hour shows as a fraction of an hour ("0.2 h"), or "<0.1 d" in days, not silently in minutes.
 */
export function formatAverageJobTime(avgDays: number | null, unit: "hours" | "days"): string {
  if (avgDays === null || !Number.isFinite(avgDays)) return "\u2014";
  if (unit === "hours") return `${(avgDays * 24).toFixed(1)} h`;
  return avgDays > 0 && avgDays < 0.05 ? "<0.1 d" : `${avgDays.toFixed(1)} d`;
}
