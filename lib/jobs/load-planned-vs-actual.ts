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

const BATCH_CHUNK = 100;

/**
 * Batch form for reports: the same figures as loadPlannedVsActual, for many jobs (Map keyed by job id; duplicate ids are read once). Jobs are read in chunks of
 * 100 (`.in("job_id", …)`), machine names once, every list paged with fetchAll. Each job goes through the same jobMachineEntries + plannedVsActual path as the single-job loader,
 * so unplanned machine time and bench follow the same rules. A job's `truncated` is true when any list read for its chunk (or the machines list) hit fetchAll's safety cap
 * (a cap cannot be attributed to one job in a chunk, so the whole chunk is flagged). Throws on a read error. SELECTs only.
 */
export async function loadPlannedVsActualBatch(client: ReadClient, jobIds: string[], now: Date = new Date()): Promise<Map<string, PlannedVsActual>> {
  const results = new Map<string, PlannedVsActual>();
  const ids = [...new Set(jobIds)];
  if (!ids.length) return results;
  const all = (build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>) => fetchAll<Row>(build);
  const machines = await all((from, to) => client.from("machines").select("id, name").order("id").range(from, to));
  const names = new Map<string, string>((machines.rows as { id: unknown; name: unknown }[]).map((m) => [String(m.id), String(m.name ?? "")]));
  const group = (rows: Row[]) => {
    const by = new Map<string, Row[]>();
    for (const row of rows) {
      const key = String(row.job_id);
      by.set(key, [...(by.get(key) ?? []), row]);
    }
    return by;
  };
  for (let i = 0; i < ids.length; i += BATCH_CHUNK) {
    const chunk = ids.slice(i, i + BATCH_CHUNK);
    const [jobs, plan, bookings, runs, labour] = await Promise.all([
      all((from, to) => client.from("jobs").select("id, finished_at").in("id", chunk).order("id").range(from, to)),
      all((from, to) => client.from("job_machines").select("id, job_id, machine_id, estimated_hours, booking_id, position").in("job_id", chunk).order("position").order("id").range(from, to)),
      all((from, to) => client.from("machine_bookings").select("id, machine_id, job_id, estimated_hours, status, start_at").in("job_id", chunk).order("id").range(from, to)),
      all((from, to) => client.from("machine_runs").select("id, job_id, machine_id, started_at, ended_at").in("job_id", chunk).order("id").range(from, to)),
      all((from, to) => client.from("operator_sessions").select("id, job_id, started_at, ended_at, voided_at").in("job_id", chunk).order("id").range(from, to)),
    ]);
    const truncated = machines.truncated || [jobs, plan, bookings, runs, labour].some((list) => list.truncated);
    const finished = new Map(jobs.rows.map((j) => [String(j.id), Boolean(j.finished_at)]));
    const [planBy, bookingsBy, runsBy, labourBy] = [group(plan.rows), group(bookings.rows), group(runs.rows), group(labour.rows)];
    for (const jobId of chunk) {
      const entries = jobMachineEntries(jobId, (planBy.get(jobId) ?? []) as unknown as PlanLink[], (bookingsBy.get(jobId) ?? []).map(bookingFromJobRow));
      results.set(jobId, plannedVsActual({
        entries, runs: (runsBy.get(jobId) ?? []) as unknown as RunRow[], labour: (labourBy.get(jobId) ?? []) as unknown as LabourRow[],
        machineNames: names, jobFinished: finished.get(jobId) ?? false, now, truncated,
      }));
    }
  }
  return results;
}
