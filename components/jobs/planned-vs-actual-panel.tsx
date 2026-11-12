"use client";

/**
 * Planned vs actual machine time per step, on a job's worksheet. READ-ONLY figures from the job's plan and its machine runs; it never
 * writes anything. Renders nothing unless the company switched it on (hidden_nav marker), the role is admin or office, the app is not
 * in demo mode and Supabase is configured: with the switch off the worksheet looks exactly as before.
 *
 * Figures are a snapshot taken when the worksheet opened (calculatedAt is shown).
 * Inputs: the job id (whether the job is finished is read from jobs.finished_at). Output: a small table. A read failure shows one muted line and never
 * blocks or throws into the worksheet.
 * Unplanned machine time (machines not on the plan) sits under its own heading, counts in the total and is never added to a planned
 * machine. If a read hit its safety cap the panel says the figures may be incomplete (never silent).
 * Must not change: it must stay read-only; the switch and role rule live in lib/jobs/planned-vs-actual-switch.ts.
 */
import { useEffect, useState } from "react";

import { fmtDateText, fmtTime } from "@/lib/dates";
import { DEMO_MODE } from "@/lib/demo";
import { MAX_LIST_ROWS } from "@/lib/fetch-all";
import { type PlannedVsActual, type Step, type StepStatus, UNPLANNED_LABEL } from "@/lib/jobs/planned-vs-actual";
import { loadPlannedVsActual } from "@/lib/jobs/load-planned-vs-actual";
import { canSeePlannedVsActual, plannedVsActualEnabled } from "@/lib/jobs/planned-vs-actual-switch";
import { useOrgSettings } from "@/lib/org-settings";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

const STATUS_TEXT: Record<StepStatus, string> = { over: "Over plan", under: "Under plan", on_plan: "On plan", not_started: "Not started", no_plan: "No plan" };
const hours = (value: number | null) => (value == null ? "-" : value.toFixed(2));
/** "Calculated at 14:05 on 21 Oct 2026 (UK time)": London time, with the month as a word whatever date format the person chose. */
const calculatedText = (iso: string) => `Calculated at ${fmtTime(iso)} on ${fmtDateText(iso, { year: true }, "dmy-short")} (UK time)`;
const signed = (value: number | null) => (value == null ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`);
export const UNPLANNED_HEADING = `${UNPLANNED_LABEL} (machines not on this job's plan; counted in the total, not against any planned machine)`;
export const unplannedInTotalText = (value: number) => `Total actual includes ${hours(value)} h of unplanned machine time.`;
export const INCOMPLETE_TEXT = `These figures may be incomplete: this job has too many records to read in full (the limit is ${MAX_LIST_ROWS.toLocaleString("en-GB")} of each kind), so some may be missing.`;

export function PlannedVsActualPanel({ jobId }: { jobId: string }) {
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
    loadPlannedVsActual(supabase, jobId)
      .then((result) => { if (active) setData(result); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
    // Loads once per job (and once the switch/role allow it); figures are as at opening the worksheet.
  }, [show, jobId]);

  if (!show) return null;
  if (failed) return <p className="text-xs text-muted-foreground" data-testid="planned-vs-actual">Planned vs actual can&apos;t be read right now.</p>;
  if (!data) return <p className="text-xs text-muted-foreground" data-testid="planned-vs-actual">Loading planned vs actual…</p>;
  return <PlannedVsActualTable data={data} />;
}

/** The figures themselves (no reads, no switch): exported so the rendering can be unit tested. */
export function PlannedVsActualTable({ data }: { data: PlannedVsActual }) {
  const planned = data.steps.filter((step) => step.onPlan);
  const unplanned = data.steps.filter((step) => !step.onPlan && !step.isBench);
  const bench = data.steps.filter((step) => step.isBench);
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
      <div className="bg-[#cfd9e8] px-2 py-1 text-[10px] font-bold uppercase">Planned vs actual machine time (read-only, from machine runs)</div>
      {data.truncated ? <p className="px-2 pt-1 font-semibold text-[#c00000]" data-testid="pva-incomplete">{INCOMPLETE_TEXT}</p> : null}
      <p className="px-2 pt-1 text-slate-600">Each row is a machine on this job&apos;s plan, not an individual operation.</p>
      <table className="w-full">
        <thead>
          <tr className="text-left text-[10px] uppercase text-slate-700">
            <th className="px-1.5 py-1">Machine (job step)</th><th className="px-1.5 py-1 text-right">Planned (h)</th><th className="px-1.5 py-1 text-right">Actual (h)</th>
            <th className="px-1.5 py-1 text-right">Variance (h)</th><th className="px-1.5 py-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {data.steps.length ? null : <tr><td colSpan={5} className="px-1.5 py-1 text-slate-600">No machines or runs on this job yet.</td></tr>}
          {planned.map(row)}
          {unplanned.length ? <tr data-testid="pva-unplanned" className="border-t border-black/20"><td colSpan={5} className="px-1.5 py-1 font-semibold">{UNPLANNED_HEADING}</td></tr> : null}
          {unplanned.map(row)}
          {bench.map(row)}
          <tr className="border-t border-black font-semibold">
            <td className="px-1.5 py-1">Total (machines)</td>
            <td className="px-1.5 py-1 text-right">{hours(data.machinePlannedHours)}</td>
            <td className="px-1.5 py-1 text-right">{hours(data.machineActualHours)}</td>
            <td className="px-1.5 py-1 text-right">{signed(data.machineVarianceHours)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      {unplanned.length ? <p className="border-t border-black/20 px-2 py-1 text-slate-700" data-testid="pva-unplanned-total">{unplannedInTotalText(data.unplannedActualHours)}</p> : null}
      <p className="border-t border-black/20 px-2 py-1 text-slate-700">Bench: {hours(data.benchActualHours)} h · People time on the job: {hours(data.labourActualHours)} h</p>
      <p className="border-t border-black/20 px-2 py-1 text-slate-600" data-testid="pva-calculated-at">{calculatedText(data.calculatedAt)}</p>
    </div>
  );
}
