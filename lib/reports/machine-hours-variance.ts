/**
 * Planned vs actual machine hours per machine, from the per-machine totals Jobs already makes (sumStepsByMachine). Variance = actual - planned
 * (hours, 2 dp). Over / under uses the same tolerance as the job worksheet (OVER_PLAN_TOLERANCE): over when actual is more than planned x (1 + tolerance),
 * under when less than planned x (1 - tolerance), else on plan. A machine with planned 0 shows its actual only: it has no percentage and is left out
 * of the overall percentage (its hours are still in the hour totals). There is no cost anywhere here.
 *
 * Inputs: MachineTotal[]. Outputs: one row per machine and a total. Must not change: the tolerance (it is Jobs'). Pure (no React, no I/O).
 */
import { OVER_PLAN_TOLERANCE } from "@/lib/jobs/planned-vs-actual";
import type { MachineTotal } from "@/lib/jobs/planned-vs-actual";

export type MachineVarianceStatus = "over" | "under" | "on_plan" | "no_plan";
export type MachineVarianceRow = { machineId: string; label: string; plannedHours: number; actualHours: number; varianceHours: number | null; variancePercent: number | null; status: MachineVarianceStatus };
export type MachineVarianceReport = { rows: MachineVarianceRow[]; plannedHours: number; actualHours: number; varianceHours: number; plannedMachinesPercent: number | null };

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function machineHoursVariance(totals: readonly MachineTotal[]): MachineVarianceReport {
  const rows = totals.map<MachineVarianceRow>((t) => {
    if (!(t.planned > 0)) return { machineId: t.machineId, label: t.label, plannedHours: t.planned, actualHours: t.actual, varianceHours: null, variancePercent: null, status: "no_plan" };
    const variance = round2(t.actual - t.planned);
    const status: MachineVarianceStatus = t.actual > t.planned * (1 + OVER_PLAN_TOLERANCE) ? "over" : t.actual < t.planned * (1 - OVER_PLAN_TOLERANCE) ? "under" : "on_plan";
    return { machineId: t.machineId, label: t.label, plannedHours: t.planned, actualHours: t.actual, varianceHours: variance, variancePercent: round1((variance / t.planned) * 100), status };
  });
  const planned = rows.filter((r) => r.status !== "no_plan");
  const plannedSum = planned.reduce((s, r) => s + r.plannedHours, 0);
  const actualOnPlanned = planned.reduce((s, r) => s + r.actualHours, 0);
  return {
    rows,
    plannedHours: round2(rows.reduce((s, r) => s + r.plannedHours, 0)),
    actualHours: round2(rows.reduce((s, r) => s + r.actualHours, 0)),
    varianceHours: round2(rows.reduce((s, r) => s + r.actualHours, 0) - rows.reduce((s, r) => s + r.plannedHours, 0)),
    plannedMachinesPercent: plannedSum > 0 ? round1(((actualOnPlanned - plannedSum) / plannedSum) * 100) : null,
  };
}
