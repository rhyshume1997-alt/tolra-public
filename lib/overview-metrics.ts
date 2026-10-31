/**
 * The owner's Overview: the money, machine and work figures beyond the leaks row (lib/overview). Pure calculations only: the Dashboard
 * (app/(dashboard)/dashboard/page.tsx loadAdminData) reads the rows and passes them in, so every figure here is worked out from rows
 * named at the call and can be tested without a database. Money is added in pence (lib/money), so no figure drifts by a penny.
 *
 * The rules, one per figure:
 *   - Invoiced (ex VAT): an issued invoice counts on its invoice date at total minus VAT (so carriage counts, VAT does not). A draft,
 *     void or cancelled invoice never counts. An issued credit note takes its own total minus VAT off, on its credit date: a credited
 *     invoice stays counted where it was issued and its credit note comes off where it was issued, so nothing is counted twice.
 *   - Received: the payment rows by the date received, reversals (negative rows) included; worked out on the Dashboard as before.
 *   - Top customers: invoiced ex VAT per customer over the same window, credit notes taken off that customer; the share is the largest
 *     customer's part of everyone's total (every customer in the denominator, not only the five shown).
 *   - Days to get paid: invoice date to the date it was marked paid, for invoices paid within the window; an imported invoice whose
 *     payment is still to confirm is left out.
 *   - Quotes won: accepted quotes by the date they were accepted (quotes.accepted_at, set by accept_quote, migration 058). An accepted
 *     quote with no accepted date (some imported ones) can't be placed in a month: it is counted apart, never guessed.
 *   - Cutting time: recorded machine runs (machine_runs, migration 044), clipped to the window, overlaps on one machine counted once. A
 *     paused run has ended, so paused time is never counted. Not the booked hours (that is Machine load).
 *   - £ per machine hour: invoiced ex VAT on jobs, divided by the machine-run hours recorded on those same jobs. Only jobs with both an
 *     invoice and recorded run time count: revenue is never spread over machines without a recorded run behind it.
 *   - Margin: revenue less recorded cost. With no cost recorded the margin is unknown (null), never revenue as profit.
 *   - Jobs vs estimate: recorded run hours against the job's planned machine hours (job_machines.estimated_hours, migration 042, the
 *     current plan), for finished jobs that have both.
 */
import { calendarDate } from "@/lib/dates";
import { fromPence, toPence } from "@/lib/money";
import { invoiceStatus } from "@/lib/receivables";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Statuses that were never a sale: a draft has not been issued; void and cancelled were taken back (lib/receivables NOT_COLLECTIBLE). */
const NOT_INVOICED = new Set(["draft", "void", "voided", "cancelled", "canceled"]);

export type InvoiceMetricRow = {
  id?: string | null;
  customer?: string | null;
  job_id?: string | null;
  status?: string | null;
  subtotal?: number | string | null;
  vat?: number | string | null;
  carriage?: number | string | null;
  total?: number | string | null;
  invoice_date?: string | null;
  created_at?: string | null;
  paid_at?: string | null;
  payment_unverified?: boolean | null;
};

export type CreditMetricRow = {
  customer?: string | null;
  status?: string | null;
  vat?: number | string | null;
  total?: number | string | null;
  credit_date?: string | null;
};

export type MachineRunMetricRow = { job_id: string; machine_id: string; started_at: string; ended_at: string | null };

const pence = (value: number | string | null | undefined) => toPence(Number(value ?? 0) || 0);

/** An issued invoice's value ex VAT, in pence: total minus VAT (carriage included), else lines plus carriage; null with no figures. */
export function invoiceNetPence(row: InvoiceMetricRow): number | null {
  if (row.total != null && row.total !== "") return pence(row.total) - pence(row.vat);
  if (row.subtotal != null && row.subtotal !== "") return pence(row.subtotal) + pence(row.carriage);
  return null;
}

/** True when the invoice was issued and still stands as a sale (a credited or paid one included: its credit note comes off apart). */
export function isInvoiced(row: { status?: string | null }): boolean {
  return !NOT_INVOICED.has(invoiceStatus(row.status));
}

/** The calendar day an invoice counts on: its invoice date, else the day it was made (London). */
const invoiceDay = (row: InvoiceMetricRow) => calendarDate(row.invoice_date) || calendarDate(row.created_at);

const customerOf = (name: string | null | undefined) => (name ?? "").trim() || "No customer";

/**
 * Invoiced ex VAT per month (keys "YYYY-MM"), credit notes off on their own date. Months not in `keys` are ignored. null when any
 * counted invoice has no figures at all (a figure built on a guess is worse than a dash).
 */
