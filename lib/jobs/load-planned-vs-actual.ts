/**
 * Reads what the planned-vs-actual panel needs for ONE job: its plan (job_machines + machine_bookings, joined by jobMachineEntries),
 * its machine runs, its job time (operator_sessions) and machine names. SELECTs only; never writes. Runs under the person's own session
 * (RLS applies).
 *
 * Inputs: a read client, the job id, whether it is finished, `now`. Output: the PlannedVsActual figures. Throws when the plan, the
 * runs or the labour can't be read, so the panel shows one muted line rather than wrong figures.
 * Must not change: it must stay read-only.
 */
import { type PlanLink, bookingFromJobRow, jobMachineEntries } from "@/lib/job-machine-plan";
import { type LabourRow, type PlannedVsActual, type RunRow, plannedVsActual } from "@/lib/jobs/planned-vs-actual";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadClient = { from: (table: string) => any };

export async function loadPlannedVsActual(client: ReadClient, jobId: string, jobFinished: boolean, now: Date = new Date()): Promise<PlannedVsActual> {
  const [plan, bookings, runs, labour, machines] = await Promise.all([
    client.from("job_machines").select("machine_id, estimated_hours, booking_id, position").eq("job_id", jobId).order("position"),
    client.from("machine_bookings").select("id, machine_id, job_id, estimated_hours, status, start_at").eq("job_id", jobId),
    client.from("machine_runs").select("machine_id, started_at, ended_at").eq("job_id", jobId),
    client.from("operator_sessions").select("started_at, ended_at, voided_at").eq("job_id", jobId),
    client.from("machines").select("id, name"),
  ]);
  for (const result of [plan, bookings, runs, labour, machines]) if (result.error) throw result.error;
  const names = new Map<string, string>(((machines.data ?? []) as { id: unknown; name: unknown }[]).map((m) => [String(m.id), String(m.name ?? "")]));
  const entries = jobMachineEntries(jobId, (plan.data ?? []) as PlanLink[], ((bookings.data ?? []) as unknown[]).map(bookingFromJobRow));
  return plannedVsActual({ entries, runs: (runs.data ?? []) as RunRow[], labour: (labour.data ?? []) as LabourRow[], machineNames: names, jobFinished, now });
}
