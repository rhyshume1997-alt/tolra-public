"use client";

import { Suspense } from "react";

import { HoursRedesign } from "@/components/time/hours-redesign";
import { useCompanyUiSwitch } from "@/lib/use-company-ui-switch";

import { UnrecognisedNetworkBanner } from "@/components/time/unrecognised-network-banner";
import { WeekReview } from "@/components/time/week-review";

/** Weekly hours, This week tab: the week and its approval (migration 052). */
export default function WeeklyHoursWeekPage() {
  const redesign = useCompanyUiSwitch("ui-time-v2:on");
  if (redesign) return <HoursRedesign tab="week" />;

  return (
    <div className="space-y-4">
      <UnrecognisedNetworkBanner />
      <Suspense fallback={<p className="text-sm text-slate-500">Loading the week…</p>}>
        <WeekReview />
      </Suspense>
    </div>
  );
}
