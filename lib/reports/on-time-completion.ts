/**
 * On-time completion by London month. A job counts in the month it was FINISHED (jobs.finished_at, as a London date). On time means the
 * finished London date is on or before the job's required date (zero grace days). A job with no required date is counted apart and is not in
 * the percentage. Internal jobs (is_internal) are left out. A month with no dated jobs has no percentage (null, shown as a dash, never 0%).
 * A reopened job (finished_at cleared) has no finish and so drops out. Part deliveries never mean finished: this reads no delivery note.
 *
 * Inputs: job rows, the London months (lib/numbers Period), and optionally the last despatch per job (information only).
 * Outputs: one row per month, and one audit row per counted job. Must not change: the zero-grace rule or the exclusion of internal jobs.
 * Pure (no React, no I/O).
 */
import { calendarDate } from "@/lib/dates";
import { requiredDate } from "@/lib/job-status";
import type { Period } from "@/lib/numbers";

export type OnTimeJob = {
  id: string;
  job_no: string | null;
  customer: string | null;
  is_internal: boolean | null;
  finished_at: string | null;
  date_required: string | null;
  due_date: string | null;
};

export type OnTimeMonth = { key: string; label: string; finished: number; dated: number; onTime: number; late: number; noDueDate: number; percent: number | null };
export type OnTimeAuditRow = { jobNo: string; customer: string; month: string; finishedDate: string; dueDate: string; result: "On time" | "Late" | "No due date"; daysLate: number; lastDespatch: string };
export type OnTimeReport = { months: OnTimeMonth[]; total: Omit<OnTimeMonth, "key" | "label">; rows: OnTimeAuditRow[] };

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

export function onTimeCompletion(jobs: readonly OnTimeJob[], periods: Period[], lastDespatch?: ReadonlyMap<string, string>): OnTimeReport {
  const blank = () => ({ finished: 0, dated: 0, onTime: 0, late: 0, noDueDate: 0 });
  const by = new Map(periods.map((p) => [p.key, blank()]));
  const rows: OnTimeAuditRow[] = [];
  for (const job of jobs) {
    if (job.is_internal) continue;
    const finishedDate = calendarDate(job.finished_at);
    if (!finishedDate) continue;
    const month = by.get(finishedDate.slice(0, 7));
    if (!month) continue;
    const due = requiredDate(job);
    month.finished += 1;
    let result: OnTimeAuditRow["result"] = "No due date";
    let daysLate = 0;
    if (!due) month.noDueDate += 1;
    else {
      month.dated += 1;
      if (finishedDate <= due) { month.onTime += 1; result = "On time"; }
      else { month.late += 1; result = "Late"; daysLate = dayNumber(finishedDate) - dayNumber(due); }
    }
    rows.push({ jobNo: job.job_no ?? "", customer: job.customer ?? "", month: finishedDate.slice(0, 7), finishedDate, dueDate: due, result, daysLate, lastDespatch: lastDespatch?.get(job.id) ? calendarDate(lastDespatch.get(job.id)) : "" });
  }
  const percent = (m: { dated: number; onTime: number }) => (m.dated ? Math.round((m.onTime / m.dated) * 1000) / 10 : null);
  const months = periods.map((p) => { const m = by.get(p.key)!; return { key: p.key, label: p.label, ...m, percent: percent(m) }; });
  const sum = months.reduce((t, m) => ({ finished: t.finished + m.finished, dated: t.dated + m.dated, onTime: t.onTime + m.onTime, late: t.late + m.late, noDueDate: t.noDueDate + m.noDueDate }), blank());
  rows.sort((a, b) => (a.finishedDate < b.finishedDate ? -1 : a.finishedDate > b.finishedDate ? 1 : a.jobNo < b.jobNo ? -1 : a.jobNo > b.jobNo ? 1 : 0));
  return { months, total: { ...sum, percent: percent(sum) }, rows };
}
