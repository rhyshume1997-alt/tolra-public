"use client";

/** Live operations Reports layout. Uses the existing reports loader, permission checks and report cards with their exports. */
import Link from "next/link";
import type { ReactNode } from "react";

import { MachineHoursCard } from "@/components/reports/machine-hours-card";
import { NcrTrendCard } from "@/components/reports/ncr-trend-card";
import { OnTimeCard } from "@/components/reports/on-time-card";
import { WipAgeingCard } from "@/components/reports/wip-ageing-card";
import { Callout, FailedState, LoadingState, PageHeader, Panel, SegmentedControl, premiumTokens } from "@/components/ui/premium";
import { fmtDateTime } from "@/lib/dates";
import { useOrgSettings } from "@/lib/org-settings";
import type { ReportCard } from "@/lib/reports/load-reports";
import { canSeeRevenue, revenueEnabled } from "@/lib/reports/revenue/revenue-switch";
import { REPORT_PERIODS, useReportsData } from "@/lib/reports/use-reports-data";
import { MEMBER_SECTIONS } from "@/lib/sections";
import { useUser } from "@/lib/use-user";

const periodOptions = REPORT_PERIODS.map((months) => ({ value: String(months), label: `Last ${months} months` }));

function ReportPanel<T>({ title, card, retry, children }: {
  title: string;
  card?: ReportCard<T>;
  retry: () => void;
  children: (data: T) => ReactNode;
}) {
  return (
    <Panel title={title} busy={!card} className="min-w-0">
      {!card && <LoadingState label={`Loading ${title.toLowerCase()}`} />}
      {card?.state === "hidden" && (
        <Callout tone="neutral">
          Not shown: {card.sections.map((key) => MEMBER_SECTIONS.find((section) => section.key === key)?.label ?? key).join(" and ")} {card.sections.length > 1 ? "are" : "is"} hidden for you.
        </Callout>
      )}
      {card?.state === "error" && (
        <FailedState title="Couldn’t read this report" detail="Try loading the reports again." onRetry={retry} retryLabel="Retry" />
      )}
      {card?.state === "ok" && (
        <div className="space-y-3">
          {children(card.data)}
          {card.note && <Callout tone="neutral">{card.note}</Callout>}
          {card.truncated && <Callout tone="warn">This may be incomplete: more records exist than were read. Choose a shorter period.</Callout>}
        </div>
      )}
    </Panel>
  );
}

export function ReportsRedesign() {
  const { activeRole, hiddenSections } = useUser();
  const { hiddenNav } = useOrgSettings();
  const { data, months, setMonths, retry } = useReportsData(hiddenSections);

  return (
    <div className={`${premiumTokens} min-w-0 space-y-5`} data-testid="reports-view-v2">
      <PageHeader
        title="Reports"
        description="Read-only operations reports. Dates are UK time. No costs are shown here."
        actions={canSeeRevenue(activeRole) && revenueEnabled(hiddenNav) ? (
          <Link href="/reports/revenue" className="inline-flex min-h-12 items-center font-semibold underline">Revenue report</Link>
        ) : undefined}
      />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <SegmentedControl label="Period" value={String(months)} options={periodOptions} onChange={(value) => setMonths(Number(value))} />
        {data && <p className="text-xs text-slate-500">Calculated {fmtDateTime(data.calculatedAt)} (UK time)</p>}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        <ReportPanel title="On-time completion" card={data?.onTime} retry={retry}>{(report) => <OnTimeCard data={report} />}</ReportPanel>
        <ReportPanel title="Work in progress ageing" card={data?.wip} retry={retry}>{(report) => <WipAgeingCard data={report} />}</ReportPanel>
        <ReportPanel title="Machine hours: planned vs actual" card={data?.machines} retry={retry}>{(report) => <MachineHoursCard data={report} />}</ReportPanel>
        <ReportPanel title="NCR trend" card={data?.ncr} retry={retry}>{(report) => <NcrTrendCard data={report} />}</ReportPanel>
      </div>
    </div>
  );
}
