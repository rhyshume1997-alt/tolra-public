/**
 * The admin dashboard's analytics (Rhys, 28 Oct: a quick snapshot for the office, with John's traffic lights): pure functions over
 * rows the dashboard has already read, so each chart is worked out the same way the pages it summarises do (lib/receivables owed,
 * lib/job-flow jobStatusOf, lib/job-status requiredDate, lib/quote-status quoteFigures).
 */
import { owed } from "@/lib/receivables";
import { jobStatusOf, type FlowJob } from "@/lib/job-flow";
import { requiredDate } from "@/lib/job-status";
import { quoteFigures, type QuoteFigureRow } from "@/lib/quote-status";

const DAY_MS = 86_400_000;

/** John's traffic light: green fine, amber watch, red act now, none when there is nothing to judge. */
export type Light = "green" | "amber" | "red" | "none";

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY_MS);

export type AgeBucket = { key: "not_due" | "late_1_30" | "late_31_60" | "late_60_plus"; label: string; light: Light; value: number };

/** Money owed by how late it is, from the collectible invoices (unpaid, payment confirmed), by due date. No due date counts as not due. */
export function owedByAge(invoices: Array<Parameters<typeof owed>[0] & { due_date?: string | null }>, today: string): AgeBucket[] {
  const pence = { not_due: 0, late_1_30: 0, late_31_60: 0, late_60_plus: 0 };
  for (const invoice of invoices) {
    const amount = Math.round(owed(invoice) * 100);
    if (amount <= 0) continue;
    const late = invoice.due_date ? daysBetween(invoice.due_date, today) : 0;
    const key = late <= 0 ? "not_due" : late <= 30 ? "late_1_30" : late <= 60 ? "late_31_60" : "late_60_plus";
    pence[key] += amount;
  }
  return [
    { key: "not_due", label: "Not due yet", light: "green", value: pence.not_due / 100 },
    { key: "late_1_30", label: "1–30 days late", light: "amber", value: pence.late_1_30 / 100 },
    { key: "late_31_60", label: "31–60 days late", light: "red", value: pence.late_31_60 / 100 },
    { key: "late_60_plus", label: "60+ days late", light: "red", value: pence.late_60_plus / 100 },
  ];
}

export type QuoteOutcome = { key: "accepted" | "sent" | "expired" | "rejected"; label: string; count: number };

/** Quotes sent on or after `since`: how they ended (expired = past its valid-until date with no answer), plus the win rate. */
export function quoteOutcomes(rows: Array<QuoteFigureRow & { sent_at?: unknown }>, since: string, today: string): { outcomes: QuoteOutcome[]; winRate: number | null } {
  const sent = rows.filter((row) => typeof row.sent_at === "string" && row.sent_at.slice(0, 10) >= since);
  const figures = quoteFigures(sent, today);
  return {
    outcomes: [
      { key: "accepted", label: "Accepted", count: figures.byStatus.accepted.count },
      { key: "sent", label: "Awaiting reply", count: figures.byStatus.sent.count },
      { key: "expired", label: "Expired", count: figures.byStatus.expired.count },
      { key: "rejected", label: "Rejected", count: figures.byStatus.rejected.count },
    ],
    winRate: figures.winRate,
  };
}

export type JobsByStatus = { notStarted: number; running: number; waiting: number; overdue: number; dueSoon: number };

/** Open jobs by where they are (the Job Board's statuses), plus how many are past their required date or due within `soonDays`. */
export function jobsByStatus(jobs: Array<FlowJob & { date_required?: string | null; due_date?: string | null }>, today: string, soonDays = 7): JobsByStatus {
  const out: JobsByStatus = { notStarted: 0, running: 0, waiting: 0, overdue: 0, dueSoon: 0 };
  for (const job of jobs) {
    const status = jobStatusOf(job);
    if (status === "complete") continue;
    if (status === "not_started") out.notStarted += 1;
    else if (status === "running") out.running += 1;
    else out.waiting += 1;
    const date = requiredDate(job);
    if (!date) continue;
    const left = daysBetween(today, date);
    if (left < 0) out.overdue += 1;
    else if (left <= soonDays) out.dueSoon += 1;
  }
  return out;
}

/** Open jobs coming due on each of the next `days` days (today first), by required date. */
export function workloadDue(jobs: Array<{ date_required?: string | null; due_date?: string | null }>, today: string, days = 14): Array<{ date: string; count: number }> {
  const start = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  const out = Array.from({ length: days }, (_, i) => ({ date: new Date(start + i * DAY_MS).toISOString().slice(0, 10), count: 0 }));
  const index = new Map(out.map((day, i) => [day.date, i]));
  for (const job of jobs) {
    const i = index.get(requiredDate(job));
    if (i !== undefined) out[i].count += 1;
  }
  return out;
}

