"use client";

import { Suspense } from "react";

import { DaySheet } from "@/components/time/day-sheet";

/** Weekly hours, Today tab (migrations 050, 051): clock in/out, breaks, the jobs worked and the time on each, totals. */
export default function WeeklyHoursTodayPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading your hours…</p>}>
      <DaySheet />
    </Suspense>
  );
}
