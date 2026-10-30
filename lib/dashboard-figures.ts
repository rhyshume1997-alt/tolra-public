"use client";

/**
 * The admin and office dashboard's figures (E6, ISO 9001 item: the dashboard was slow). Migration 111's two read-only functions
 * (public.dashboard_work_figures, public.dashboard_money_figures, SECURITY INVOKER, so row-level security applies as to any read)
 * count and add up in the database what the page used to read row by row into the browser: two requests, a few hundred bytes back,
 * whatever the company's size, and no 20,000-row limit that blanks a figure.
 *
 * adminDataFrom turns their answer into exactly the AdminData the page already uses, with the same arithmetic as before (whole-percent
 * rounding, pence to pounds, labels and lights; machine load and work coming due through the same lib/dashboard-analytics functions).
 * Until 111 is applied the functions are missing and loadAdminData uses the old browser-side reads (lib/dashboard-figures-legacy.ts),
 * so the page works on either side of the release. Any other failure blanks only that half's figures (a dash), never fakes a number.
 */
import { AlertCircle } from "lucide-react";

import { machineLoad, workloadDue, type AgeBucket } from "@/lib/dashboard-analytics";
import { loadAdminData as loadAdminDataLegacy, monthKey, type AdminData, type AttentionItem } from "@/lib/dashboard-figures-legacy";
import { dueWindow, toDateInput } from "@/lib/dates";
import { missingDbObject } from "@/lib/db-features";
import { onTimeJobCount } from "@/lib/job-status";
import { supabase } from "@/lib/supabase";

const DAY_MS = 86_400_000;

/** public.dashboard_work_figures's answer (migration 111). Counts are whole numbers; pence are whole pence. */
export type WorkFigures = {
  quotes: { open_count: number; open_pence: number; accepted_count: number };
  quotes_90: { accepted: number; sent: number; expired: number; rejected: number; expired_sent: number };
  quotes_sent_this_month: number;
  rfqs_outstanding: number;
  jobs: { open: number; due_week: number; late: number; dated: number; not_started: number; running: number; waiting: number; overdue: number; due_soon: number };
  /** Open jobs coming due on each day (YYYY-MM-DD) of the next 14; days with none are left out. */
  due_days: Record<string, number>;
  /** Jobs finished in each month (YYYY-MM) of the six: those with a required date, and how many of them by it. */
  finished_by_month: Record<string, { dated: number; on_time: number }>;
  right_first_time: { jobs: number; passed: number };
  machines: Array<{ id: string; name: string | null; hours_per_day: number | null; working_days: number[] | null; booked: number }>;
  drafts: number;
};

/** public.dashboard_money_figures's answer (migration 111). */
export type MoneyFigures = {
  to_confirm: number;
  unpaid_count: number;
  owed_pence: number;
  owed_by_age: Record<AgeBucket["key"], number>;
  paid_count: number;
  days_to_pay: { sum: number; count: number };
  top_customers: Array<{ customer: string; pence: number }>;
  received_by_month: Record<string, number>;
};

/** The six months, oldest first, as the old reads' lastSixMonths (lib/dashboard-figures-legacy), for a given now. */
export function sixMonths(now: Date = new Date()): Array<{ key: string; month: string }> {
  const out: Array<{ key: string; month: string }> = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
    out.push({ key: monthKey(d.toISOString()), month: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "Europe/London" }).format(d) });
  }
  return out;
}

/** The dates the figures are counted over, worked out as the old reads did (UK today, the browser's Monday, the six months). */
export function dashboardDates(now: Date = new Date()) {
  const { today, end: weekEnd } = dueWindow(now);
  const months = sixMonths(now);
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return {
    today, weekEnd, months,
    since: `${months[0].key}-01`,
    monthStart: `${months[5].key}-01`,
    ninetyDaysAgo: toDateInput(new Date(now.getTime() - 90 * DAY_MS)),
    monday,
    sunday: new Date(monday.getTime() + 7 * DAY_MS),
    now: now.toISOString(),
  };
}
export type DashboardDates = ReturnType<typeof dashboardDates>;

export const workArgs = (d: DashboardDates) => ({
  p_today: d.today, p_week_end: d.weekEnd, p_since: d.since, p_month_start: d.monthStart, p_quotes_since: d.ninetyDaysAgo,
  p_week_start: d.monday.toISOString(), p_week_stop: d.sunday.toISOString(), p_now: d.now,
});
export const moneyArgs = (d: DashboardDates) => ({ p_today: d.today, p_since: d.since });

const AGE_BUCKETS: Array<Omit<AgeBucket, "value">> = [
  { key: "not_due", label: "Not due yet", light: "green" },
  { key: "late_1_30", label: "1–30 days late", light: "amber" },
  { key: "late_31_60", label: "31–60 days late", light: "red" },
  { key: "late_60_plus", label: "60+ days late", light: "red" },
];

const n = (value: unknown) => Number(value ?? 0) || 0;
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);

