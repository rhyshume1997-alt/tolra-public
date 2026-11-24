"use client";

/** Reports period, retry and read lifecycle. Takes member section restrictions and returns the read-only report data and controls. */
import { useEffect, useState } from "react";
import { loadReports, type ReportsData } from "@/lib/reports/load-reports";
import { supabase } from "@/lib/supabase";

export const REPORT_PERIODS = [3, 6, 12] as const;

export function useReportsData(hiddenSections: readonly string[]) {
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((n) => n + 1);
  const [months, setMonths] = useState<number>(12);
  const [data, setData] = useState<ReportsData | null>(null);
  const hiddenKey = hiddenSections.join(",");

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    setData(null);
    void loadReports(supabase, { months, hiddenSections: hiddenKey ? hiddenKey.split(",") : [] }).then((next) => { if (!cancelled) setData(next); });
    return () => { cancelled = true; };
  }, [months, hiddenKey, attempt]);

  return { data, months, setMonths, retry };
}
