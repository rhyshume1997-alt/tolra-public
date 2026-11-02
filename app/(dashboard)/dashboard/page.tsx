"use client";

import { AiHelperDashboardLink } from "@/components/ai-helper/dashboard-link";
import { fetchAll } from "@/lib/fetch-all";
import { loadMoneyTiles, loadQuoteTiles } from "@/lib/dashboard-tile-figures";
import { HAS_REQUIRED_DATE_FILTER, onTimeJobCount } from "@/lib/job-status";
import { OPEN_JOBS_FILTER, RUNNING_JOBS_FILTER, hasReworkTag, openJobsDueFilter, stageLabel, stageOf } from "@/lib/job-flow";
import { StatusBadge } from "@/components/status-badge";
import { StatTile, toneFromAccent } from "@/components/stat-tile";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Clock, FileText, Layers } from "lucide-react";
import { BarList, DueColumns, LightDot, Panel, PercentLine, RevenueLine, Sparkline, SplitBar } from "@/components/dashboard-charts";
import { TeamWeek } from "@/components/team-week";
import { OverviewJump, OverviewLeaks, OverviewOthers, OverviewSection } from "@/components/overview";
import { attentionSummary, fleetLoad, floorNow, leaksFrom, otherAttention, revenueVsLastMonth } from "@/lib/overview";
import { attendanceReadable, loadClockedIn } from "@/lib/floor-attendance";
import { cuttingHoursByMachine, daysToGetPaid, estimateByJob, invoicedByJob, invoicedByMonth, jobsVsEstimate, owedTrend, revenuePerMachineHour, runHoursByJob, topCustomersInvoiced, type OwedPoint } from "@/lib/overview-metrics";
import { jobsByStatus, lights, machineLoad, onTimeByMonth, quoteOutcomes, rightFirstTime, workloadDue, type AgeBucket, type JobsByStatus, type Light, type MachineLoad } from "@/lib/dashboard-analytics";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { dueWindow, fmtDateText, fmtDateTime, fmtDueBy, toDateInput } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { attentionState } from "@/lib/attention";
import type { AttentionRole, AttentionSection } from "@/lib/attention-items";
import { loadAttention } from "@/lib/attention-load";
import { gbp, toPence } from "@/lib/money";
import { awaitingApproval } from "@/lib/approval-queue";
import { databaseHas068, missingDbObject } from "@/lib/db-features";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";
import { UnrecognisedNetworkBanner } from "@/components/time/unrecognised-network-banner";
import { myJobs, type MyJob } from "@/lib/my-jobs";
import { MyJobs } from "@/components/workshop/my-jobs";
import { useCanOpen } from "@/lib/use-destinations";
import { ColumnToggle } from "@/components/column-toggle";
import { dashboardTileKeysFor, kpiGridClass, statGridClass } from "@/lib/dashboard-tiles";
import { useColumnVisibility } from "@/lib/org-settings";
import { WholeFloor } from "@/components/workshop/whole-floor";

const DASH = "—";
const DAY_MS = 86_400_000;

type AttentionItem = { key: string; title: string; detail: string; href: string; icon: React.ElementType };

type AdminData = {
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
  /** Received per month (invoice_payments by date received, reversals included); null when that read failed. */
  revenue: Array<{ month: string; revenue: number }> | null;
  thisMonthRevenue: number | null;
  /** Invoiced ex VAT per month (issued invoices less issued credit notes, lib/overview-metrics); null when a read failed. */
  invoiced: Array<{ month: string; revenue: number }> | null;
  thisMonthInvoiced: number | null;
  quotesSentThisMonth: number | null;
  /** Accepted this month by quotes.accepted_at, and accepted quotes with no date (not counted); null when the quotes read failed. */
  quotesWon: { count: number; undated: number } | null;
  lateJobs: number | null;
  onTimeJobs: number | null;
  /** Invoice date to paid, invoices paid in the last 90 days (lib/overview-metrics daysToGetPaid); null when the read failed. */
  daysToPay: { average: number | null; count: number } | null;
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
  /** Invoiced ex VAT per customer, last 6 months, credit notes off (lib/overview-metrics topCustomersInvoiced); null when a read failed. */
  customers: { rows: Array<{ customer: string; value: number }>; share: number | null; topCustomer: string | null } | null;
  /** Recorded cutting hours this week per machine (machine_runs, overlaps once); null when the runs or machines read failed. */
  cutting: { total: number; machines: Array<{ id: string; name: string; hours: number }> } | null;
  /** £ invoiced per recorded machine hour, last 90 days, jobs with both only; `value` null when no job has both; null when a read failed. */
  perMachineHour: { value: ReturnType<typeof revenuePerMachineHour> } | null;
  /** Recorded run hours against planned hours for jobs finished in the last 90 days; `value` null when none has both; null when a read failed. */
  vsEstimate: { value: ReturnType<typeof jobsVsEstimate> } | null;
  /** Nightly owed snapshots (migration 116): "missing" while 116 is not applied (the sparkline is hidden); null when the read failed. */
  owedTrend: { state: "missing" } | { state: "ok"; points: OwedPoint[] } | null;
};

type WorkshopData = {
  /** Running: started and not finished, or in rework (the Job Board's Running). */
  running: number | null;
  dueThisWeek: number | null;
  /** As AdminData.dueBy. */
  dueBy: string;
  deliveryNotes: number | null;
  priorityJobs: Array<{ id: string; jobNo: string; description: string; stage: string; status: string }> | null;
  bookings: Array<{ id: string; machine: string; jobNo: string; start: string }> | null;
  myJobs: MyJob[] | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Result = { data: any[] | null; count: number | null };

/** Runs one query. A failure only blanks that one figure (shown as a dash), it never fakes a number. */
async function q(query: PromiseLike<{ data: any; count?: number | null; error: unknown }>): Promise<Result> {
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
async function qAll(page: (from: number, to: number) => PromiseLike<{ data: any; error: unknown }>): Promise<Result> {
  try {
    const { rows, truncated } = await fetchAll(page);
    return { data: truncated ? null : rows, count: null };
  } catch (err) {
    console.error(err);
    return { data: null, count: null };
  }
}

const head = (table: string) => supabase!.from(table).select("*", { count: "exact", head: true });

/** Like qAll, for rows whose `column` is one of `ids`: asked 100 ids at a time (a short URL); any failed part blanks the whole figure. */
async function qIn(table: string, columns: string, column: string, ids: string[]): Promise<Result> {
  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const res = await qAll((from, to) => supabase!.from(table).select(columns).in(column, part).order("id").range(from, to));
    if (!res.data) return { data: null, count: null };
    rows.push(...res.data);
  }
  return { data: rows, count: null };
}

const monthKey = (iso: string) => toDateInput(iso).slice(0, 7);

function lastSixMonths() {
  const out: Array<{ key: string; month: string }> = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
    out.push({ key: monthKey(d.toISOString()), month: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "Europe/London" }).format(d) });
  }
  return out;
}

