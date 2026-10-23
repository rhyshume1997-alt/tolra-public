"use client";

import { fetchAll } from "@/lib/fetch-all";
import { invoiceLifecycle, owed } from "@/lib/receivables";
import { HAS_REQUIRED_DATE_FILTER, onTimeJobCount } from "@/lib/job-status";
import { OPEN_JOBS_FILTER, RUNNING_JOBS_FILTER, hasReworkTag, openJobsDueFilter, stageLabel, stageOf } from "@/lib/job-flow";
import { StatusBadge } from "@/components/status-badge";
import { StatTile, toneFromAccent } from "@/components/stat-tile";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Clock, FileText, Layers, TrendingUp } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate, fmtDateTime, toDateInput } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { attentionState } from "@/lib/attention";
import type { AttentionRole } from "@/lib/attention-items";
import { loadAttention } from "@/lib/attention-load";
import { gbp, toPence } from "@/lib/money";
import { awaitingApproval } from "@/lib/approval-queue";
import { quoteFigures, sentSince } from "@/lib/quote-status";
import { declinedValueByQuote } from "@/lib/quote-versions";
import { databaseHas068 } from "@/lib/db-features";
import { linkedQuotes, rfqFigures } from "@/lib/rfq-stage";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";
import { myJobs, type MyJob } from "@/lib/my-jobs";
import { useCanOpen } from "@/lib/use-destinations";

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
};

