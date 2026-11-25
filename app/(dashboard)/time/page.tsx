"use client";

import { Suspense } from "react";

import { HoursRedesign } from "@/components/time/hours-redesign";
import { useCompanyUiSwitch } from "@/lib/use-company-ui-switch";

import { DaySheet } from "@/components/time/day-sheet";
import { UnrecognisedNetworkBanner } from "@/components/time/unrecognised-network-banner";

/** Weekly hours, Today tab (migrations 050, 051): clock in/out, breaks, the jobs worked and the time on each, totals. */
export default function WeeklyHoursTodayPage() {
  const redesign = useCompanyUiSwitch("ui-time-v2:on");
  if (redesign) return <HoursRedesign tab="today" />;

  return (
    <div className="space-y-4">
      <UnrecognisedNetworkBanner />
      <Suspense fallback={<p className="text-sm text-slate-500">Loading your hours…</p>}>
        <DaySheet />
      </Suspense>
    </div>
  );
}
