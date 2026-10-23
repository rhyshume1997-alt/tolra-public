"use client";

import { Suspense } from "react";

import { WeekReview } from "@/components/time/week-review";

/** Weekly hours, This week tab: the week and its approval (migration 052). */
export default function WeeklyHoursWeekPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading the week…</p>}>
      <WeekReview />
    </Suspense>
  );
}
