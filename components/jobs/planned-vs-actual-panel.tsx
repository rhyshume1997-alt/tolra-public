"use client";

/**
 * Planned vs actual machine time per step, on a job's worksheet. READ-ONLY figures from the job's plan and its machine runs; it never
 * writes anything. Renders nothing unless the company switched it on (hidden_nav marker), the role is admin or office, the app is not
 * in demo mode and Supabase is configured: with the switch off the worksheet looks exactly as before.
 *
 * Inputs: the job id and whether the job is finished (signed off). Output: a small table. A read failure shows one muted line and never
 * blocks or throws into the worksheet.
 * Must not change: it must stay read-only; the switch and role rule live in lib/jobs/planned-vs-actual-switch.ts.
 */
import { useEffect, useState } from "react";

import { DEMO_MODE } from "@/lib/demo";
import { type PlannedVsActual, type Step, type StepStatus } from "@/lib/jobs/planned-vs-actual";
import { loadPlannedVsActual } from "@/lib/jobs/load-planned-vs-actual";
import { canSeePlannedVsActual, plannedVsActualEnabled } from "@/lib/jobs/planned-vs-actual-switch";
import { useOrgSettings } from "@/lib/org-settings";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

const STATUS_TEXT: Record<StepStatus, string> = { over: "Over plan", under: "Under plan", on_plan: "On plan", not_started: "Not started", no_plan: "No plan" };
const hours = (value: number | null) => (value == null ? "-" : value.toFixed(2));
const signed = (value: number | null) => (value == null ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`);

export function PlannedVsActualPanel({ jobId, jobFinished }: { jobId: string; jobFinished: boolean }) {
  const { hiddenNav } = useOrgSettings();
  const { activeRole } = useUser();
  const show = plannedVsActualEnabled(hiddenNav) && canSeePlannedVsActual(activeRole) && !DEMO_MODE && isSupabaseConfigured;
  const [data, setData] = useState<PlannedVsActual | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!show || !supabase) return;
    let active = true;
    setData(null);
    setFailed(false);
    loadPlannedVsActual(supabase, jobId, jobFinished)
      .then((result) => { if (active) setData(result); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
    // Loads once per job (and once the switch/role allow it); finishing the job later doesn't reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, jobId]);

  if (!show) return null;
  if (failed) return <p className="text-xs text-muted-foreground" data-testid="planned-vs-actual">Planned vs actual can&apos;t be read right now.</p>;
  if (!data) return <p className="text-xs text-muted-foreground" data-testid="planned-vs-actual">Loading planned vs actual…</p>;

  const row = (step: Step) => (
    <tr key={step.key} data-testid="pva-step" className="border-t border-black/20">
      <td className="px-1.5 py-1">{step.label}{step.running ? <span className="ml-1.5 rounded bg-emerald-100 px-1 text-[10px] font-semibold text-emerald-800">Running</span> : null}</td>
      <td className="px-1.5 py-1 text-right">{hours(step.plannedHours)}</td>
      <td className="px-1.5 py-1 text-right">{hours(step.actualHours)}</td>
      <td className="px-1.5 py-1 text-right">{signed(step.varianceHours)}</td>
      <td className={`px-1.5 py-1 ${step.status === "over" ? "font-semibold text-[#c00000]" : ""}`}>{STATUS_TEXT[step.status]}</td>
    </tr>
  );

  return (
    <div className="border border-black bg-white text-xs text-black" data-testid="planned-vs-actual">
      <div className="bg-[#cfd9e8] px-2 py-1 text-[10px] font-bold uppercase">Planned vs actual time (read-only, from machine runs)</div>
      <table className="w-full">
        <thead>
          <tr className="text-left text-[10px] uppercase text-slate-700">
            <th className="px-1.5 py-1">Step</th><th className="px-1.5 py-1 text-right">Planned (h)</th><th className="px-1.5 py-1 text-right">Actual (h)</th>
            <th className="px-1.5 py-1 text-right">Variance (h)</th><th className="px-1.5 py-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {data.steps.length ? data.steps.map(row) : <tr><td colSpan={5} className="px-1.5 py-1 text-slate-600">No machines or runs on this job yet.</td></tr>}
          <tr className="border-t border-black font-semibold">
            <td className="px-1.5 py-1">Total (machines)</td>
            <td className="px-1.5 py-1 text-right">{hours(data.machinePlannedHours)}</td>
            <td className="px-1.5 py-1 text-right">{hours(data.machineActualHours)}</td>
            <td className="px-1.5 py-1 text-right">{signed(data.machineVarianceHours)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="border-t border-black/20 px-2 py-1 text-slate-700">Bench: {hours(data.benchActualHours)} h · People time on the job: {hours(data.labourActualHours)} h</p>
    </div>
  );
}