export function invoicedByMonth(invoices: InvoiceMetricRow[], credits: CreditMetricRow[], keys: string[]): Map<string, number> | null {
  const buckets = new Map(keys.map((k) => [k, 0]));
  for (const row of invoices) {
    if (!isInvoiced(row)) continue;
    const key = invoiceDay(row).slice(0, 7);
    if (!buckets.has(key)) continue;
    const net = invoiceNetPence(row);
    if (net === null) return null;
    buckets.set(key, buckets.get(key)! + net);
  }
  for (const credit of credits) {
    if (invoiceStatus(credit.status) !== "issued") continue;
    const key = calendarDate(credit.credit_date).slice(0, 7);
    if (!buckets.has(key)) continue;
    buckets.set(key, buckets.get(key)! - (pence(credit.total) - pence(credit.vat)));
  }
  return new Map([...buckets].map(([k, v]) => [k, fromPence(v)]));
}

export type TopCustomers = { rows: Array<{ customer: string; value: number }>; share: number | null; topCustomer: string | null; total: number };

/**
 * Invoiced ex VAT per customer, on or after `since` (YYYY-MM-DD), less that customer's issued credit notes in the same window; the top
 * `n`, and the largest customer's share (whole percent) of everyone's total. share is null when the total is not above zero.
 */
export function topCustomersInvoiced(invoices: InvoiceMetricRow[], credits: CreditMetricRow[], since: string, n = 5): TopCustomers | null {
  const byCustomer = new Map<string, number>();
  for (const row of invoices) {
    if (!isInvoiced(row) || invoiceDay(row) < since) continue;
    const net = invoiceNetPence(row);
    if (net === null) return null;
    const name = customerOf(row.customer);
    byCustomer.set(name, (byCustomer.get(name) ?? 0) + net);
  }
  for (const credit of credits) {
    if (invoiceStatus(credit.status) !== "issued" || calendarDate(credit.credit_date) < since) continue;
    const name = customerOf(credit.customer);
    byCustomer.set(name, (byCustomer.get(name) ?? 0) - (pence(credit.total) - pence(credit.vat)));
  }
  const ranked = [...byCustomer].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = [...byCustomer.values()].reduce((sum, v) => sum + v, 0);
  const top = ranked[0];
  return {
    rows: ranked.slice(0, n).map(([customer, value]) => ({ customer, value: fromPence(value) })),
    share: top && total > 0 ? Math.round((top[1] / total) * 100) : null,
    topCustomer: top ? top[0] : null,
    total: fromPence(total),
  };
}

/** Average whole days from invoice date to paid, for invoices marked paid on or after `since`; null average when none. */
export function daysToGetPaid(rows: InvoiceMetricRow[], since: string): { average: number | null; count: number } {
  const gaps: number[] = [];
  for (const row of rows) {
    if (invoiceStatus(row.status) !== "paid" || row.payment_unverified) continue;
    const invoiced = calendarDate(row.invoice_date);
    const paid = calendarDate(row.paid_at);
    if (!invoiced || !paid || paid < since) continue;
    const gap = (Date.parse(`${paid}T00:00:00Z`) - Date.parse(`${invoiced}T00:00:00Z`)) / DAY_MS;
    if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
  }
  return { average: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null, count: gaps.length };
}

/** Accepted quotes whose accepted date (London) is on or after `since`; `undated`: accepted quotes with no accepted date at all. */
export function quotesWon(quotes: Array<{ status?: string | null; accepted_at?: string | null }>, since: string): { count: number; undated: number } {
  let count = 0;
  let undated = 0;
  for (const quote of quotes) {
    if (String(quote.status ?? "").trim().toLowerCase() !== "accepted") continue;
    const day = calendarDate(quote.accepted_at);
    if (!day) undated += 1;
    else if (day >= since) count += 1;
  }
  return { count, undated };
}

/** Merged length, in ms, of intervals (overlaps counted once). */
function mergedMs(ranges: Array<[number, number]>): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const [start, end] of sorted) {
    if (!current) current = [start, end];
    else if (start <= current[1]) current[1] = Math.max(current[1], end);
    else {
      total += current[1] - current[0];
      current = [start, end];
    }
  }
  return current ? total + current[1] - current[0] : total;
}

const hours = (ms: number) => Math.round((ms / HOUR_MS) * 100) / 100;

/** A run as [start, end] in ms, clipped to [from, to]; a run still going ends at `to`. null when nothing of it is in the window. */
function clip(run: MachineRunMetricRow, from: number, to: number): [number, number] | null {
  const start = Math.max(Date.parse(run.started_at), from);
  const end = Math.min(run.ended_at ? Date.parse(run.ended_at) : to, to);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
}

