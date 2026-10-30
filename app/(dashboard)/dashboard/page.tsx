"use client";

import { AiHelperDashboardLink } from "@/components/ai-helper/dashboard-link";
import { loadAdminData } from "@/lib/dashboard-figures";
import { head, q, type AttentionItem } from "@/lib/dashboard-figures-legacy";
import { RUNNING_JOBS_FILTER, hasReworkTag, stageLabel, stageOf } from "@/lib/job-flow";
import { StatusBadge } from "@/components/status-badge";
import { StatTile, toneFromAccent } from "@/components/stat-tile";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Clock, FileText, Layers } from "lucide-react";
import { BarList, DueColumns, LightDot, Panel, PercentLine, RevenueLine, SplitBar } from "@/components/dashboard-charts";
import { TeamWeek } from "@/components/team-week";
import { OverviewJump, OverviewLeaks, OverviewSection } from "@/components/overview";
import { leaksFrom } from "@/lib/overview";
import { lights, type Light } from "@/lib/dashboard-analytics";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { dueWindow, fmtDate, fmtDateTime, fmtDueBy } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { attentionState } from "@/lib/attention";
import type { AttentionRole, AttentionSection } from "@/lib/attention-items";
import { loadAttention } from "@/lib/attention-load";
import { gbp } from "@/lib/money";
import { awaitingApproval } from "@/lib/approval-queue";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";
import { myJobs, type MyJob } from "@/lib/my-jobs";
import { useCanOpen } from "@/lib/use-destinations";
import { ColumnToggle } from "@/components/column-toggle";
import { dashboardTileKeysFor, kpiGridClass, statGridClass } from "@/lib/dashboard-tiles";
import { useColumnVisibility } from "@/lib/org-settings";

