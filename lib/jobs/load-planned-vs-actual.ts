/**
 * Reads what the planned-vs-actual panel needs for ONE job: its plan (job_machines + machine_bookings, joined by jobMachineEntries),
 * its machine runs, its job time (operator_sessions), machine names and whether the job is finished (jobs.finished_at). SELECTs only; never writes. Runs under the person's own session
 * (RLS applies).
 *
 * Inputs: a read client, the job id, `now`. Output: the PlannedVsActual figures. Throws when the plan, the
 * runs or the labour can't be read, so the panel shows one muted line rather than wrong figures.
 * Every list is read page by page (fetchAll), so nothing is cut off at the API's 1,000-row limit; if a list reaches fetchAll's
 * safety cap, `truncated` is true and the panel shows a "may be incomplete" note.
 * Must not change: it must stay read-only.
 */
import { fetchAll } from "@/lib/fetch-all";
import { type PlanLink, bookingFromJobRow, jobMachineEntries } from "@/lib/job-machine-plan";
import { type LabourRow, type PlannedVsActual, type RunRow, plannedVsActual } from "@/lib/jobs/planned-vs-actual";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadClient = { from: (table: string) => any };
type Row = Record<string, unknown>;

export async function loadPlannedVsActual(client: ReadClient, jobId: string, now: Date = new Date()): Promise<PlannedVsActual> {
  // Each list carries `id` (fetchAll de-duplicates by it) and a stable order ending in id, so paging can't skip or repeat a row.
  const all = (build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>) => fetchAll<Row>(build);
  const [job, plan, bookings, runs, labour, machines] = await Promise.all([
    client.from("jobs").select("finished_at").eq("id", jobId).maybeSingle(),
    all((from, to) => client.from("job_machines").select("id, machine_id, estimated_hours, booking_id, position").eq("job_id", jobId).order("position").order("id").range(from, to)),
    all((from, to) => client.from("machine_bookings").select("id, machine_id, job_id, estimated_hours, status, start_at").eq("job_id", jobId).order("id").range(from, to)),
    all((from, to) => client.from("machine_runs").select("id, machine_id, started_at, ended_at").eq("job_id", jobId).order("id").range(from, to)),
    all((from, to) => client.from("operator_sessions").select("id, started_at, ended_at, voided_at").eq("job_id", jobId).order("id").range(from, to)),
    all((from, to) => client.from("machines").select("id, name").order("id").range(from, to)),
  ]);
  if (job.error) throw job.error;
  const truncated = [plan, bookings, runs, labour, machines].some((list) => list.truncated);
  const jobFinished = Boolean((job.data as { finished_at?: unknown } | null)?.finished_at);
  const names = new Map<string, string>((machines.rows as { id: unknown; name: unknown }[]).map((m) => [String(m.id), String(m.name ?? "")]));
  const entries = jobMachineEntries(jobId, plan.rows as unknown as PlanLink[], (bookings.rows as unknown[]).map(bookingFromJobRow));
  return plannedVsActual({ entries, runs: runs.rows as unknown as RunRow[], labour: labour.rows as unknown as LabourRow[], machineNames: names, jobFinished, now, truncated });
}
