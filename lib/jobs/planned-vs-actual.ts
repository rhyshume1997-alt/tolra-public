/**
 * Planned vs actual machine time per step for one job. Read-only figures worked out from the job's plan (jobMachineEntries over
 * job_machines + machine_bookings) and its machine runs (machine_runs) and job time (operator_sessions).
 *
 * Inputs: the plan entries, the runs, the labour sessions, a machine-name lookup, whether the job is finished, and `now` (injected).
 * Outputs: steps, totals, bench and labour hours. Hours are rounded to 2 dp in the output only; sums are kept raw internally.
 * Unplanned machine time (runs on a machine not on the job's plan) counts in the machine total, is reported on its own
 * (unplannedActualHours, steps with onPlan false) and is never added to a planned machine's actual or variance (PM ruling 12 Nov).
 * Must not change: the named definitions below without Rhys/PM sign-off. Pure (no React, no I/O, no clock of its own).
 */
import type { JobMachineEntry } from "@/lib/job-machine-plan";

/** Over plan when actual exceeds planned by more than this fraction (exactly +10% is still on plan). Under plan uses the same band. */
export const OVER_PLAN_TOLERANCE = 0.1;
/** Label of the step that holds runs with no machine (bench runs, migration 046). */
export const BENCH_STEP_LABEL = "Bench";
/** Suffix for a machine that has runs but is not on the job's plan. */
export const NOT_ON_PLAN_SUFFIX = "Not on plan";
/** Heading for the machines that have runs but are not on the job's plan. */
export const UNPLANNED_LABEL = "Unplanned machine time";

export type StepStatus = "not_started" | "over" | "under" | "on_plan" | "no_plan";
export type RunRow = { machine_id: string | null; started_at: string; ended_at: string | null };
export type LabourRow = { started_at: string; ended_at: string | null; voided_at?: string | null };
export type PlanEntry = Pick<JobMachineEntry, "machineId" | "hours">;

export type Step = {
  key: string;
  label: string;
  machineId: string | null;
  isBench: boolean;
  onPlan: boolean;
  plannedHours: number | null;
  actualHours: number;
  running: boolean;
  varianceHours: number | null;
  variancePct: number | null;
  status: StepStatus;
};
export type PlannedVsActual = {
  steps: Step[];
  machinePlannedHours: number;
  machineActualHours: number;
  machineVarianceHours: number;
  /** Run time on machines that are not on the job's plan. Included in machineActualHours; never in a planned machine's figures. */
  unplannedActualHours: number;
  benchActualHours: number;
  /** People time (operator sessions, voided excluded). Has no plan. */
  labourActualHours: number;
  /** The injected `now` the figures were worked out at (ISO). The figures are a snapshot; open runs count to this instant. */
  calculatedAt: string;
  /** True when a read hit its safety cap, so some rows may be missing: the panel must say so (never silent). */
  truncated: boolean;
};

const HOUR_MS = 3_600_000;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Milliseconds of one span; an open span runs to `now`. 0 for an invalid, zero or negative span. */
function spanMs(startedAt: string, endedAt: string | null, now: Date): number {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return end > start ? end - start : 0;
}

/** Labour hours: voided sessions excluded, an open session counts to `now`. */
export function labourHours(rows: LabourRow[], now: Date): number {
  let ms = 0;
  for (const row of rows) if (!row.voided_at) ms += spanMs(row.started_at, row.ended_at, now);
  return round2(ms / HOUR_MS);
}

/** The status of one step. `under` needs the job to be finished (an unfinished job is not "under" yet). */
export function stepStatus(planned: number | null, actual: number, jobFinished: boolean): StepStatus {
  if (planned == null || planned <= 0) return actual > 0 ? "no_plan" : "on_plan";
  if (actual <= 0) return "not_started";
  if (actual > planned * (1 + OVER_PLAN_TOLERANCE)) return "over";
  if (jobFinished && actual < planned * (1 - OVER_PLAN_TOLERANCE)) return "under";
  return "on_plan";
}

