"use client";

/** Weekly hours presentation. Uses the same day and week sheets, role checks, reads, approvals and exports. */
import { Suspense } from "react";

import { DaySheet } from "@/components/time/day-sheet";
import { UnrecognisedNetworkBanner } from "@/components/time/unrecognised-network-banner";
import { WeekReview } from "@/components/time/week-review";
import { LoadingState, premiumTokens } from "@/components/ui/premium";

export function HoursRedesign({ tab }: { tab: "today" | "week" }) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="time-v2">
      <UnrecognisedNetworkBanner />
      <Suspense fallback={<LoadingState label={tab === "today" ? "Loading your hours" : "Loading the week"} />}>
        {tab === "today" ? <DaySheet redesign /> : <WeekReview redesign />}
      </Suspense>
    </div>
  );
}