const DASH = "—";
const DAY_MS = 86_400_000;

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
    const mineRes = await q(supabase!.from("jobs").select("id, job_no, description, stage, date_required, due_date, finished_at, assigned_to").eq("assigned_to", userId).is("finished_at", null).order("date_required", { ascending: true, nullsFirst: false }).limit(200));
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
  const d = data;
  const revenueTotal = d?.revenue ? d.revenue.reduce((sum, row) => sum + row.revenue, 0) : null;
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
  const stats = ([
    ["this-month-revenue", "This month's revenue", money(d?.thisMonthRevenue, loading), "Payments received this month", "/invoices", "none"],
    ["quotes-sent", "Quotes sent", num(d?.quotesSentThisMonth, loading), "Sent this month", "/quotes", "none"],
    ["jobs-late-on-time", "Jobs late / on time", d && d.lateJobs !== null && d.onTimeJobs !== null ? `${d.lateJobs} / ${d.onTimeJobs}` : DASH, "Jobs not finished, by required date", "/jobs", d && d.lateJobs !== null ? (d.lateJobs ? "red" : "green") : "none"],
    ["avg-days-to-pay", "Average days to pay", d?.avgDaysToPay != null ? `${Math.round(d.avgDaysToPay)} days` : DASH, "Invoice date to final payment", "/invoices", lights.daysToPay(d?.avgDaysToPay ?? null)],
  ] as Array<[string, string, string, string, string, Light]>).filter(([key]) => isVisible(key));
  const showAttention = isVisible("needs-attention");
  const showPipeline = isVisible("quote-pipeline");
  const waiting = loading ? "Loading…" : "Couldn't load this.";
  const topRow = [!office && isVisible("revenue-trend"), !office && isVisible("money-by-age"), isVisible("quote-outcomes")].filter(Boolean).length;
  const opsRow = [isVisible("jobs-by-status"), isVisible("on-time-delivery"), isVisible("right-first-time")].filter(Boolean).length;
  const loadRow = [isVisible("machine-load"), isVisible("work-due"), !office && isVisible("top-customers")].filter(Boolean).length;
  const rowCols = (n: number) => (["", "", "lg:grid-cols-2", "lg:grid-cols-3"][n] ?? "");

  // Each panel is built once; the office view and the owner's Overview arrange them differently.
  const revenuePanel = (className?: string) => <Panel title="Revenue, last 6 months" meta={revenueTotal !== null ? `${gbp(revenueTotal, 0)} received` : undefined} href={canOpen("/invoices") ? "/invoices" : undefined} className={className}>
    {d?.revenue ? <RevenueLine data={d.revenue} /> : <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  const owedPanel = <Panel title="Money owed by age" meta={d?.moneyOwed != null ? gbp(d.moneyOwed, 0) : undefined} href={canOpen("/invoices") ? "/invoices" : undefined}>
    {d?.owedByAge && !d.owedByAge.some((b) => b.value > 0) ? <p className="py-6 text-center text-sm text-muted-foreground">Nothing owed.</p> : d?.owedByAge ? <div className="space-y-3"><SplitBar parts={d.owedByAge} /><ul className="divide-y divide-line/70">{d.owedByAge.map((b) => <li key={b.key} className="flex items-center gap-2 py-2 text-sm"><LightDot light={b.value > 0 ? b.light : "none"} /><span className="text-ink">{b.label}</span><span className="ml-auto font-semibold tabular-nums text-ink">{gbp(b.value, 0)}</span></li>)}</ul></div> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
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
  const machinePanel = <Panel title="Machine load this week" meta="Booked hours of available" href={canOpen("/schedule") ? "/schedule" : undefined}>
    {d?.machines ? <BarList rows={d.machines.map((m) => ({ key: m.id, label: m.name, value: m.percent, light: m.percent > 100 ? "red" as const : m.percent >= 85 ? "amber" as const : "green" as const }))} format={(v) => `${v}%`} empty="No machines booked this week." /> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  const workDuePanel = <Panel title="Work coming due" meta="Next 14 days" href={canOpen("/jobs") ? "/jobs" : undefined}>
    {d?.workDue ? <DueColumns data={d.workDue} /> : <p className="flex h-44 items-center justify-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  const customersPanel = <Panel title="Top customers" meta="Paid, last 6 months">
    {d?.customers ? <BarList rows={d.customers.map((c) => ({ key: c.customer, label: c.customer, value: c.value }))} format={(v) => gbp(v, 0)} empty="No paid invoices in the last 6 months." /> : <p className="py-6 text-center text-sm text-muted-foreground">{waiting}</p>}
  </Panel>;
  const pipelinePanel = (className?: string) => <MaybeLink href="/quotes" allowed={canOpen("/quotes")} className={className}><Card className={`h-full transition ${canOpen("/quotes") ? "cursor-pointer hover:bg-slate-50" : ""}`}><CardHeader><CardTitle>Quote pipeline</CardTitle></CardHeader><CardContent className="grid auto-rows-fr grid-cols-2 gap-3">{([["RFQs outstanding", pipe?.rfqs], ["Quotes awaiting reply", pipe?.quoted], ["Accepted", pipe?.accepted], ...(office ? [] : [["Invoices paid", pipe?.paid]])] as Array<[string, number | null | undefined]>).map(([label, value]) => (
    <div key={label} className="flex min-h-24 min-w-0 flex-col justify-between gap-2 rounded-lg bg-canvas p-3 text-ink"><span className="text-sm leading-tight text-muted-foreground">{label}</span><span className="text-2xl font-semibold leading-none tabular-nums">{num(value, loading)}</span></div>
  ))}</CardContent></Card></MaybeLink>;

  if (!office) {
    // The owner's Overview: what needs you today first, then how the business is doing, section by section (lib/overview).
    const showLeaks = isVisible("leaks");
    const kpiTile = (key: string) => shownKpis.filter(([k]) => k === key).map(([, tile]) => tile);
    const moneyTiles = [...kpiTile("money-owed"), ...statTiles(["this-month-revenue", "avg-days-to-pay"])];
    const moneyPanels = [isVisible("revenue-trend") && revenuePanel(), isVisible("money-by-age") && owedPanel, isVisible("top-customers") && customersPanel].filter(Boolean);
    const workTiles = [...kpiTile("open-jobs"), ...kpiTile("open-quotes"), ...statTiles(["quotes-sent", "jobs-late-on-time"])];
    const workPanels = [isVisible("quote-outcomes") && quotesPanel, isVisible("jobs-by-status") && jobsStatusPanel, isVisible("on-time-delivery") && onTimePanel, isVisible("right-first-time") && rftPanel, isVisible("work-due") && workDuePanel, showPipeline && pipelinePanel()].filter(Boolean);
    const machinePanels = [isVisible("machine-load") && machinePanel].filter(Boolean);
    const present = [
      (showLeaks || showAttention) && "today",
      (moneyTiles.length || moneyPanels.length) && "money",
      (workTiles.length || workPanels.length) && "work",
      machinePanels.length && "machines",
      isVisible("team-week") && "people",
    ].filter((s): s is string => typeof s === "string");
    const leaks = leaksFrom(attention.data, { rfqsToQuote: loading ? null : d?.rfqsToQuote ?? null, overdueOwed: loading ? null : overdueOwed, money: (v) => gbp(v, 0) }, attention.error !== null);
    const tileRow = (tiles: React.ReactNode[]) => tiles.length ? <div className={`grid gap-4 ${statGridClass(tiles.length)}`}>{tiles}</div> : null;
    const panelGrid = (panels: React.ReactNode[]) => panels.length ? <div className={`grid gap-4 ${rowCols(Math.min(panels.length, 3))}`}>{panels.map((p, i) => <div key={i} className="contents">{p}</div>)}</div> : null;
    return (
      <>
        {error ? <ErrorCard message={error} onRetry={retry} /> : null}
        <OverviewJump present={present} />
        {present.includes("today") ? <OverviewSection id="today" title="Today" sub="Where work and money are slipping, and what needs doing">
          {showLeaks ? <OverviewLeaks leaks={leaks} /> : null}
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
        {present.includes("machines") ? <OverviewSection id="machines" title="Machines" sub="How busy each machine is this week" href="/schedule" linkLabel="Machine schedule">
          {panelGrid(machinePanels)}
        </OverviewSection> : null}
        {present.includes("people") ? <OverviewSection id="people" title="People" sub="This week, from clock-ins · only admins see this" href="/time/week" linkLabel="Weekly hours">
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
      {isVisible("my-jobs") && d?.myJobs && d.myJobs.length ? (
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
        <div className="flex flex-wrap items-center gap-2">{role === "admin" || role === "office" ? <><AiHelperDashboardLink /><ApprovalLink /></> : null}<ColumnToggle tableKey="dashboard" keys={dashboardTileKeysFor(role === "office" ? "office" : role === "admin" ? "admin" : "workshop")} /></div>
      </section>
      {role === "workshop" || role === "viewer" ? <WorkshopDashboard role={role} /> : role === "office" ? <AdminDashboard office /> : <AdminDashboard />}
    </div>
  );
}