export function plannedVsActual(input: {
  entries: PlanEntry[];
  runs: RunRow[];
  labour: LabourRow[];
  machineNames: ReadonlyMap<string, string>;
  jobFinished: boolean;
  now: Date;
  truncated?: boolean;
}): PlannedVsActual {
  const { entries, runs, labour, machineNames, jobFinished, now, truncated = false } = input;
  const name = (id: string) => machineNames.get(id) || "Machine";

  // Raw run time per machine (null key = bench) and whether any run is still open. Runs carry no plan-row id, so actual can
  // only be matched per machine.
  const actualMs = new Map<string | null, number>();
  const open = new Set<string | null>();
  for (const run of runs) {
    const ms = spanMs(run.started_at, run.ended_at, now);
    if (ms <= 0) continue;
    const key = run.machine_id || null;
    actualMs.set(key, (actualMs.get(key) ?? 0) + ms);
    if (!run.ended_at) open.add(key);
  }

  // Plan, in plan order. A machine on the plan twice is summed into ONE step (for the same reason: actual is per machine).
  const plannedBy = new Map<string, number>();
  for (const entry of entries) plannedBy.set(entry.machineId, (plannedBy.get(entry.machineId) ?? 0) + (Number(entry.hours) || 0));

  const make = (machineId: string | null, label: string, onPlan: boolean, planned: number | null): Step => {
    const actual = (actualMs.get(machineId) ?? 0) / HOUR_MS;
    const variance = planned == null ? null : actual - planned;
    return {
      key: machineId ?? "bench", label, machineId, isBench: machineId === null, onPlan,
      plannedHours: planned == null ? null : round2(planned),
      actualHours: round2(actual),
      running: open.has(machineId),
      varianceHours: variance == null ? null : round2(variance),
      variancePct: variance == null || !planned ? null : round2(variance / planned),
      status: machineId === null ? stepStatus(null, actual, jobFinished) : stepStatus(planned, actual, jobFinished),
    };
  };

  const steps: Step[] = [];
  let plannedSum = 0;
  let actualSum = 0;
  let unplannedSum = 0;
  for (const [machineId, planned] of plannedBy) {
    steps.push(make(machineId, name(machineId), true, planned));
    plannedSum += planned;
    actualSum += actualMs.get(machineId) ?? 0;
  }
  for (const machineId of [...actualMs.keys()].filter((id): id is string => id !== null && !plannedBy.has(id))) {
    steps.push(make(machineId, `${name(machineId)} (${NOT_ON_PLAN_SUFFIX})`, false, null));
    unplannedSum += actualMs.get(machineId) ?? 0;
  }
  actualSum += unplannedSum;
  const benchMs = actualMs.get(null) ?? 0;
  if (benchMs > 0) steps.push(make(null, BENCH_STEP_LABEL, false, null));

  return {
    steps,
    machinePlannedHours: round2(plannedSum),
    machineActualHours: round2(actualSum / HOUR_MS),
    machineVarianceHours: round2(actualSum / HOUR_MS - plannedSum),
    unplannedActualHours: round2(unplannedSum / HOUR_MS),
    benchActualHours: round2(benchMs / HOUR_MS),
    labourActualHours: labourHours(labour, now),
    calculatedAt: now.toISOString(),
    truncated,
  };
}

export type MachineTotal = { machineId: string; label: string; planned: number; actual: number };

/**
 * Per-machine planned and actual hours over many jobs' results, for reports. Bench is left out. A machine that ran but was not on a job's plan
 * counts with 0 planned for that job (its "Not on plan" step), so unplanned time never lands on a planned machine of the same job. Hours are summed
 * from each step's figures and rounded to 2 dp once at the end. Sorted by label, then machine id. Does not change plannedVsActual().
 */
export function sumStepsByMachine(results: Iterable<PlannedVsActual>): MachineTotal[] {
  const by = new Map<string, { label: string; planned: number; actual: number }>();
  const suffix = ` (${NOT_ON_PLAN_SUFFIX})`;
  for (const result of results) {
    for (const step of result.steps) {
      if (step.isBench || step.machineId === null) continue;
      const total = by.get(step.machineId) ?? { label: step.label.endsWith(suffix) ? step.label.slice(0, -suffix.length) : step.label, planned: 0, actual: 0 };
      total.planned += step.plannedHours ?? 0;
      total.actual += step.actualHours;
      by.set(step.machineId, total);
    }
  }
  return [...by].map(([machineId, t]) => ({ machineId, label: t.label, planned: round2(t.planned), actual: round2(t.actual) }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
}