async function loadAdminData(office: boolean): Promise<AdminData> {
  // The due-within-7-days window, in UK calendar days (lib/dates dueWindow). Its end goes back as `dueBy` for the label.
  const { today, end: weekEnd } = dueWindow();
  const months = lastSixMonths();
  const sinceIso = `${months[0].key}-01`;
  const monthStart = `${months[5].key}-01`;
  // Not finished (no finish time): the jobs the late / on-time figures are worked out on (lib/job-status).
  const activeJobs = () => head("jobs").is("finished_at", null);
  // Late = unfinished and the required date (date_required, else due_date for older jobs) is before today (lib/job-status).
  const lateFilter = `date_required.lt.${today},and(date_required.is.null,due_date.lt.${today})`;

  // Quotes and RFQs are counted by the same rules as their pages (lib/quote-status quoteFigures, lib/rfq-stage rfqFigures), so the
  // dashboard and the Quote Generator / RFQ Control always agree (go-live polish item 18): in the database, one call per tile (migration
  // 132, lib/dashboard-tile-figures), or from every row as before while 132 is not applied.
  const ninetyDaysAgo = toDateInput(new Date(Date.now() - 90 * DAY_MS));
  const [quoteTiles, jobsOpen, dueWeek, drafts, lateJobsCount, datedJobsCount] = await Promise.all([
    loadQuoteTiles(supabase!, { today, monthStart, ninetyDaysAgo }, databaseHas068),
    // Open = Not started + Running + Waiting for inspection, the Job Board's Open jobs (lib/job-flow), and those due this week.
    q(head("jobs").or(OPEN_JOBS_FILTER)),
    q(head("jobs").or(openJobsDueFilter(today, weekEnd))),
    q(awaitingApproval(head("email_history"))),
    q(head("jobs").is("finished_at", null).or(lateFilter)),
    // On time = unfinished with a required date and not late; a job with no date is neither (lib/job-status onTimeJobCount).
    q(activeJobs().or(HAS_REQUIRED_DATE_FILTER)),
  ]);

  // The analytics panels: open jobs by status and coming due, jobs finished and inspected over the six months, and machine load this
  // week (bookings against each machine's working hours).
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday.getTime() + 7 * DAY_MS);
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
  let invoiced: AdminData["invoiced"] = null;
  let thisMonthInvoiced: number | null = null;
  let daysToPay: AdminData["daysToPay"] = null;
  let paidCount: number | null = null;
  let ageBuckets: AgeBucket[] | null = null;
  let customers: AdminData["customers"] = null;
  let cutting: AdminData["cutting"] = null;
  let perMachineHour: AdminData["perMachineHour"] = null;
  let vsEstimate: AdminData["vsEstimate"] = null;
  let owedTrendData: AdminData["owedTrend"] = null;
  const attention: AttentionItem[] = [];
  let attentionFailed = false;

  if (!office) {
    const nowIso = new Date().toISOString();
    const [moneyTiles, paidRes, paidHead, paymentRes, issuedRes, creditRes, runRes, snapshotRes] = await Promise.all([
      // Money owed, by age, and imported invoices to confirm: one call (migration 132), or every unpaid invoice as before.
      loadMoneyTiles(supabase!, today),
      qAll((from, to) => supabase!.from("invoices").select("id, customer, total, status, paid_at, invoice_date, created_at, payment_unverified").eq("status", "paid").or(`paid_at.gte.${sinceIso},invoice_date.gte.${sinceIso},created_at.gte.${sinceIso}`).order("id").range(from, to)),
      q(head("invoices").eq("status", "paid")),
      // Money received in the period comes from the payment rows by the date received (migration 032), reversals
      // (negative rows) included on their own date: never from invoice totals.
      qAll((from, to) => supabase!.from("invoice_payments").select("amount, paid_on").gte("paid_on", sinceIso).order("id").range(from, to)),
      // Invoiced ex VAT: every invoice dated in the six months (drafts, void and cancelled are left out by lib/overview-metrics, which
      // also takes total minus VAT), or with no invoice date and made in them.
      qAll((from, to) => supabase!.from("invoices").select("id, customer, job_id, status, subtotal, vat, carriage, total, invoice_date, created_at").or(`invoice_date.gte.${sinceIso},and(invoice_date.is.null,created_at.gte.${sinceIso})`).order("id").range(from, to)),
      // Issued credit notes in the six months (migration 034): taken off invoiced, on their own date and customer.
      qAll((from, to) => supabase!.from("credit_notes").select("id, customer, status, vat, total, credit_date").eq("status", "issued").gte("credit_date", sinceIso).order("id").range(from, to)),
      // Recorded machine runs (migration 044) still going or ended in the six months: cutting time, £ per machine hour, jobs vs estimate.
      qAll((from, to) => supabase!.from("machine_runs").select("id, job_id, machine_id, started_at, ended_at").or(`ended_at.is.null,ended_at.gte.${sinceIso}`).order("id").range(from, to)),
      // The nightly owed snapshots (migration 116), last 90 days. Read apart from q() so a missing table (116 not applied) is told
      // apart from a failed read: the first hides the sparkline, the second is a dash.
      (async () => {
        try {
          const { data, error } = await supabase!.from("overview_owed_snapshots").select("snapshot_date, owed_amount, late_amount").gte("snapshot_date", ninetyDaysAgo).order("snapshot_date");
          if (error) return missingDbObject(error) ? ({ state: "missing" } as const) : null;
          return Array.isArray(data) ? ({ state: "ok", points: owedTrend(data) } as const) : null;
        } catch (err) {
          console.error(err);
          return null;
        }
      })(),
    ]);
    owedTrendData = snapshotRes;
    paidCount = paidHead.count;
    if (moneyTiles.failed) attentionFailed = true;
    else {
      const toConfirm = moneyTiles.toConfirm ?? 0;
      if (toConfirm) attention.push({ key: "inv-payment-to-confirm", title: `${toConfirm} imported invoice${toConfirm === 1 ? "" : "s"}: payment to confirm`, detail: "Record the payment or confirm it is still owed. Not counted as money owed until checked.", href: "/invoices", icon: AlertCircle });
      unpaidInvoices = moneyTiles.unpaidInvoices;
      moneyOwed = moneyTiles.moneyOwed;
      ageBuckets = moneyTiles.owedByAge;
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
    // Days to get paid: invoices marked paid in the last 90 days, invoice date to paid (lib/overview-metrics daysToGetPaid).
    if (paidRes.data) daysToPay = daysToGetPaid(paidRes.data, ninetyDaysAgo);
    if (issuedRes.data && creditRes.data) {
      // Invoiced ex VAT per month, from issued invoices less issued credit notes (lib/overview-metrics invoicedByMonth).
      const byMonth = invoicedByMonth(issuedRes.data, creditRes.data, months.map((m) => m.key));
      if (byMonth) {
        invoiced = months.map((m) => ({ month: m.month, revenue: Math.round(byMonth.get(m.key) ?? 0) }));
        thisMonthInvoiced = byMonth.get(months[5].key) ?? 0;
      }
      // Top customers: invoiced ex VAT per customer over the six months, credit notes off (lib/overview-metrics topCustomersInvoiced).
      const top = topCustomersInvoiced(issuedRes.data, creditRes.data, sinceIso);
      customers = top ? { rows: top.rows, share: top.share, topCustomer: top.topCustomer } : null;
    }
    if (runRes.data && machineRows.data) {
      const runs = runRes.data.map((r: any) => ({ job_id: String(r.job_id), machine_id: String(r.machine_id), started_at: String(r.started_at), ended_at: r.ended_at ? String(r.ended_at) : null }));
      // Cutting time this week: machine_runs from Monday to now, per machine (lib/overview-metrics cuttingHoursByMachine).
      const perMachine = cuttingHoursByMachine(runs, monday.toISOString(), nowIso);
      const machinesCut = machineRows.data
        .map((m: any) => ({ id: String(m.id), name: String(m.name ?? "Machine"), hours: perMachine.get(String(m.id)) ?? 0 }))
        .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
      cutting = { total: Math.round(machinesCut.reduce((sum, m) => sum + m.hours, 0) * 10) / 10, machines: machinesCut };
      const hoursByJob = runHoursByJob(runs, nowIso);
      // £ per machine hour: invoiced ex VAT on jobs invoiced in the last 90 days over the run hours recorded on those jobs.
      if (issuedRes.data) perMachineHour = { value: revenuePerMachineHour(invoicedByJob(issuedRes.data, ninetyDaysAgo), hoursByJob) };
      // Jobs vs estimate: jobs finished in the last 90 days, run hours against their planned machine hours (job_machines, 042).
      if (finishedJobRows.data) {
        const finished = finishedJobRows.data.filter((j: any) => j.finished_at && toDateInput(j.finished_at) >= ninetyDaysAgo).map((j: any) => String(j.id));
        const plans = await qIn("job_machines", "id, job_id, estimated_hours", "job_id", finished);
        if (plans.data) vsEstimate = { value: jobsVsEstimate(finished, estimateByJob(plans.data), hoursByJob) };
      }
    }
  }

  return {
    openQuotes: quoteTiles.openQuotes,
    pipelineValue: quoteTiles.pipelineValue,
    moneyOwed,
    unpaidInvoices,
    rfqsToQuote: quoteTiles.rfqsToQuote,
    openJobs: jobsOpen.count,
    dueThisWeek: dueWeek.count,
    dueBy: weekEnd,
    revenue,
    thisMonthRevenue,
    invoiced,
    thisMonthInvoiced,
    quotesSentThisMonth: quoteTiles.quotesSentThisMonth,
    // Quotes won: accepted this calendar month (London) by quotes.accepted_at (lib/overview-metrics quotesWon).
    quotesWon: quoteTiles.quotesWon,
    lateJobs: lateJobsCount.count,
    onTimeJobs: datedJobsCount.count !== null && lateJobsCount.count !== null ? onTimeJobCount(datedJobsCount.count, lateJobsCount.count) : null,
    daysToPay,
    pipeline: { rfqs: quoteTiles.rfqsToQuote, quoted: quoteTiles.openQuotes, accepted: quoteTiles.acceptedQuotes, paid: paidCount },
    attention,
    attentionFailed,
    draftEmails: drafts.count,
    owedByAge: ageBuckets,
    quotes90: quoteTiles.quotes90,
    jobsStatus: openJobRows.data ? jobsByStatus(openJobRows.data, today) : null,
    onTime: finishedJobRows.data ? onTimeByMonth(finishedJobRows.data, months) : null,
    rft: inspectionRows.data ? rightFirstTime(inspectionRows.data.map((row: any) => ({ job_id: String(row.job_id), result: String(row.result), inspected_at: String(row.inspected_at) }))) : null,
    machines: machineRows.data && bookingRows.data ? machineLoad(machineRows.data.map((m: any) => ({ ...m, id: String(m.id) })), bookingRows.data.map((b: any) => ({ ...b, machine_id: String(b.machine_id) })), monday) : null,
    workDue: openJobRows.data ? workloadDue(openJobRows.data, today) : null,
    customers,
    cutting,
    perMachineHour,
    vsEstimate,
    owedTrend: owedTrendData,
  };
}

