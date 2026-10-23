/**
 * What an open run with NO booking can say about its time left: the job's plan row for that machine (job_machines.estimated_hours, the
 * "Planned: Mill 6.5 h" chip) minus the hours already run on it (ended machine_runs of that job and machine) minus this run so far
 * (lib/machine-schedule runClock). Start never writes a booking, so such a run is normal ("Running now (not booked)"). The estimate is
 * hours only: it ignores breaks and other jobs, so every figure built from it is labelled "(plan)". Reads only, under the person's own
 * session (the four roles can read both tables); client side, no SQL.
 */
import { fetchAll } from "@/lib/fetch-all";
import { type Machine, type RunClock, computeFinish, runClock, runsEveryDay } from "@/lib/machine-schedule";
import { supabase } from "@/lib/supabase";

export type RunPlan = { planHours: number; hoursDone: number };

const CHUNK = 100;
const HOUR_MS = 3_600_000;

export const runPlanKey = (jobId: string, machineId: string) => `${jobId}:${machineId}`;

type PlanRow = { job_id: unknown; machine_id: unknown; estimated_hours: unknown };
type EndedRunRow = { job_id: unknown; machine_id: unknown; started_at: unknown; ended_at: unknown };

/** The plan hours per job + machine, and the hours of ENDED runs on each (an open run is never counted: runClock counts it live). */
export function buildRunPlan(planRows: PlanRow[], runRows: EndedRunRow[]): Map<string, RunPlan> {
  const map = new Map<string, RunPlan>();
  for (const row of planRows) {
    const key = runPlanKey(String(row.job_id), String(row.machine_id));
    map.set(key, { planHours: (map.get(key)?.planHours ?? 0) + (Number(row.estimated_hours) || 0), hoursDone: 0 });
  }
  for (const row of runRows) {
    if (row.ended_at === null || row.ended_at === undefined) continue;
    const entry = map.get(runPlanKey(String(row.job_id), String(row.machine_id)));
    if (!entry) continue;
    const ms = new Date(String(row.ended_at)).getTime() - new Date(String(row.started_at)).getTime();
    if (Number.isFinite(ms) && ms > 0) entry.hoursDone += ms / HOUR_MS;
  }
  return map;
}

/** "job:machine" -> plan hours and hours already run. Null when they can't be read (the caller then shows elapsed time only). */
export async function loadRunPlan(jobIds: string[]): Promise<Map<string, RunPlan> | null> {
  const unique = [...new Set(jobIds)];
  if (!unique.length) return new Map();
  if (!supabase) return null;
  const client = supabase;
  const planRows: PlanRow[] = [];
  const runRows: EndedRunRow[] = [];
  try {
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const plan = await fetchAll((from, to) => client.from("job_machines").select("id, job_id, machine_id, estimated_hours").in("job_id", chunk).order("id").range(from, to));
      planRows.push(...(plan.rows as PlanRow[]));
      const { rows } = await fetchAll((from, to) => client.from("machine_runs").select("id, job_id, machine_id, started_at, ended_at").in("job_id", chunk).not("ended_at", "is", null).order("id").range(from, to));
      runRows.push(...(rows as EndedRunRow[]));
    }
  } catch {
    return null;
  }
  return buildRunPlan(planRows, runRows);
}

/** The plan as a booking-shaped input for runClock; null without plan hours (then runClock gives elapsed only). */
export function planBooking(plan: RunPlan | null | undefined) {
  return plan && plan.planHours > 0 ? { estimatedHours: plan.planHours, hoursDone: plan.hoursDone, status: "running" as const } : null;
}

export type UnbookedRunView = {
  clock: RunClock | null;
  /** The job's plan hours for this machine; null when none are planned. */
  planHours: number | null;
  /** Where the plan says it finishes (working hours of the machine); null when over the plan, no plan hours, or no machine. */
  finish: Date | null;
};

/** One unbooked open run: its clock and plan ETA, from the same runClock the booked runs use. */
export function unbookedRunView(startedAt: string, plan: RunPlan | null | undefined, machine: Pick<Machine, "hoursPerDay" | "workingDays"> | undefined, now: Date): UnbookedRunView {
  const booking = planBooking(plan);
  const clock = runClock(startedAt, booking, now);
  const left = clock?.leftMinutes ?? null;
  const finish = left !== null && left > 0 && machine ? computeFinish(now, left / 60, machine, runsEveryDay(new Date(startedAt), machine)) : null;
  return { clock, planHours: booking ? booking.estimatedHours : null, finish };
}