type WorkshopData = {
  /** Running: started and not finished, or in rework (the Job Board's Running). */
  running: number | null;
  dueThisWeek: number | null;
  deliveryNotes: number | null;
  priorityJobs: Array<{ id: string; jobNo: string; description: string; stage: string; status: string }> | null;
  bookings: Array<{ id: string; machine: string; jobNo: string; start: string }> | null;
  myJobs: MyJob[] | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Result = { data: any[] | null; count: number | null };
/** True when a read failed (data is null), as opposed to returning no rows. */
const failedRead = (res: Result) => res.data === null && res.count === null;

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

// Same rule as the invoice page (lib/receivables): collectible invoices, at what is still owed; imported invoices whose
// payment is still to be confirmed are not counted as owed (migration 027).
const unpaid = (row: any) => invoiceLifecycle(row.status) === "collectible" && !row.payment_unverified;
const owedOn = (row: any) => owed(row);

async function loadAdminData(office: boolean): Promise<AdminData> {
  const today = toDateInput(new Date());
  const weekEnd = toDateInput(new Date(Date.now() + 7 * DAY_MS));
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

  let moneyOwed: number | null = null;
  let unpaidInvoices: number | null = null;
  let revenue: AdminData["revenue"] = null;
  let thisMonthRevenue: number | null = null;
  let avgDaysToPay: number | null = null;
  let paidCount: number | null = null;
  const attention: AttentionItem[] = [];
  let attentionFailed = false;

  if (!office) {
    const [unpaidRes, paidRes, paidHead, paymentRes] = await Promise.all([
      qAll((from, to) => supabase!.from("invoices").select("id, invoice_ref, customer, total, status, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified").neq("status", "paid").order("id").range(from, to)),
      qAll((from, to) => supabase!.from("invoices").select("id, total, paid_at, invoice_date, created_at").eq("status", "paid").or(`paid_at.gte.${sinceIso},invoice_date.gte.${sinceIso},created_at.gte.${sinceIso}`).order("id").range(from, to)),
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
  };
}

async function loadWorkshopData(userId?: string | null): Promise<WorkshopData> {
  const today = toDateInput(new Date());
  const weekEnd = toDateInput(new Date(Date.now() + 7 * DAY_MS));
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
    const mineRes = await q(supabase!.from("jobs").select("id, job_no, description, stage, date_required, due_date, finished_at, assigned_to").eq("assigned_to", userId).is("finished_at", null).order("date_required", { ascending: true, nullsFirst: false }).limit(200));
    // Fetch a bounded larger set: DB order ignores due_date fallback, so myJobs sorts by effective date and caps display at 20.
    mine = mineRes.data ? myJobs(mineRes.data, userId) : null;
  }
  return {
    running: running.count,
    dueThisWeek: dueWeek.count,
    deliveryNotes: notes.count,
    priorityJobs: priority.data ? priority.data.map((row) => ({ id: String(row.id), jobNo: row.job_no || "", description: row.description || "", stage: row.stage || "", status: row.status || "" })) : null,
    bookings: bookings.data ? bookings.data.map((row) => ({ id: String(row.id), machine: names.get(String(row.machine_id)) || "Machine", jobNo: row.job_no || "", start: row.start_at })) : null,
    myJobs: mine,
  };
}

function useLoaded<T>(loader: () => Promise<T>) {
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

function KpiCard({ label, value, subtext, href, accent = "border-l-blue-500", valueClass }: { label: string; value: string; subtext: string; icon?: React.ElementType; href?: string; accent?: string; valueClass?: string }) {
  const tone = toneFromAccent(accent);
  const canOpen = useCanOpen();
  // A tile is a link only when its page opens for this person in this view (no link to an "Access denied" page).
  return <StatTile label={label} value={value} sub={subtext} href={href && canOpen(href) ? href : undefined} tone={tone} valueClassName={tone === "bad" && valueClass ? "text-red-600" : undefined} />;
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-red-700">{message}</p><Button variant="outline" onClick={onRetry}>Retry</Button></CardContent></Card>;
}

function AdminDashboard({ office = false }: { office?: boolean }) {
  const loader = useCallback(() => loadAdminData(office), [office]);
  const { data, loading, error, retry } = useLoaded(loader);
  const d = data;
  const revenueTotal = d?.revenue ? d.revenue.reduce((sum, row) => sum + row.revenue, 0) : null;
  const pipe = d?.pipeline;
  const canOpen = useCanOpen();

  return (
    <>
      {error ? <ErrorCard message={error} onRetry={retry} /> : null}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {office
          ? <KpiCard label="RFQs to Quote" value={num(d?.rfqsToQuote, loading)} subtext="Outstanding: no quote yet" icon={FileText} href="/rfq" accent="border-l-amber-500" />
          : <KpiCard label="Money Owed" value={money(d?.moneyOwed, loading)} subtext={d?.unpaidInvoices != null ? `Across ${d.unpaidInvoices} invoice${d.unpaidInvoices === 1 ? "" : "s"}` : "Unpaid invoices"} icon={AlertCircle} href="/invoices" accent="border-l-red-500" valueClass="text-red-600" />}
        <KpiCard label="Open jobs" value={num(d?.openJobs, loading)} subtext={`Not started + Running + Waiting for inspection${d?.dueThisWeek != null ? `; ${d.dueThisWeek} open jobs due this week` : ""}`} icon={Layers} href="/jobs" />
        <KpiCard label="Open Quotes" value={num(d?.openQuotes, loading)} subtext={d?.pipelineValue != null ? `${gbp(d.pipelineValue, 0)} awaiting reply` : "Sent, awaiting reply"} icon={FileText} href="/quotes" accent="border-l-amber-500" />
      </section>

      {!office ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Revenue Trend - Last 6 Months</CardTitle>
              <p className="text-sm text-slate-500">{revenueTotal !== null ? `${gbp(revenueTotal, 0)} received over the last 6 months` : "Payments received by month"}</p>
            </CardHeader>
            <CardContent className="h-80">
              {d?.revenue ? (
                <ResponsiveContainer width="100%" height="100%"><BarChart data={d.revenue}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="month" /><YAxis tickFormatter={(value) => `£${Number(value) / 1000}k`} /><Tooltip formatter={(value) => gbp(Number(value), 0)} /><Bar dataKey="revenue" fill="var(--brand)" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
              ) : <div className="flex h-full items-center justify-center text-slate-400">{loading ? "Loading..." : DASH}</div>}
            </CardContent>
          </Card>
          <section className="grid gap-4 md:grid-cols-4">
            {([
              ["This Month Revenue", money(d?.thisMonthRevenue, loading), "Payments received this month", TrendingUp, "/invoices"],
              ["Quotes Sent", num(d?.quotesSentThisMonth, loading), "Sent this month", FileText, "/quotes"],
              ["Jobs Late / On Time", d && d.lateJobs !== null && d.onTimeJobs !== null ? `${d.lateJobs} / ${d.onTimeJobs}` : DASH, "Jobs not finished, by required date", Layers, "/jobs"],
              ["Avg Days to Pay", d?.avgDaysToPay != null ? `${Math.round(d.avgDaysToPay)} days` : DASH, "Invoice date to final payment", Clock, "/invoices"],
            ] as Array<[string, string, string, React.ElementType, string]>).map(([label, value, sub, , href]) => (
              <StatTile key={label} label={label} value={value} sub={sub} href={canOpen(href) ? href : undefined} tone="neutral" valueClassName="text-2xl" />
            ))}
          </section>
        </>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-3">
        <AttentionList role={office ? "office" : "admin"} extra={d?.attention ?? []} extraFailed={d?.attentionFailed ?? false} extraLoading={loading} />
        <MaybeLink href="/quotes" allowed={canOpen("/quotes")}><Card className={`h-full transition ${canOpen("/quotes") ? "cursor-pointer hover:bg-slate-50" : ""}`}><CardHeader><CardTitle>Quote Pipeline</CardTitle></CardHeader><CardContent className="grid auto-rows-fr grid-cols-2 gap-3">{([["RFQs outstanding", pipe?.rfqs], ["Quotes awaiting reply", pipe?.quoted], ["Accepted", pipe?.accepted], ...(office ? [] : [["Invoices paid", pipe?.paid]])] as Array<[string, number | null | undefined]>).map(([label, value]) => (
          <div key={label} className="flex min-h-24 min-w-0 flex-col justify-between gap-2 rounded-lg bg-gradient-to-r from-brand to-brand-accent p-3 text-white"><span className="text-sm leading-tight">{label}</span><span className="text-2xl font-semibold leading-none tabular-nums">{num(value, loading)}</span></div>
        ))}</CardContent></Card></MaybeLink>
      </section>
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
function AttentionList({ role, extra = [], extraFailed = false, extraLoading = false }: { role: AttentionRole; extra?: AttentionItem[]; extraFailed?: boolean; extraLoading?: boolean }) {
  const canOpen = useCanOpen();
  const loader = useCallback(() => (supabase ? loadAttention(supabase, role) : Promise.reject(new Error("Supabase is not configured."))), [role]);
  const { data: sections, loading, error, retry } = useLoaded(loader);
  const total = (sections ?? []).reduce((sum, s) => sum + s.count, 0) + extra.length;
  const anyFailed = extraFailed || (sections ?? []).some((s) => s.failed);
  const state = attentionState(total, anyFailed);
  return (
    <Card className="shadow-sm xl:col-span-2" data-testid="needs-attention">
      <CardHeader><CardTitle>Needs Your Attention</CardTitle></CardHeader>
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
              <h3 className="text-sm font-semibold text-slate-950">{sec.title} {sec.failed ? null : <span data-testid={`attention-count-${sec.id}`} className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{sec.count}</span>}</h3>
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
  const d = data;
  return (
    <>
      {error ? <ErrorCard message={error} onRetry={retry} /> : null}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard label="Jobs Running" value={num(d?.running, loading)} subtext="Started, not finished (rework included)" icon={Layers} href="/jobs" />
        <KpiCard label="Due This Week" value={num(d?.dueThisWeek, loading)} subtext="Not started or Running, by required date" icon={Clock} href="/jobs" />
        <KpiCard label="Delivery Notes" value={num(d?.deliveryNotes, loading)} subtext="Awaiting signature" icon={FileText} href="/delivery-notes" />
      </section>
      {d?.myJobs && d.myJobs.length ? (
        <Card>
          <CardHeader><CardTitle>My jobs</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {d.myJobs.map((job) => (
              <MaybeLink href={jobHref(job.id)} allowed={canOpen("/jobs")} key={job.id} className="block rounded-lg border p-3 transition [a&]:hover:bg-slate-50">
                <p className="font-semibold">{job.jobNo} {job.description}</p>
                <p className="text-xs text-slate-500">{hasReworkTag(job) ? "Running, Rework tag" : stageLabel(job.stage)}{job.due ? ` · due ${fmtDate(job.due)}` : ""}</p>
              </MaybeLink>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <section className="grid gap-6 xl:grid-cols-3"><AttentionList role={role} /></section>
      <section className="grid gap-6 xl:grid-cols-2">
        <Card><CardHeader><CardTitle>Priority Jobs</CardTitle></CardHeader><CardContent className="space-y-3">
          {loading ? <p className="text-sm text-slate-500">Loading...</p> : null}
          {!loading && d?.priorityJobs && !d.priorityJobs.length ? <p className="text-sm text-slate-500">No unfinished jobs.</p> : null}
          {!loading && !d?.priorityJobs ? <p className="text-sm text-slate-500">{DASH}</p> : null}
          {(d?.priorityJobs ?? []).map((job) => <MaybeLink href={jobHref(job.id)} allowed={canOpen("/jobs")} key={job.id} className="block rounded-lg border p-4 transition [a&]:hover:bg-slate-50"><p className="font-semibold">{job.jobNo} {job.description}</p>{hasReworkTag(job) ? <StatusBadge status="rework" className="mt-2" /> : <Badge className="mt-2 bg-brand text-brand-ink">{stageOf(job.stage) ? stageLabel(job.stage) : "Workshop"}</Badge>}</MaybeLink>)}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Workshop Schedule This Week</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          {loading ? <p className="text-slate-500">Loading...</p> : null}
          {!loading && d?.bookings && !d.bookings.length ? <p className="text-slate-500">Nothing booked onto machines this week.</p> : null}
          {!loading && !d?.bookings ? <p className="text-slate-500">{DASH}</p> : null}
          {(d?.bookings ?? []).map((row) => <MaybeLink href="/schedule" allowed={canOpen("/schedule")} key={row.id} className="block rounded-lg bg-slate-50 p-3">{fmtDateTime(row.start)}: {row.machine} - {row.jobNo}</MaybeLink>)}
        </CardContent></Card>
      </section>
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
        <div><h1 className="page-title">Dashboard</h1><p className="mt-2 text-sm text-slate-500">{getGreeting(profile?.full_name)}. {new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }).format(new Date())}</p></div>
        {role === "admin" || role === "office" ? <ApprovalLink /> : null}
      </section>
      {role === "workshop" || role === "viewer" ? <WorkshopDashboard role={role} /> : role === "office" ? <AdminDashboard office /> : <AdminDashboard />}
    </div>
  );
}