async function loadWorkshopData(userId?: string | null): Promise<WorkshopData> {
  // The due-within-7-days window, in UK calendar days (lib/dates dueWindow). Its end goes back as `dueBy` for the label.
  const { today, end: weekEnd } = dueWindow();
  const now = new Date();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday.getTime() + 7 * DAY_MS);

  const [running, dueWeek, notes, priority, bookings, machines] = await Promise.all([
    q(head("jobs").or(RUNNING_JOBS_FILTER)),
    q(head("jobs").is("finished_at", null).or(`and(date_required.gte.${today},date_required.lte.${weekEnd}),and(due_date.gte.${today},due_date.lte.${weekEnd})`)),
    q(head("delivery_notes").eq("status", "awaiting")),
    q(supabase!.from("jobs").select("id, job_no, description, stage, status, date_required").is("finished_at", null).order("date_required", { ascending: true, nullsFirst: false }).limit(5)),
    q(supabase!.from("machine_bookings").select("id, job_no, start_at, machine_id").neq("status", "complete").gte("start_at", monday.toISOString()).lt("start_at", sunday.toISOString()).order("start_at").limit(8)),
    q(supabase!.from("machines").select("id, name")),
  ]);
  const names = new Map((machines.data ?? []).map((m) => [String(m.id), String(m.name ?? "")]));
  let mine: MyJob[] | null = null;
  if (userId) {
    const mineRes = await q(supabase!.from("jobs").select("id, job_no, customer, description, quantity_required, stage, status, specification, date_required, due_date, started_at, finished_at, assigned_to").eq("assigned_to", userId).or("finished_at.is.null,stage.eq.rework").order("date_required", { ascending: true, nullsFirst: false }).limit(200));
    // Fetch a bounded larger set: DB order ignores due_date fallback, so myJobs sorts by effective date and caps display at 20.
    mine = mineRes.data ? myJobs(mineRes.data, userId) : null;
  }
  return {
    running: running.count,
    dueThisWeek: dueWeek.count,
    dueBy: weekEnd,
    deliveryNotes: notes.count,
    priorityJobs: priority.data ? priority.data.map((row) => ({ id: String(row.id), jobNo: row.job_no || "", description: row.description || "", stage: row.stage || "", status: row.status || "" })) : null,
    bookings: bookings.data ? bookings.data.map((row) => ({ id: String(row.id), machine: names.get(String(row.machine_id)) || "Machine", jobNo: row.job_no || "", start: row.start_at })) : null,
    myJobs: mine,
  };
}

type Loaded<T> = { data: T | null; loading: boolean; error: string | null; retry: () => void };