export type MachineLoad = { id: string; name: string; booked: number; available: number; percent: number };

/** Hours booked on each machine in the week starting `monday` against the hours it is set to work (hours per day x working days). */
export function machineLoad(
  machines: Array<{ id: string; name?: string | null; hours_per_day?: number | null; working_days?: number[] | null }>,
  bookings: Array<{ machine_id: string; start_at: string; estimated_hours?: number | null }>,
  monday: Date,
): MachineLoad[] {
  const end = monday.getTime() + 7 * DAY_MS;
  const booked = new Map<string, number>();
  for (const booking of bookings) {
    const at = Date.parse(booking.start_at);
    if (!(at >= monday.getTime() && at < end)) continue;
    booked.set(booking.machine_id, (booked.get(booking.machine_id) ?? 0) + Number(booking.estimated_hours || 0));
  }
  return machines.map((machine) => {
    const available = Number(machine.hours_per_day ?? 8) * (machine.working_days?.length ?? 5);
    const hours = Math.round((booked.get(machine.id) ?? 0) * 10) / 10;
    return { id: machine.id, name: machine.name || "Machine", booked: hours, available, percent: available > 0 ? Math.round((hours / available) * 100) : 0 };
  }).sort((a, b) => b.percent - a.percent);
}

/** Of the jobs finished in each month, the share finished on or before their required date (jobs with no date are left out). */
export function onTimeByMonth(
  jobs: Array<{ finished_at?: string | null; date_required?: string | null; due_date?: string | null }>,
  months: Array<{ key: string; month: string }>,
): Array<{ month: string; percent: number | null; finished: number }> {
  return months.map(({ key, month }) => {
    let dated = 0;
    let onTime = 0;
    for (const job of jobs) {
      if (!job.finished_at || job.finished_at.slice(0, 7) !== key) continue;
      const date = requiredDate(job);
      if (!date) continue;
      dated += 1;
      if (job.finished_at.slice(0, 10) <= date) onTime += 1;
    }
    return { month, percent: dated ? Math.round((onTime / dated) * 100) : null, finished: dated };
  });
}

/** Right first time: of the jobs inspected in the period, the share whose first inspection passed (a concession is not a pass). */
export function rightFirstTime(inspections: Array<{ job_id: string; result: string; inspected_at: string }>): { percent: number | null; jobs: number; failedFirst: number } {
  const first = new Map<string, { result: string; at: string }>();
  for (const row of inspections) {
    const seen = first.get(row.job_id);
    if (!seen || row.inspected_at < seen.at) first.set(row.job_id, { result: row.result, at: row.inspected_at });
  }
  const jobs = first.size;
  const passed = [...first.values()].filter((row) => row.result === "pass").length;
  return { percent: jobs ? Math.round((passed / jobs) * 100) : null, jobs, failedFirst: jobs - passed };
}

/** The customers with the most paid-invoice value in the period, largest first. */
export function topCustomers(invoices: Array<{ customer?: string | null; total?: number | null }>, n = 5): Array<{ customer: string; value: number }> {
  const pence = new Map<string, number>();
  for (const invoice of invoices) {
    const name = (invoice.customer || "").trim() || "No customer";
    pence.set(name, (pence.get(name) ?? 0) + Math.round(Number(invoice.total || 0) * 100));
  }
  return [...pence.entries()].map(([customer, value]) => ({ customer, value: value / 100 })).sort((a, b) => b.value - a.value).slice(0, n);
}

/** Traffic lights for the headline tiles. */
export const lights = {
  moneyOwed: (owedTotal: number | null, overdueTotal: number | null): Light => (owedTotal === null ? "none" : overdueTotal ? "red" : owedTotal > 0 ? "green" : "none"),
  openJobs: (byStatus: JobsByStatus | null): Light => (!byStatus ? "none" : byStatus.overdue ? "red" : byStatus.dueSoon ? "amber" : "green"),
  percent: (value: number | null, green: number, amber: number): Light => (value === null ? "none" : value >= green ? "green" : value >= amber ? "amber" : "red"),
  daysToPay: (days: number | null, terms = 30): Light => (days === null ? "none" : days <= terms ? "green" : days <= terms + 15 ? "amber" : "red"),
};
