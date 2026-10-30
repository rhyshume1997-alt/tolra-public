"use client";

/**
 * The dashboard's figures as the browser worked them out before migration 111: every quote, RFQ, open job, finished job, inspection,
 * unpaid and paid invoice and payment read page by page (lib/fetch-all) and counted here. Moved verbatim from
 * app/(dashboard)/dashboard/page.tsx (E6). lib/dashboard-figures.ts uses it only while the database doesn't have 111's functions yet,
 * so the page works on either side of the release. Also home of q / head, which the workshop dashboard still uses.
 */
import type React from "react";
import { AlertCircle } from "lucide-react";

import { fetchAll } from "@/lib/fetch-all";
import { invoiceLifecycle, owed } from "@/lib/receivables";
import { HAS_REQUIRED_DATE_FILTER, onTimeJobCount } from "@/lib/job-status";
import { OPEN_JOBS_FILTER, openJobsDueFilter } from "@/lib/job-flow";
import { jobsByStatus, machineLoad, onTimeByMonth, owedByAge, quoteOutcomes, rightFirstTime, topCustomers, workloadDue, type AgeBucket, type JobsByStatus, type MachineLoad } from "@/lib/dashboard-analytics";
import { dueWindow, toDateInput } from "@/lib/dates";
import { toPence } from "@/lib/money";
import { awaitingApproval } from "@/lib/approval-queue";
import { quoteFigures, sentSince } from "@/lib/quote-status";
import { declinedValueByQuote } from "@/lib/quote-versions";
import { databaseHas068 } from "@/lib/db-features";
import { linkedQuotes, rfqFigures } from "@/lib/rfq-stage";
import { supabase } from "@/lib/supabase";

const DAY_MS = 86_400_000;

export type AttentionItem = { key: string; title: string; detail: string; href: string; icon: React.ElementType };

export type AdminData = {
  openQuotes: number | null;
  pipelineValue: number | null;
  moneyOwed: number | null;
  unpaidInvoices: number | null;
  rfqsToQuote: number | null;
  /** Open jobs: Not started + Running + Waiting for inspection (Complete not counted), as the Job Board's Open jobs tile. */
  openJobs: number | null;
  dueThisWeek: number | null;
  /** The last day of the window dueThisWeek was counted over (YYYY-MM-DD), so the label shows the date the count used. */
  dueBy: string;
  revenue: Array<{ month: string; revenue: number }> | null;
  thisMonthRevenue: number | null;
  quotesSentThisMonth: number | null;
  lateJobs: number | null;
  onTimeJobs: number | null;
  avgDaysToPay: number | null;
  pipeline: { rfqs: number | null; quoted: number | null; accepted: number | null; paid: number | null };
  attention: AttentionItem[];
  /** A read behind the attention list failed, so the list may be missing items. */
  attentionFailed: boolean;
  draftEmails: number | null;
  /** The analytics panels (lib/dashboard-analytics); null when their read failed. */
  owedByAge: AgeBucket[] | null;
  quotes90: ReturnType<typeof quoteOutcomes> | null;
  jobsStatus: JobsByStatus | null;
  onTime: Array<{ month: string; percent: number | null; finished: number }> | null;
  rft: ReturnType<typeof rightFirstTime> | null;
  machines: MachineLoad[] | null;
  workDue: Array<{ date: string; count: number }> | null;
  customers: Array<{ customer: string; value: number }> | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Result = { data: any[] | null; count: number | null };
/** True when a read failed (data is null), as opposed to returning no rows. */
export const failedRead = (res: Result) => res.data === null && res.count === null;

/** Runs one query. A failure only blanks that one figure (shown as a dash), it never fakes a number. */
export async function q(query: PromiseLike<{ data: any; count?: number | null; error: unknown }>): Promise<Result> {
  try {
    const { data, count, error } = await query;
    if (error) throw error;
    return { data: Array.isArray(data) ? data : null, count: count ?? null };
  } catch (err) {
    console.error(err);
    return { data: null, count: null };
  }
}

/** Like q, for figures summed over many rows: reads every page (lib/fetch-all); a partial result blanks the figure. */
export async function qAll(page: (from: number, to: number) => PromiseLike<{ data: any; error: unknown }>): Promise<Result> {
  try {
    const { rows, truncated } = await fetchAll(page);
    return { data: truncated ? null : rows, count: null };
  } catch (err) {
    console.error(err);
    return { data: null, count: null };
  }
}

export const head = (table: string) => supabase!.from(table).select("*", { count: "exact", head: true });

export const monthKey = (iso: string) => toDateInput(iso).slice(0, 7);

export function lastSixMonths() {
  const out: Array<{ key: string; month: string }> = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
    out.push({ key: monthKey(d.toISOString()), month: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "Europe/London" }).format(d) });
  }
  return out;
}

// Same rule as the invoice page (lib/receivables): collectible invoices, at what is still owed; imported invoices whose
// payment is still to be confirmed are not counted as owed (migration 027).
export const unpaid = (row: any) => invoiceLifecycle(row.status) === "collectible" && !row.payment_unverified;
export const owedOn = (row: any) => owed(row);