function useLoaded<T>(loader: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    if (!supabase) {
      setState({ data: null, loading: false, error: "Supabase is not configured." });
      return;
    }
    loader().then(
      (data) => { if (active) setState({ data, loading: false, error: null }); },
      (err) => { if (active) setState({ data: null, loading: false, error: friendlyError(err, "Couldn't load the dashboard.") }); },
    );
    return () => { active = false; };
  }, [loader, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

const num = (value: number | null | undefined, loading: boolean) => (loading || value === null || value === undefined ? DASH : String(value));
const money = (value: number | null | undefined, loading: boolean) => (loading || value === null || value === undefined ? DASH : gbp(value, 0));

function getGreeting(name?: string | null) {
  const hour = new Date().getHours();
  const first = name?.trim().split(/\s+/)[0];
  const base = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return first ? `${base}, ${first}` : base;
}

/** A traffic light as a tile's dot tone (components/stat-tile). */
const LIGHT_TONE: Record<Light, "good" | "warn" | "bad" | "info" | "neutral"> = { green: "good", amber: "warn", red: "bad", blue: "info", none: "neutral" };

function KpiCard({ label, value, subtext, hint, href, accent = "border-l-blue-500", light, valueClass }: { label: string; value: string; subtext: string; hint?: string; icon?: React.ElementType; href?: string; accent?: string; light?: Light; valueClass?: string }) {
  const tone = light ? LIGHT_TONE[light] : toneFromAccent(accent);
  const canOpen = useCanOpen();
  // A tile is a link only when its page opens for this person in this view (no link to an "Access denied" page).
  return <StatTile label={label} value={value} sub={subtext} hint={hint} href={href && canOpen(href) ? href : undefined} tone={tone} valueClassName={tone === "bad" && valueClass ? "text-red-600" : undefined} />;
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-red-700">{message}</p><Button variant="outline" onClick={onRetry}>Retry</Button></CardContent></Card>;
}

function AdminDashboard({ office = false }: { office?: boolean }) {
  const loader = useCallback(() => loadAdminData(office), [office]);
  const { data, loading, error, retry } = useLoaded(loader);
  // The owner's Overview reads Needs attention once, for both the leaks row and the list (the office card loads its own).
  const attentionLoader = useCallback((): Promise<AttentionSection[] | null> => (office ? Promise.resolve(null) : supabase ? loadAttention(supabase, "admin") : Promise.reject(new Error("Supabase is not configured."))), [office]);
  const attention = useLoaded(attentionLoader);
  // Who is clocked in right now, for the People heading. Clock records are readable by admin and office only (lib/floor-attendance),
  // and only the owner's Overview shows the figure.
  const { activeRole } = useUser();
  const readsClocks = !office && attendanceReadable(activeRole);
  const clockedLoader = useCallback(() => (readsClocks && supabase ? loadClockedIn(supabase) : Promise.resolve(null)), [readsClocks]);
  const clockedIn = useLoaded(clockedLoader);
  const d = data;
  // The Revenue panel and This month's tile show one series at a time: invoiced ex VAT (the default) or money received.
  const [revenueBasis, setRevenueBasis] = useState<"invoiced" | "received">("invoiced");
  const series = revenueBasis === "invoiced" ? d?.invoiced ?? null : d?.revenue ?? null;
  const thisMonthSeries = revenueBasis === "invoiced" ? d?.thisMonthInvoiced : d?.thisMonthRevenue;
  const revenueTotal = series ? series.reduce((sum, row) => sum + row.revenue, 0) : null;
  const pipe = d?.pipeline;
  const canOpen = useCanOpen();
  const { isVisible } = useColumnVisibility("dashboard");
  const overdueOwed = d?.owedByAge ? d.owedByAge.filter((b) => b.key !== "not_due").reduce((sum, b) => sum + b.value, 0) : null;
  const kpis: Array<[string, React.ReactNode]> = [
    office
      ? ["rfqs-to-quote", <KpiCard key="rfqs-to-quote" label="RFQs to quote" value={num(d?.rfqsToQuote, loading)} subtext="Outstanding: no quote yet" icon={FileText} href="/rfq" light={d?.rfqsToQuote ? "amber" : "none"} />]
      : ["money-owed", <KpiCard key="money-owed" label="Money owed" value={money(d?.moneyOwed, loading)} subtext={d?.unpaidInvoices != null ? `Across ${d.unpaidInvoices} invoice${d.unpaidInvoices === 1 ? "" : "s"}${overdueOwed ? `, ${gbp(overdueOwed, 0)} overdue` : ""}` : "Unpaid invoices"} hint="Green: nothing overdue. Red: money is past its due date." icon={AlertCircle} href="/invoices" light={lights.moneyOwed(d?.moneyOwed ?? null, overdueOwed)} valueClass="text-red-600" />],
    ["open-jobs", <KpiCard key="open-jobs" label="Open jobs" value={num(d?.openJobs, loading)} subtext={d?.dueThisWeek != null ? `${d.dueThisWeek} due by ${fmtDueBy(d.dueBy)}${d.jobsStatus?.overdue ? `, ${d.jobsStatus.overdue} late` : ""}` : "Not started, running or waiting"} hint="Not started + Running + Waiting for inspection. Complete jobs are not counted. Due by: a required or due date from today (included) to that day. Late: not finished and past its required date, the Job Board's Late. Amber: something due within 7 days. Red: something late." icon={Layers} href="/jobs" light={lights.openJobs(d?.jobsStatus ?? null)} />],
    ["open-quotes", <KpiCard key="open-quotes" label="Open quotes" value={num(d?.openQuotes, loading)} subtext={d?.pipelineValue != null ? `${gbp(d.pipelineValue, 0)} awaiting reply` : "Sent, awaiting reply"} icon={FileText} href="/quotes" light="none" />],
  ];
  const shownKpis = kpis.filter(([key]) => isVisible(key));
  const lastOnTime = d?.onTime ? [...d.onTime].reverse().find((m) => m.percent !== null)?.percent ?? null : null;
  // This month so far against last month, and all machines together: from the same rows as the Revenue and Machine load panels (lib/overview).
  const revenueCompare = revenueVsLastMonth(series, loading, (v) => gbp(v, 0), revenueBasis);
  const fleet = fleetLoad(d?.machines ?? null, loading);
  // A figure whose read failed is a dash with "Couldn't load this." (never 0); while loading, a dash with "Loading…".
  const failedSub = loading ? "Loading…" : "Couldn't load this.";
  const daysAvg = d?.daysToPay?.average ?? null;
  const won = d?.quotesWon ?? null;
  const estimate = d?.vsEstimate ?? null;
  const stats = ([
    // invoices (issued, ex VAT, less credit notes) or invoice_payments (by date received), as the Revenue panel's selector says.
    ["this-month-revenue", `This month, ${revenueBasis === "invoiced" ? "invoiced ex VAT" : "received"}`, money(thisMonthSeries, loading), revenueCompare.detail, "/invoices", "none"],
    // quotes.sent_at in this calendar month (lib/quote-status sentSince).
    ["quotes-sent", "Quotes sent", num(d?.quotesSentThisMonth, loading), "Sent this month", "/quotes", "none"],
    // jobs: unfinished and past their required date, against unfinished with a date and not late (lib/job-status).
    ["jobs-late-on-time", "Jobs late / on time", d && d.lateJobs !== null && d.onTimeJobs !== null ? `${d.lateJobs} / ${d.onTimeJobs}` : DASH, "Jobs not finished, by required date", "/jobs", d && d.lateJobs !== null ? (d.lateJobs ? "red" : "green") : "none"],
    // invoices marked paid in the last 90 days: invoice date to paid (lib/overview-metrics daysToGetPaid).
    ["avg-days-to-pay", "Average days to pay", daysAvg !== null && !loading ? `${Math.round(daysAvg)} days` : DASH,
      !d?.daysToPay || loading ? failedSub : d.daysToPay.count ? `Invoice date to paid, ${d.daysToPay.count} paid in the last 90 days` : "Nothing paid in the last 90 days", "/invoices", lights.daysToPay(loading ? null : daysAvg)],
    // quotes accepted this month by quotes.accepted_at (lib/overview-metrics quotesWon); an accepted quote with no date is not guessed.
    ["quotes-won", "Quotes won", won && !loading ? String(won.count) : DASH,
      !won || loading ? failedSub : `Accepted this month${won.undated ? ` · ${won.undated} accepted with no date not counted` : ""}`, "/quotes", "none"],
    // machine_runs hours against job_machines.estimated_hours, jobs finished in the last 90 days with both (lib/overview-metrics).
    ["jobs-vs-estimate", "Jobs vs estimate", estimate?.value && !loading ? `${estimate.value.percent}%` : DASH,
      !estimate || loading ? failedSub : estimate.value ? `Run time of planned, ${estimate.value.jobs} job${estimate.value.jobs === 1 ? "" : "s"} finished in 90 days, ${estimate.value.over} over` : "No finished job in 90 days has both a plan and run time", "/jobs",
      !estimate?.value || loading ? "none" : estimate.value.percent > 110 ? "red" : estimate.value.percent > 100 ? "amber" : "green"],
  ] as Array<[string, string, string, string, string, Light]>).filter(([key]) => isVisible(key));
  const showAttention = isVisible("needs-attention");
  const showPipeline = isVisible("quote-pipeline");
  const waiting = loading ? "Loading…" : "Couldn't load this.";
  const topRow = [!office && isVisible("revenue-trend"), !office && isVisible("money-by-age"), isVisible("quote-outcomes")].filter(Boolean).length;
  const opsRow = [isVisible("jobs-by-status"), isVisible("on-time-delivery"), isVisible("right-first-time")].filter(Boolean).length;
  const loadRow = [isVisible("machine-load"), isVisible("work-due"), !office && isVisible("top-customers")].filter(Boolean).length;
  const rowCols = (n: number) => (["", "", "lg:grid-cols-2", "lg:grid-cols-3"][n] ?? "");

  // Each panel is built once; the office view and the owner's Overview arrange them differently.
  // The selector is always drawn (loading or not) and keeps its size, so switching or loading never moves the page.
  const basisButton = (basis: "invoiced" | "received", label: string) => (
    <button type="button" aria-pressed={revenueBasis === basis} onClick={() => setRevenueBasis(basis)} data-testid={`revenue-basis-${basis}`}
      className={`px-2 py-1 text-[0.8125rem] font-semibold transition pointer-coarse:min-h-11 ${revenueBasis === basis ? "bg-brand text-brand-ink" : "text-muted-foreground hover:bg-canvas hover:text-ink"}`}>{label}</button>
  );
  const revenuePanel = (className?: string) => <Panel title="Revenue, last 6 months" meta={<span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
    <span role="group" aria-label="Revenue shown as" className="inline-flex border border-line">{basisButton("invoiced", "Invoiced ex VAT")}{basisButton("received", "Received")}</span>
    <span data-testid="revenue-total">{revenueTotal !== null ? `${gbp(revenueTotal, 0)} ${revenueBasis === "invoiced" ? "invoiced" : "received"}` : DASH}</span>
  </span>} href={canOpen("/invoices") ? "/invoices" : undefined} className={className}>
    {series ? <RevenueLine data={series} label={revenueBasis === "invoiced" ? "Invoiced ex VAT" : "Received"} /> : <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  // The owed trend: nightly snapshots only (migration 116), nothing filled in. Hidden while 116 is not applied; a dash when the read failed.
  const trend = d?.owedTrend;
  const owedTrendBlock = loading || !d || trend?.state === "missing" ? null : !trend ? (
    <p className="border-t border-line pt-3 text-sm text-muted-foreground" data-testid="owed-trend">{DASH} Couldn&apos;t load this.</p>
  ) : trend.points.length < 2 ? (
    <p className="border-t border-line pt-3 text-sm text-muted-foreground" data-testid="owed-trend">The trend starts once two nightly figures have been taken.</p>
  ) : (
    <div className="border-t border-line pt-3" data-testid="owed-trend">
      <p className="text-[0.8125rem] text-muted-foreground">Owed each night, {trend.points.length} nights from {fmtDueBy(trend.points[0].date)}</p>
      <Sparkline data={trend.points.map((p) => ({ date: fmtDueBy(p.date), value: p.owed }))} label="Owed" />
    </div>
  );
  const owedPanel = <Panel title="Money owed by age" meta={d?.moneyOwed != null ? gbp(d.moneyOwed, 0) : undefined} href={canOpen("/invoices") ? "/invoices" : undefined}>
    {d?.owedByAge && !d.owedByAge.some((b) => b.value > 0) ? <p className="py-6 text-center text-sm text-muted-foreground">Nothing owed.</p> : d?.owedByAge ? <div className="space-y-3"><SplitBar parts={d.owedByAge} /><ul className="divide-y divide-line/70">{d.owedByAge.map((b) => <li key={b.key} className="flex items-center gap-2 py-2 text-sm"><LightDot light={b.value > 0 ? b.light : "none"} /><span className="text-ink">{b.label}</span><span className="ml-auto font-semibold tabular-nums text-ink">{gbp(b.value, 0)}</span></li>)}</ul></div> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
    {owedTrendBlock}
  </Panel>;
  const quotesPanel = <Panel title="Quotes, last 90 days" meta={d?.quotes90?.winRate != null ? `Win rate ${d.quotes90.winRate}%` : undefined} href={canOpen("/quotes") ? "/quotes" : undefined}>
    {d?.quotes90 ? <BarList rows={d.quotes90.outcomes.map((o) => ({ key: o.key, label: o.label, value: o.count, light: o.key === "accepted" ? "green" as const : o.key === "expired" ? "amber" as const : o.key === "rejected" ? "none" as const : undefined, colour: o.key === "sent" ? "var(--brand-accent)" : undefined }))} empty="No quotes sent in the last 90 days." /> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  const statTiles = (keys: string[]) => stats.filter(([key]) => keys.includes(key)).map(([key, label, value, sub, href, light]) => (
    <StatTile key={key} label={label} value={value} sub={sub} href={canOpen(href) ? href : undefined} tone={LIGHT_TONE[light]} valueClassName="text-2xl" />
  ));
  const jobsStatusPanel = <Panel title="Open jobs by status" meta={d?.jobsStatus ? `${d.jobsStatus.notStarted + d.jobsStatus.running + d.jobsStatus.waiting} open` : undefined} href={canOpen("/jobs") ? "/jobs" : undefined}>
    {d?.jobsStatus ? <BarList rows={[
      { key: "not-started", label: "Not started", value: d.jobsStatus.notStarted, colour: "var(--muted-foreground)" },
      { key: "running", label: "Running", value: d.jobsStatus.running, colour: "var(--brand-accent)" },
      { key: "waiting", label: "Waiting for inspection", value: d.jobsStatus.waiting, light: "amber" },
      { key: "overdue", label: "Late", value: d.jobsStatus.overdue, light: "red" },
    ]} empty="No open jobs." /> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  const onTimePanel = <Panel title="Finished on time" meta={lastOnTime !== null ? <span className="inline-flex items-center gap-2"><LightDot light={lights.percent(lastOnTime, 95, 85)} />{lastOnTime}% latest month</span> : undefined}>
    {d?.onTime ? <PercentLine data={d.onTime} target={95} /> : <p className="flex h-44 items-center justify-center text-sm text-muted-foreground">{waiting}</p>}
    <p className="mt-2 text-[0.8125rem] text-muted-foreground">Finished jobs only: finished on or before their required date. Jobs with no date are left out.</p>
  </Panel>;
  const rftPanel = <Panel title="Right first time" meta="Last 6 months">
    {d?.rft ? (d.rft.percent === null ? <p className="py-6 text-center text-sm text-muted-foreground">No inspections in the last 6 months.</p> : (
      <div className="flex h-full flex-col justify-center gap-2 py-2">
        <div className="flex items-center gap-3"><LightDot light={lights.percent(d.rft.percent, 95, 85)} className="size-3" /><span className="text-[2.5rem] font-semibold leading-none tabular-nums text-ink">{d.rft.percent}%</span></div>
        <span className="text-sm text-muted-foreground">{d.rft.jobs} job{d.rft.jobs === 1 ? "" : "s"} inspected, {d.rft.failedFirst} failed first inspection</span>
      </div>
    )) : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  const machinePanel = <Panel title="Machine load this week" meta={<span data-testid="machine-load-overall" title={fleet.percent === null ? fleet.detail : undefined}>{fleet.percent === null ? DASH : fleet.detail}</span>} href={canOpen("/schedule") ? "/schedule" : undefined}>
    {d?.machines ? <BarList rows={d.machines.map((m) => ({ key: m.id, label: m.name, value: m.percent, light: m.percent > 100 ? "red" as const : m.percent >= 85 ? "amber" as const : "green" as const }))} format={(v) => `${v}%`} empty="No machines booked this week." /> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  const workDuePanel = <Panel title="Work coming due" meta="Next 14 days" href={canOpen("/jobs") ? "/jobs" : undefined}>
    {d?.workDue ? <DueColumns data={d.workDue} /> : <p className="flex h-44 items-center justify-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  // invoices (issued, ex VAT) less credit_notes, per customer, last 6 months; the share is the largest customer's part of everyone's total.
  const customersPanel = <Panel title="Top customers" meta={<span data-testid="top-customer-share">{d?.customers?.share != null && !loading ? `Largest ${d.customers.share}% of invoiced` : "Invoiced ex VAT, last 6 months"}</span>}>
    {d?.customers ? <BarList rows={d.customers.rows.map((c) => ({ key: c.customer, label: c.customer, value: c.value }))} format={(v) => gbp(v, 0)} empty="Nothing invoiced in the last 6 months." /> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
    <p className="mt-2 text-[0.8125rem] text-muted-foreground">Invoiced ex VAT in the last 6 months, credit notes taken off.</p>
  </Panel>;
  // machine_runs this week (Monday to now), per machine, overlaps once (lib/overview-metrics cuttingHoursByMachine). Not booked hours.
  const cuttingPanel = <Panel title="Cutting time this week" meta={<span data-testid="cutting-total">{d?.cutting && !loading ? `${d.cutting.total}h recorded` : DASH}</span>} href={canOpen("/schedule") ? "/schedule" : undefined}>
    {d?.cutting ? <BarList rows={d.cutting.machines.map((m) => ({ key: m.id, label: m.name, value: m.hours, colour: "var(--brand)" }))} format={(v) => `${v}h`} empty="No machine runs recorded this week." /> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
    <p className="mt-2 text-[0.8125rem] text-muted-foreground">Recorded machine runs, paused time left out. Machine load is the booked hours.</p>
  </Panel>;
  // invoices (ex VAT, last 90 days) on jobs over machine_runs hours on those same jobs; jobs without both are left out, never spread.
  const pmh = d?.perMachineHour ?? null;
  const perHourTile = <StatTile key="per-machine-hour" label="£ per machine hour" value={pmh?.value && !loading ? gbp(pmh.value.perHour, 0) : DASH}
    sub={!pmh || loading ? failedSub : pmh.value ? `${gbp(pmh.value.revenue, 0)} invoiced over ${pmh.value.hours}h on ${pmh.value.jobs} job${pmh.value.jobs === 1 ? "" : "s"}, last 90 days` : "No job invoiced in 90 days has recorded run time"}
    href={canOpen("/invoices") ? "/invoices" : undefined} tone="neutral" valueClassName="text-2xl" />;
  const pipelinePanel = (className?: string) => <MaybeLink href="/quotes" allowed={canOpen("/quotes")} className={className}><Card className={`h-full transition ${canOpen("/quotes") ? "cursor-pointer hover:bg-slate-50" : ""}`}><CardHeader><CardTitle>Quote pipeline</CardTitle></CardHeader><CardContent className="grid auto-rows-fr grid-cols-2 gap-3">{([["RFQs outstanding", pipe?.rfqs], ["Quotes awaiting reply", pipe?.quoted], ["Accepted", pipe?.accepted], ...(office ? [] : [["Invoices paid", pipe?.paid]])] as Array<[string, number | null | undefined]>).map(([label, value]) => (
    <div key={label} className="flex min-h-24 min-w-0 flex-col justify-between gap-2 rounded-lg bg-canvas p-3 text-ink"><span className="text-sm leading-tight text-muted-foreground">{label}</span><span className="text-2xl font-semibold leading-none tabular-nums">{num(value, loading)}</span></div>
  ))}</CardContent></Card></MaybeLink>;

  if (!office) {
    // The owner's Overview: what needs you today first, then how the business is doing, section by section (lib/overview).
    const showLeaks = isVisible("leaks");
    const kpiTile = (key: string) => shownKpis.filter(([k]) => k === key).map(([, tile]) => tile);
    const moneyTiles = [...kpiTile("money-owed"), ...statTiles(["this-month-revenue", "avg-days-to-pay"])];
    const moneyPanels = [isVisible("revenue-trend") && revenuePanel(), isVisible("money-by-age") && owedPanel, isVisible("top-customers") && customersPanel].filter(Boolean);
    const workTiles = [...kpiTile("open-jobs"), ...kpiTile("open-quotes"), ...statTiles(["quotes-sent", "jobs-late-on-time", "quotes-won", "jobs-vs-estimate"])];
    const workPanels = [isVisible("quote-outcomes") && quotesPanel, isVisible("jobs-by-status") && jobsStatusPanel, isVisible("on-time-delivery") && onTimePanel, isVisible("right-first-time") && rftPanel, isVisible("work-due") && workDuePanel, showPipeline && pipelinePanel()].filter(Boolean);
    const machineTiles = [isVisible("per-machine-hour") && perHourTile].filter(Boolean) as React.ReactNode[];
    const machinePanels = [isVisible("machine-load") && machinePanel, isVisible("cutting-time") && cuttingPanel].filter(Boolean);
    const present = [
      (showLeaks || showAttention) && "today",
      (moneyTiles.length || moneyPanels.length) && "money",
      (workTiles.length || workPanels.length) && "work",
      (machineTiles.length || machinePanels.length) && "machines",
      isVisible("team-week") && "people",
    ].filter((s): s is string => typeof s === "string");
    const leaks = leaksFrom(attention.data, { rfqsToQuote: loading ? null : d?.rfqsToQuote ?? null, overdueOwed: loading ? null : overdueOwed, money: (v) => gbp(v, 0) }, attention.error !== null);
    // The Today figure counts the Needs attention card's list: its sections plus the Dashboard's own items (d.attention).
    const summary = attentionSummary(attention.data, loading ? { count: null, failed: false } : d ? { count: d.attention.length, failed: d.attentionFailed } : { count: null, failed: true }, attention.error !== null);
    // The People figure: a dash with the reason while loading or when the clock records couldn't be read in full, never 0 (lib/overview).
    const peopleFigure = floorNow(clockedIn.data, clockedIn.loading).figure;
    // What the figure counts beyond the leak tiles, listed under them so the figure always matches what is on screen (lib/overview).
    const others = otherAttention(attention.data, loading || !d ? { items: null, failed: !loading } : { items: d.attention, failed: d.attentionFailed }, attention.error !== null);
    // Up to four tiles share one row; five or six (the Work row with everything shown) go two then three across, never a squeezed row.
    const tileRow = (tiles: React.ReactNode[]) => tiles.length ? <div className={`grid gap-4 ${tiles.length > 4 ? "sm:grid-cols-2 xl:grid-cols-3" : statGridClass(tiles.length)}`}>{tiles}</div> : null;
    const panelGrid = (panels: React.ReactNode[]) => panels.length ? <div className={`grid gap-4 ${rowCols(Math.min(panels.length, 3))}`}>{panels.map((p, i) => <div key={i} className="contents">{p}</div>)}</div> : null;
    return (
      <>
        {error ? <ErrorCard message={error} onRetry={retry} /> : null}
        <OverviewJump present={present} />
        {present.includes("today") ? <OverviewSection id="today" title="Today" figure={summary.total === null ? `${DASH} ${summary.detail}` : summary.detail} sub="Where work and money are slipping, and what needs doing">
          {showLeaks ? <div><OverviewLeaks leaks={leaks} /><OverviewOthers others={others} loading={loading || attention.loading} /></div> : null}
          {showAttention ? <div className="grid gap-6 xl:grid-cols-3"><AttentionList role="admin" preloaded={attention} extra={d?.attention ?? []} extraFailed={d?.attentionFailed ?? false} extraLoading={loading} wide /></div> : null}
        </OverviewSection> : null}
        {present.includes("money") ? <OverviewSection id="money" title="Money" sub="What's coming in, from whom, and what's still owed" href="/invoices" linkLabel="Open invoicing">
          {tileRow(moneyTiles)}
          {panelGrid(moneyPanels)}
        </OverviewSection> : null}
        {present.includes("work") ? <OverviewSection id="work" title="Work" sub="Winning it, making it, and getting it out on time" href="/jobs" linkLabel="Open the Job Board">
          {tileRow(workTiles)}
          {panelGrid(workPanels)}
        </OverviewSection> : null}
        {present.includes("machines") ? <OverviewSection id="machines" title="Machines" sub="How busy each machine is this week, and what its time earns" href="/schedule" linkLabel="Machine schedule">
          {tileRow(machineTiles)}
          {panelGrid(machinePanels)}
        </OverviewSection> : null}
        {present.includes("people") ? <OverviewSection id="people" title="People" figure={readsClocks ? peopleFigure : undefined} sub="This week, from clock-ins · only admins see this" href="/time/week" linkLabel="Weekly hours">
          <TeamWeek />
        </OverviewSection> : null}
      </>
    );
  }

  return (
    <>
      {error ? <ErrorCard message={error} onRetry={retry} /> : null}
      {shownKpis.length ? <section className={`grid gap-4 ${kpiGridClass(shownKpis.length)}`}>{shownKpis.map(([, tile]) => tile)}</section> : null}

      {topRow ? <section className={`grid gap-4 ${topRow === 3 ? "xl:grid-cols-4" : rowCols(topRow)}`}>
        {!office && isVisible("revenue-trend") ? revenuePanel(topRow === 3 ? "xl:col-span-2" : undefined) : null}
        {!office && isVisible("money-by-age") ? owedPanel : null}
        {isVisible("quote-outcomes") ? quotesPanel : null}
      </section> : null}

      {!office && stats.length ? <section className={`grid gap-4 ${statGridClass(stats.length)}`}>
        {statTiles(stats.map(([key]) => key))}
      </section> : null}

      {opsRow ? <section className={`grid gap-4 ${rowCols(opsRow)}`}>
        {isVisible("jobs-by-status") ? jobsStatusPanel : null}
        {isVisible("on-time-delivery") ? onTimePanel : null}
        {isVisible("right-first-time") ? rftPanel : null}
      </section> : null}

      {loadRow ? <section className={`grid gap-4 ${rowCols(loadRow)}`}>
        {isVisible("machine-load") ? machinePanel : null}
        {isVisible("work-due") ? workDuePanel : null}
        {!office && isVisible("top-customers") ? customersPanel : null}
      </section> : null}

      {!office && isVisible("team-week") ? <TeamWeek /> : null}

      {showAttention || showPipeline ? <section className="grid gap-6 xl:grid-cols-3">
        {showAttention ? <AttentionList role={office ? "office" : "admin"} extra={d?.attention ?? []} extraFailed={d?.attentionFailed ?? false} extraLoading={loading} wide={!showPipeline} /> : null}
        {showPipeline ? pipelinePanel(showAttention ? undefined : "xl:col-span-3") : null}
      </section> : null}
    </>
  );
}

/** The Job Board, with this job shown and highlighted (there is no separate job page; the board reads ?job=). */
const jobHref = (id: string) => `/jobs?job=${encodeURIComponent(id)}`;

/** A link when its page opens for this person, otherwise the same content without a link. */
function MaybeLink({ href, allowed, children, className }: { href: string; allowed: boolean; children: React.ReactNode; className?: string }) {
  return allowed ? <Link href={href} className={className}>{children}</Link> : <div className={className}>{children}</div>;
}

/** The "Needs attention" card (rules: lib/attention-items). It loads on its own, so it never blanks, or is blanked by, the rest of the dashboard. */
function AttentionList({ role, extra = [], extraFailed = false, extraLoading = false, wide = false, preloaded }: { role: AttentionRole; extra?: AttentionItem[]; extraFailed?: boolean; extraLoading?: boolean; wide?: boolean; preloaded?: Loaded<AttentionSection[] | null> }) {
  const canOpen = useCanOpen();
  // The owner's Overview loads the list once for the leaks row and this card (preloaded); everyone else's card loads its own.
  const loader = useCallback(() => (preloaded ? Promise.resolve([]) : supabase ? loadAttention(supabase, role) : Promise.reject(new Error("Supabase is not configured."))), [role, preloaded]);
  const own = useLoaded(loader);
  const { data: sections, loading, error, retry } = preloaded ?? own;
  const total = (sections ?? []).reduce((sum, s) => sum + s.count, 0) + extra.length;
  const anyFailed = extraFailed || (sections ?? []).some((s) => s.failed);
  const state = attentionState(total, anyFailed);
  return (
    <Card className={`shadow-sm ${wide ? "xl:col-span-3" : "xl:col-span-2"}`} data-testid="needs-attention">
      <CardHeader><CardTitle>Needs your attention</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {loading || extraLoading ? <p className="text-sm text-slate-500">Loading...</p> : null}
        {error ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>Needs attention couldn&apos;t be loaded. Don&apos;t treat it as all clear.</p><Button variant="outline" onClick={retry}>Retry</Button></div> : null}
        {!loading && !error && state === "clear" ? <p className="text-sm text-slate-500">Nothing needs your attention right now.</p> : null}
        {!loading && !error && state === "incomplete" && !(sections ?? []).some((s) => s.failed) ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Some of this list couldn&apos;t be loaded, so it may be incomplete. Don&apos;t treat it as all clear.</p> : null}
        {extra.map(({ key, title, detail, href, icon: Icon }) => (
          <MaybeLink key={key} href={href} allowed={canOpen(href)} className="flex min-h-16 items-start gap-3 rounded-lg border border-slate-200 p-4 transition [a&]:cursor-pointer [a&]:hover:bg-slate-50">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-50"><Icon className="size-5 text-brand" /></div><div className="min-w-0 break-words"><p className="font-semibold text-slate-950">{title}</p><p className="mt-1 text-sm text-slate-500">{detail}</p></div>
          </MaybeLink>
        ))}
        {(sections ?? []).map((sec) => (sec.failed || sec.count > 0) ? (
          <div key={sec.id} data-testid={`attention-${sec.id}`} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-950">{sec.title} {sec.failed ? null : <span data-testid={`attention-count-${sec.id}`} className="ml-1 rounded-none bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{sec.count}</span>}</h3>
              {!sec.failed && canOpen(sec.href) ? <Link href={sec.href} className="text-sm font-medium text-brand underline-offset-2 hover:underline">View all<span className="sr-only"> {sec.title}</span></Link> : null}
            </div>
            {sec.failed ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Couldn&apos;t load this list. <button type="button" className="font-medium underline" onClick={retry}>Retry</button></p> : null}
            {sec.items.map((item) => (
              <MaybeLink key={item.key} href={item.href} allowed={canOpen(item.href)} className="block rounded-lg border border-slate-200 p-3 transition [a&]:cursor-pointer [a&]:hover:bg-slate-50">
                <p className="font-medium text-slate-950">{item.title}</p><p className="mt-0.5 text-sm text-slate-500">{item.detail}</p>
              </MaybeLink>
            ))}
            {!sec.failed && sec.count > sec.items.length ? <p className="text-xs text-slate-500">and {sec.count - sec.items.length} more, oldest shown first</p> : null}
          </div>
        ) : null)}
      </CardContent>
    </Card>
  );
}

function WorkshopDashboard({ role }: { role: AttentionRole }) {
  const { user } = useUser();
  const loader = useCallback(() => loadWorkshopData(user?.id), [user?.id]);
  const { data, loading, error, retry } = useLoaded(loader);
  const canOpen = useCanOpen();
  const { isVisible } = useColumnVisibility("dashboard");
  const d = data;
  const kpis: Array<[string, React.ReactNode]> = [
    ["jobs-running", <KpiCard key="jobs-running" label="Jobs running" value={num(d?.running, loading)} subtext="Started, not finished" hint="Started, not finished (rework included)" icon={Layers} href="/jobs" />],
    ["due-this-week", <KpiCard key="due-this-week" label="Due within 7 days" value={num(d?.dueThisWeek, loading)} subtext={d ? `Today to ${fmtDueBy(d.dueBy)}` : "Today and the next 7 days"} hint="Jobs not finished with a required or due date from today (included) to 7 days on" icon={Clock} href="/jobs" />],
    ["delivery-notes", <KpiCard key="delivery-notes" label="Delivery notes" value={num(d?.deliveryNotes, loading)} subtext="Awaiting signature" icon={FileText} href="/delivery-notes" />],
  ];
  const shownKpis = kpis.filter(([key]) => isVisible(key));
  const showPriority = isVisible("priority-jobs");
  const showSchedule = isVisible("workshop-schedule");
  return (
    <>
      {error ? <ErrorCard message={error} onRetry={retry} /> : null}
      {shownKpis.length ? <section className={`grid gap-4 ${kpiGridClass(shownKpis.length)}`}>{shownKpis.map(([, tile]) => tile)}</section> : null}
      {isVisible("my-jobs") && d?.myJobs && d.myJobs.length ? <MyJobs jobs={d.myJobs} role={role} canOpenJobs={canOpen("/jobs")} /> : null}
      {isVisible("needs-attention") ? <section className="grid gap-6 xl:grid-cols-3"><AttentionList role={role} /></section> : null}
      {showPriority || showSchedule ? <section className={`grid gap-6 ${showPriority && showSchedule ? "xl:grid-cols-2" : ""}`}>
        {showPriority ? <Card><CardHeader><CardTitle>Priority Jobs</CardTitle></CardHeader><CardContent className="space-y-3">
          {loading ? <p className="text-sm text-slate-500">Loading...</p> : null}
          {!loading && d?.priorityJobs && !d.priorityJobs.length ? <p className="text-sm text-slate-500">No unfinished jobs.</p> : null}
          {!loading && !d?.priorityJobs ? <p className="text-sm text-slate-500">{DASH}</p> : null}
          {(d?.priorityJobs ?? []).map((job) => <MaybeLink href={jobHref(job.id)} allowed={canOpen("/jobs")} key={job.id} className="block rounded-lg border p-4 transition [a&]:hover:bg-slate-50"><p className="font-semibold">{job.jobNo} {job.description}</p>{hasReworkTag(job) ? <StatusBadge status="rework" className="mt-2" /> : <Badge className="mt-2 bg-brand text-brand-ink">{stageOf(job.stage) ? stageLabel(job.stage) : "Workshop"}</Badge>}</MaybeLink>)}
        </CardContent></Card> : null}
        {showSchedule ? <Card><CardHeader><CardTitle>Workshop Schedule This Week</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          {loading ? <p className="text-slate-500">Loading...</p> : null}
          {!loading && d?.bookings && !d.bookings.length ? <p className="text-slate-500">Nothing booked onto machines this week.</p> : null}
          {!loading && !d?.bookings ? <p className="text-slate-500">{DASH}</p> : null}
          {(d?.bookings ?? []).map((row) => <MaybeLink href="/schedule" allowed={canOpen("/schedule")} key={row.id} className="block rounded-lg bg-slate-50 p-3">{fmtDateTime(row.start)}: {row.machine} - {row.jobNo}</MaybeLink>)}
        </CardContent></Card> : null}
      </section> : null}
      {isVisible("whole-floor") ? <WholeFloor /> : null}
    </>
  );
}

function ApprovalLink() {
  const canOpen = useCanOpen();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      if (!supabase) return;
      const { count: drafted, error } = await awaitingApproval(supabase.from("email_history").select("*", { count: "exact", head: true }));
      if (active && !error) setCount(drafted ?? 0);
    }
    void load();
    return () => { active = false; };
  }, []);
  if (!count || !canOpen("/approval")) return null;
  return <Link href="/approval" className="inline-flex w-fit items-center rounded-lg border border-slate-200 bg-white px-4 py-2 pointer-coarse:min-h-11 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50">{count} email{count === 1 ? "" : "s"} need{count === 1 ? "s" : ""} approval</Link>;
}

export default function DashboardPage() {
  const { profile, activeRole } = useUser();
  // activeRole is validated against the profile in lib/use-user.ts.
  const role = activeRole;
  return (
    <div className="space-y-8">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div><h1 className="page-title">Dashboard</h1><p className="mt-2 text-sm text-slate-500">{getGreeting(profile?.full_name)}. {fmtDateText(new Date(), { weekday: "long", year: true, numberAs: "full" })}</p></div>
        <div className="flex flex-wrap items-center gap-2">{role === "admin" || role === "office" ? <><AiHelperDashboardLink /><ApprovalLink /></> : null}<ColumnToggle tableKey="dashboard" keys={dashboardTileKeysFor(role === "office" ? "office" : role === "admin" ? "admin" : "workshop")} /></div>
      </section>
      {role === "admin" ? <UnrecognisedNetworkBanner /> : null}
      {role === "workshop" || role === "viewer" ? <WorkshopDashboard role={role} /> : role === "office" ? <AdminDashboard office /> : <AdminDashboard />}
    </div>
  );
}
