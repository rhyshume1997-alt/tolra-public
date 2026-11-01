"use client";

import { Suspense } from "react";

import { UnrecognisedNetworkBanner } from "@/components/time/unrecognised-network-banner";
import { WeekReview } from "@/components/time/week-review";

/** Weekly hours, This week tab: the week and its approval (migration 052). */
export default function WeeklyHoursWeekPage() {
  return (
    <div className="space-y-4">
      <UnrecognisedNetworkBanner />
      <Suspense fallback={<p className="text-sm text-slate-500">Loading the week…</p>}>
        <WeekReview />
      </Suspense>
    </div>
  );
}