/** Cutting hours per machine between `from` and `to` (ISO), overlapping runs on one machine counted once. */
export function cuttingHoursByMachine(runs: MachineRunMetricRow[], from: string, to: string): Map<string, number> {
  const lo = Date.parse(from);
  const hi = Date.parse(to);
  const ranges = new Map<string, Array<[number, number]>>();
  for (const run of runs) {
    const r = clip(run, lo, hi);
    if (!r) continue;
    ranges.set(run.machine_id, [...(ranges.get(run.machine_id) ?? []), r]);
  }
  return new Map([...ranges].map(([machine, list]) => [machine, hours(mergedMs(list))]));
}

/** Machine-run hours per job up to `now` (each machine's runs on the job merged; two machines at once are two machine hours). */
export function runHoursByJob(runs: MachineRunMetricRow[], now: string): Map<string, number> {
  const hi = Date.parse(now);
  const ranges = new Map<string, Array<[number, number]>>();
  for (const run of runs) {
    const r = clip(run, Number.NEGATIVE_INFINITY, hi);
    if (!r) continue;
    const key = `${run.job_id}\u0000${run.machine_id}`;
    ranges.set(key, [...(ranges.get(key) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const [key, list] of ranges) {
    const job = key.split("\u0000")[0];
    out.set(job, (out.get(job) ?? 0) + mergedMs(list));
  }
  return new Map([...out].map(([job, ms]) => [job, hours(ms)]));
}

/** Invoiced ex VAT per job (issued invoices with a job, on or after `since`), in pounds. */
export function invoicedByJob(invoices: InvoiceMetricRow[], since: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of invoices) {
    if (!row.job_id || !isInvoiced(row) || invoiceDay(row) < since) continue;
    const net = invoiceNetPence(row);
    if (net === null) continue;
    out.set(String(row.job_id), (out.get(String(row.job_id)) ?? 0) + net);
  }
  return new Map([...out].map(([job, p]) => [job, fromPence(p)]));
}

/**
 * £ of invoiced work per machine hour, over the jobs that have both invoiced value and recorded run hours (others are left out, not
 * spread). null when no job has both.
 */
export function revenuePerMachineHour(revenueByJob: Map<string, number>, hoursByJob: Map<string, number>): { perHour: number; jobs: number; revenue: number; hours: number } | null {
  let revenue = 0;
  let total = 0;
  let jobs = 0;
  for (const [job, value] of revenueByJob) {
    const h = hoursByJob.get(job) ?? 0;
    if (h <= 0 || value <= 0) continue;
    revenue += toPence(value);
    total += h;
    jobs += 1;
  }
  if (!jobs || total <= 0) return null;
  return { perHour: Math.round(fromPence(revenue) / total), jobs, revenue: fromPence(revenue), hours: Math.round(total * 10) / 10 };
}

/** Margin as a percentage of revenue (one decimal); null when the cost is unknown or there is no revenue. Never revenue as profit. */
export function grossMargin(revenue: number | null, recordedCost: number | null): number | null {
  if (revenue === null || recordedCost === null || revenue <= 0) return null;
  return Math.round(((revenue - recordedCost) / revenue) * 1000) / 10;
}

/**
 * Recorded hours against planned hours, over the given jobs that have both: the overall percentage (100 = on estimate), how many jobs,
 * and how many went over. null when none has both.
 */
export function jobsVsEstimate(jobIds: string[], estimateByJob: Map<string, number>, actualByJob: Map<string, number>): { percent: number; jobs: number; over: number } | null {
  let estimate = 0;
  let actual = 0;
  let jobs = 0;
  let over = 0;
  for (const id of new Set(jobIds)) {
    const e = estimateByJob.get(id) ?? 0;
    const a = actualByJob.get(id) ?? 0;
    if (e <= 0 || a <= 0) continue;
    estimate += e;
    actual += a;
    jobs += 1;
    if (a > e) over += 1;
  }
  if (!jobs) return null;
  return { percent: Math.round((actual / estimate) * 100), jobs, over };
}

/** Planned machine hours per job (sum of its job_machines rows). */
export function estimateByJob(rows: Array<{ job_id: string; estimated_hours: number | string | null }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(String(row.job_id), (out.get(String(row.job_id)) ?? 0) + (Number(row.estimated_hours) || 0));
  return out;
}

export type OwedPoint = { date: string; owed: number; late: number };

/** The nightly owed snapshots as points in date order (overview_owed_snapshots, migration 116). Only real snapshots, nothing filled in. */
export function owedTrend(rows: Array<{ snapshot_date: string; owed_amount: number | string; late_amount: number | string }>): OwedPoint[] {
  return rows
    .map((row) => ({ date: String(row.snapshot_date).slice(0, 10), owed: Number(row.owed_amount) || 0, late: Number(row.late_amount) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