/** The page's AdminData from 111's answers (null: that half failed; money is never asked for on the office dashboard). Pure. */
export function adminDataFrom(work: WorkFigures | null, money: MoneyFigures | null, office: boolean, d: DashboardDates): AdminData {
  const attention: AttentionItem[] = [];
  if (money && n(money.to_confirm)) {
    const toConfirm = n(money.to_confirm);
    attention.push({ key: "inv-payment-to-confirm", title: `${toConfirm} imported invoice${toConfirm === 1 ? "" : "s"}: payment to confirm`, detail: "Record the payment or confirm it is still owed. Not counted as money owed until checked.", href: "/invoices", icon: AlertCircle });
  }
  const received = money?.received_by_month ?? {};
  const late = work ? n(work.jobs.late) : null;
  const dated = work ? n(work.jobs.dated) : null;
  const q90 = work?.quotes_90;
  const decided = q90 ? n(q90.accepted) + n(q90.rejected) + n(q90.expired_sent) : 0;
  // Work coming due and machine load go through the same functions as before, fed with what the database counted.
  const dueRows = work ? Object.entries(work.due_days ?? {}).flatMap(([date, count]) => Array.from({ length: n(count) }, () => ({ date_required: date }))) : [];
  const machines = work?.machines ?? [];
  return {
    openQuotes: work ? n(work.quotes.open_count) : null,
    pipelineValue: work ? n(work.quotes.open_pence) / 100 : null,
    moneyOwed: money ? n(money.owed_pence) / 100 : null,
    unpaidInvoices: money ? n(money.unpaid_count) : null,
    rfqsToQuote: work ? n(work.rfqs_outstanding) : null,
    openJobs: work ? n(work.jobs.open) : null,
    dueThisWeek: work ? n(work.jobs.due_week) : null,
    dueBy: d.weekEnd,
    revenue: money ? d.months.map((m) => ({ month: m.month, revenue: Math.round(n(received[m.key]) / 100) })) : null,
    thisMonthRevenue: money ? n(received[d.months[5].key]) / 100 : null,
    quotesSentThisMonth: work ? n(work.quotes_sent_this_month) : null,
    lateJobs: late,
    onTimeJobs: dated !== null && late !== null ? onTimeJobCount(dated, late) : null,
    avgDaysToPay: money && n(money.days_to_pay.count) ? n(money.days_to_pay.sum) / n(money.days_to_pay.count) : null,
    pipeline: {
      rfqs: work ? n(work.rfqs_outstanding) : null,
      quoted: work ? n(work.quotes.open_count) : null,
      accepted: work ? n(work.quotes.accepted_count) : null,
      paid: money ? n(money.paid_count) : null,
    },
    attention,
    attentionFailed: !office && money === null,
    draftEmails: work ? n(work.drafts) : null,
    owedByAge: money ? AGE_BUCKETS.map((b) => ({ ...b, value: n(money.owed_by_age[b.key]) / 100 })) : null,
    quotes90: q90 ? {
      outcomes: [
        { key: "accepted", label: "Accepted", count: n(q90.accepted) },
        { key: "sent", label: "Awaiting reply", count: n(q90.sent) },
        { key: "expired", label: "Expired", count: n(q90.expired) },
        { key: "rejected", label: "Rejected", count: n(q90.rejected) },
      ],
      winRate: percent(n(q90.accepted), decided),
    } : null,
    jobsStatus: work ? { notStarted: n(work.jobs.not_started), running: n(work.jobs.running), waiting: n(work.jobs.waiting), overdue: n(work.jobs.overdue), dueSoon: n(work.jobs.due_soon) } : null,
    onTime: work ? d.months.map(({ key, month }) => {
      const m = work.finished_by_month?.[key];
      return { month, percent: percent(n(m?.on_time), n(m?.dated)), finished: n(m?.dated) };
    }) : null,
    rft: work ? { percent: percent(n(work.right_first_time.passed), n(work.right_first_time.jobs)), jobs: n(work.right_first_time.jobs), failedFirst: n(work.right_first_time.jobs) - n(work.right_first_time.passed) } : null,
    machines: work ? machineLoad(
      machines.map((m) => ({ id: String(m.id), name: m.name, hours_per_day: m.hours_per_day == null ? null : Number(m.hours_per_day), working_days: m.working_days })),
      machines.map((m) => ({ machine_id: String(m.id), start_at: d.monday.toISOString(), estimated_hours: n(m.booked) })),
      d.monday,
    ) : null,
    workDue: work ? workloadDue(dueRows, d.today) : null,
    customers: money ? money.top_customers.map((c) => ({ customer: c.customer, value: n(c.pence) / 100 })) : null,
  };
}

type RpcError = { code?: string | null; message?: string | null };
/** What the loader needs from the Supabase client (an injected one keeps it testable). */
export type FiguresClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null }> };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A dashboard loader: 111's functions, or the old reads while the database doesn't have them. Once a call says they are missing,
 * this loader goes straight to the old reads (until the page is loaded again).
 */
export function createAdminDataLoader(deps: { client: () => FiguresClient | null; legacy: (office: boolean) => Promise<AdminData>; now?: () => Date }) {
  let missing = false;
  return async function load(office: boolean): Promise<AdminData> {
    const client = deps.client();
    if (missing || !client) return deps.legacy(office);
    const dates = dashboardDates(deps.now ? deps.now() : new Date());
    const call = async (fn: string, args: Record<string, unknown>) => {
      try {
        const { data, error } = await client.rpc(fn, args);
        if (error) return { missing: missingDbObject(error), data: null, error };
        return { missing: false, data: isObject(data) ? data : null, error: isObject(data) ? null : new Error(`${fn} returned no figures`) };
      } catch (error) {
        return { missing: false, data: null, error };
      }
    };
    const [work, money] = await Promise.all([
      call("dashboard_work_figures", workArgs(dates)),
      office ? Promise.resolve(null) : call("dashboard_money_figures", moneyArgs(dates)),
    ]);
    if (work.missing || money?.missing) {
      missing = true;
      return deps.legacy(office);
    }
    for (const result of [work, money]) if (result?.error) console.error(result.error);
    return adminDataFrom(work.data as WorkFigures | null, (money?.data ?? null) as MoneyFigures | null, office, dates);
  };
}

/** The page's loader (app/(dashboard)/dashboard/page.tsx). */
export const loadAdminData = createAdminDataLoader({ client: () => supabase as unknown as FiguresClient | null, legacy: loadAdminDataLegacy });