export async function loadAdminData(office: boolean): Promise<AdminData> {
  // The due-within-7-days window, in UK calendar days (lib/dates dueWindow). Its end goes back as `dueBy` for the label.
  const { today, end: weekEnd } = dueWindow();
  const months = lastSixMonths();
  const sinceIso = `${months[0].key}-01`;
  const monthStart = `${months[5].key}-01`;
  // Not finished (no finish time): the jobs the late / on-time figures are worked out on (lib/job-status).
  const activeJobs = () => head("jobs").is("finished_at", null);
  // Late = unfinished and the required date (date_required, else due_date for older jobs) is before today (lib/job-status).
  const lateFilter = `date_required.lt.${today},and(date_required.is.null,due_date.lt.${today})`;

  // Quotes and RFQs are counted by the same functions as their pages (lib/quote-status quoteFigures, lib/rfq-stage rfqFigures),
  // from every row (lib/fetch-all), so the dashboard and the Quote Generator / RFQ Control always agree (go-live polish item 18).
  // 068 (quote versions, declined lines): read only once the database has it; before it every quote is version 1 with no declined line.
  const has068 = await databaseHas068();
  const [quoteRows, declinedRows, rfqRows, jobsOpen, dueWeek, drafts, lateJobsCount, datedJobsCount] = await Promise.all([
    qAll((from, to) => supabase!.from("quotes").select(`id, quote_ref, ${has068 ? "version, " : ""}status, valid_until, total_value, vat_enabled, sent_at, rfq_id, created_at`).order("id").range(from, to)),
    // Lines left off an accepted quote's order (068): an accepted quote is won for its ordered lines only.
    has068
      ? qAll((from, to) => supabase!.from("quote_line_items").select("quote_id, quantity, unit_price, vat_pct, vat_exempt").eq("declined", true).order("id").range(from, to))
      : Promise.resolve<Result>({ data: [], count: null }),
    qAll((from, to) => supabase!.from("rfqs").select("id, status").order("id").range(from, to)),
    // Open = Not started + Running + Waiting for inspection, the Job Board's Open jobs (lib/job-flow), and those due this week.
    q(head("jobs").or(OPEN_JOBS_FILTER)),
    q(head("jobs").or(openJobsDueFilter(today, weekEnd))),
    q(awaitingApproval(head("email_history"))),
    q(head("jobs").is("finished_at", null).or(lateFilter)),
    // On time = unfinished with a required date and not late; a job with no date is neither (lib/job-status onTimeJobCount).
    q(activeJobs().or(HAS_REQUIRED_DATE_FILTER)),
  ]);
  const vatOnQuote = new Map<string, boolean>((quoteRows.data ?? []).map((row: any) => [String(row.id), row.vat_enabled !== false]));
  const declined = declinedRows.data ? declinedValueByQuote(declinedRows.data, (id) => vatOnQuote.get(id) ?? true) : null;
  const quotes = quoteRows.data && declined
    ? quoteFigures(quoteRows.data.map((row: any) => ({ ...row, declined_value: declined.get(String(row.id)) ?? 0 })), today)
    : null;
  const rfqs = rfqRows.data && quoteRows.data
    ? rfqFigures(rfqRows.data.map((row) => ({ id: String(row.id), status: String(row.status || "new") })), linkedQuotes(quoteRows.data))
    : null;

  // The analytics panels: open jobs by status and coming due, jobs finished and inspected over the six months, and machine load this
  // week (bookings against each machine's working hours).
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday.getTime() + 7 * DAY_MS);
  const ninetyDaysAgo = toDateInput(new Date(Date.now() - 90 * DAY_MS));
  const [openJobRows, finishedJobRows, inspectionRows, machineRows, bookingRows] = await Promise.all([
    qAll((from, to) => supabase!.from("jobs").select("id, stage, started_at, finished_at, inspected_at, flow_status, date_required, due_date").or(OPEN_JOBS_FILTER).order("id").range(from, to)),
    qAll((from, to) => supabase!.from("jobs").select("id, finished_at, date_required, due_date").gte("finished_at", sinceIso).order("id").range(from, to)),
    qAll((from, to) => supabase!.from("job_inspections").select("job_id, result, inspected_at").gte("inspected_at", sinceIso).order("id").range(from, to)),
    q(supabase!.from("machines").select("id, name, hours_per_day, working_days").order("name")),
    qAll((from, to) => supabase!.from("machine_bookings").select("id, machine_id, start_at, estimated_hours").gte("start_at", monday.toISOString()).lt("start_at", sunday.toISOString()).order("id").range(from, to)),
  ]);

  let moneyOwed: number | null = null;
  let unpaidInvoices: number | null = null;
  let revenue: AdminData["revenue"] = null;
  let thisMonthRevenue: number | null = null;
  let avgDaysToPay: number | null = null;
  let paidCount: number | null = null;
  let ageBuckets: AgeBucket[] | null = null;
  let customers: AdminData["customers"] = null;
  const attention: AttentionItem[] = [];
  let attentionFailed = false;

  if (!office) {
    const [unpaidRes, paidRes, paidHead, paymentRes] = await Promise.all([
      qAll((from, to) => supabase!.from("invoices").select("id, invoice_ref, customer, total, status, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified").neq("status", "paid").order("id").range(from, to)),
      qAll((from, to) => supabase!.from("invoices").select("id, customer, total, paid_at, invoice_date, created_at").eq("status", "paid").or(`paid_at.gte.${sinceIso},invoice_date.gte.${sinceIso},created_at.gte.${sinceIso}`).order("id").range(from, to)),
      q(head("invoices").eq("status", "paid")),
      // Money received in the period comes from the payment rows by the date received (migration 032), reversals
      // (negative rows) included on their own date: never from invoice totals.
      qAll((from, to) => supabase!.from("invoice_payments").select("amount, paid_on").gte("paid_on", sinceIso).order("id").range(from, to)),
    ]);
    paidCount = paidHead.count;
    if (failedRead(unpaidRes)) attentionFailed = true;
    if (unpaidRes.data) {
      const toConfirm = unpaidRes.data.filter((row) => row.payment_unverified).length;
      if (toConfirm) attention.push({ key: "inv-payment-to-confirm", title: `${toConfirm} imported invoice${toConfirm === 1 ? "" : "s"}: payment to confirm`, detail: "Record the payment or confirm it is still owed. Not counted as money owed until checked.", href: "/invoices", icon: AlertCircle });
      const open = unpaidRes.data.filter(unpaid);
      unpaidInvoices = open.length;
      moneyOwed = open.reduce((sum, row) => sum + owedOn(row), 0);
      ageBuckets = owedByAge(open, today);
    }
    if (paymentRes.data) {
      const buckets = new Map(months.map((m) => [m.key, 0]));
      for (const row of paymentRes.data) {
        if (!row.paid_on) continue;
        const key = String(row.paid_on).slice(0, 7);
        if (buckets.has(key)) buckets.set(key, toPence(Number(buckets.get(key) ?? 0)) / 100 + toPence(Number(row.amount || 0)) / 100);
      }
      revenue = months.map((m) => ({ month: m.month, revenue: Math.round(buckets.get(m.key) ?? 0) }));
      thisMonthRevenue = buckets.get(months[5].key) ?? 0;
    }
    if (paidRes.data) {
      const gaps: number[] = [];
      for (const row of paidRes.data) {
        if (row.paid_at && row.invoice_date) gaps.push((new Date(row.paid_at).getTime() - new Date(row.invoice_date).getTime()) / DAY_MS);
      }
      avgDaysToPay = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
      // Top customers: invoices paid in the six months, by the date they were paid.
      customers = topCustomers(paidRes.data.filter((row) => row.paid_at && String(row.paid_at).slice(0, 10) >= sinceIso));
    }
  }

  return {
    openQuotes: quotes ? quotes.open.count : null,
    pipelineValue: quotes ? quotes.open.value : null,
    moneyOwed,
    unpaidInvoices,
    rfqsToQuote: rfqs ? rfqs.outstanding : null,
    openJobs: jobsOpen.count,
    dueThisWeek: dueWeek.count,
    dueBy: weekEnd,
    revenue,
    thisMonthRevenue,
    quotesSentThisMonth: quoteRows.data ? sentSince(quoteRows.data, monthStart) : null,
    lateJobs: lateJobsCount.count,
    onTimeJobs: datedJobsCount.count !== null && lateJobsCount.count !== null ? onTimeJobCount(datedJobsCount.count, lateJobsCount.count) : null,
    avgDaysToPay,
    pipeline: { rfqs: rfqs ? rfqs.outstanding : null, quoted: quotes ? quotes.open.count : null, accepted: quotes ? quotes.byStatus.accepted.count : null, paid: paidCount },
    attention,
    attentionFailed,
    draftEmails: drafts.count,
    owedByAge: ageBuckets,
    quotes90: quoteRows.data ? quoteOutcomes(quoteRows.data, ninetyDaysAgo, today) : null,
    jobsStatus: openJobRows.data ? jobsByStatus(openJobRows.data, today) : null,
    onTime: finishedJobRows.data ? onTimeByMonth(finishedJobRows.data, months) : null,
    rft: inspectionRows.data ? rightFirstTime(inspectionRows.data.map((row: any) => ({ job_id: String(row.job_id), result: String(row.result), inspected_at: String(row.inspected_at) }))) : null,
    machines: machineRows.data && bookingRows.data ? machineLoad(machineRows.data.map((m: any) => ({ ...m, id: String(m.id) })), bookingRows.data.map((b: any) => ({ ...b, machine_id: String(b.machine_id) })), monday) : null,
    workDue: openJobRows.data ? workloadDue(openJobRows.data, today) : null,
    customers,
  };
}
