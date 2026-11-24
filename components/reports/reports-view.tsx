"use client";

/**
 * The operations reports body: a period picker (state only) and the four cards. Inputs: the signed-in person's hidden sections. Outputs: the
 * cards. Reads through lib/reports/load-reports (SELECT only), re-reading when the period changes or Retry is pressed. A card whose data needs a
 * hidden section shows a notice, a failed read shows one muted line with a Retry button (re-reads all four cards), a capped read says
 * "may be incomplete". When the Revenue report is on for this person, a link to it is shown. No costs are shown anywhere.
 * Must not change: it writes nothing and holds no business rule (those are in lib/reports/*).
 */
import Link from "next/link";

import { MachineHoursCard } from "@/components/reports/machine-hours-card";
import { NcrTrendCard } from "@/components/reports/ncr-trend-card";
import { OnTimeCard } from "@/components/reports/on-time-card";
import { WipAgeingCard } from "@/components/reports/wip-ageing-card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDateTime } from "@/lib/dates";
import { useOrgSettings } from "@/lib/org-settings";
import type { ReportCard } from "@/lib/reports/load-reports";
import { canSeeRevenue, revenueEnabled } from "@/lib/reports/revenue/revenue-switch";
import { REPORT_PERIODS, useReportsData } from "@/lib/reports/use-reports-data";
import { MEMBER_SECTIONS } from "@/lib/sections";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

const MAYBE_INCOMPLETE = "This may be incomplete: more records exist than were read. Choose a shorter period.";

const sectionLabel = (key: string) => MEMBER_SECTIONS.find((s) => s.key === key)?.label ?? key;

function Frame<T>({ title, testId, card, onRetry, children }: { title: string; testId: string; card: ReportCard<T> | undefined; onRetry: () => void; children: (data: T) => React.ReactNode }) {
  return (
    <section data-testid={testId} className="border border-line bg-surface">
      <header className="border-b border-line px-4 py-3"><h2 className="text-[0.95rem] font-semibold text-ink">{title}</h2></header>
      <div className="space-y-3 px-4 py-3">
        {!card ? <Skeleton className="h-40" />
          : card.state === "hidden" ? <p data-testid="report-hidden" className="text-sm text-slate-500">Not shown: {card.sections.map(sectionLabel).join(" and ")} {card.sections.length > 1 ? "are" : "is"} hidden for you.</p>
          : card.state === "error" ? <p data-testid="report-error" className="flex flex-wrap items-center gap-3 text-sm text-slate-500">This report can&apos;t be read right now.
            <button type="button" data-testid="report-retry" onClick={onRetry} className="h-8 border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-muted">Retry</button></p>
          : (
            <>
              {children(card.data)}
              {card.note ? <p className="text-xs text-slate-500">{card.note}</p> : null}
              {card.truncated ? <p data-testid="report-incomplete" className="text-xs text-amber-700">{MAYBE_INCOMPLETE}</p> : null}
            </>
          )}
      </div>
    </section>
  );
}

export function ReportsView() {
  const { hiddenSections, activeRole } = useUser();
  const { hiddenNav } = useOrgSettings();
  const { data, months, setMonths, retry } = useReportsData(hiddenSections);

  if (!supabase) return <p className="text-sm text-slate-500">Reports are not available in this mode.</p>;

  return (
    <div data-testid="reports-view" className="space-y-6">
      <div>
        <h1 className="page-title">Reports</h1>
        <p className="mt-2 text-sm text-slate-500">Read-only operations reports. Dates are UK time. No costs are shown here: these reports count jobs, hours and records only.</p>
      </div>
      {canSeeRevenue(activeRole) && revenueEnabled(hiddenNav) ? <p className="text-sm"><Link data-testid="reports-revenue-link" href="/reports/revenue" className="font-semibold underline">Revenue report</Link></p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Period<br />
          <select className="min-h-11 rounded-md border border-input bg-background px-3 text-sm" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {REPORT_PERIODS.map((m) => <option key={m} value={m}>Last {m} months</option>)}
          </select>
        </label>
        {data ? <span data-testid="reports-calculated-at" className="text-xs text-slate-500">Calculated {fmtDateTime(data.calculatedAt)} (UK time)</span> : null}
      </div>
      <Frame onRetry={retry} title="On-time completion" testId="report-on-time" card={data?.onTime}>{(d) => <OnTimeCard data={d} />}</Frame>
      <Frame onRetry={retry} title="Work in progress ageing" testId="report-wip" card={data?.wip}>{(d) => <WipAgeingCard data={d} />}</Frame>
      <Frame onRetry={retry} title="Machine hours: planned vs actual" testId="report-machines" card={data?.machines}>{(d) => <MachineHoursCard data={d} />}</Frame>
      <Frame onRetry={retry} title="NCR trend" testId="report-ncr" card={data?.ncr}>{(d) => <NcrTrendCard data={d} />}</Frame>
    </div>
  );
}
