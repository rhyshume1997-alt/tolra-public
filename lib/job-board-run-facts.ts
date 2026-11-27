import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAll } from "@/lib/fetch-all";
import { withReleaseReasons } from "@/lib/machine-runs";

/**
 * Each unfinished job's runs, read straight from machine_runs (plan R2.3: SELECT for the four roles, no SQL): whether it ever ran, what is
 * open, how its latest run ended and what it last ran on. One paged read joined to the job (unfinished jobs only), not one per id chunk.
 * Null when it can't be read.
 */
export async function loadBoardRunFacts(client: Pick<SupabaseClient, "from"> | null): Promise<Record<string, unknown>[] | null> {
  if (!client) return null;
  try {
    const { rows, truncated } = await fetchAll((from, to) => client.from("machine_runs").select("id, job_id, machine_id, started_at, ended_at, end_reason, ended_by, jobs!inner(finished_at)")
      .is("jobs.finished_at", null).order("id").range(from, to));
    if (truncated) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let runs: Record<string, unknown>[] = rows.map(({ jobs: _job, ...run }) => run);
    // 092: why an admin released a job's machine (on the job time it ended). Not readable (before 092, other people's time): no reason.
    const released = [...new Set(runs.filter((r) => r.end_reason === "admin_released").map((r) => r.job_id as string))];
    for (let i = 0; i < released.length; i += 200) {
      const reasons = await client.from("operator_sessions").select("job_id, ended_at, end_reason").eq("end_source", "admin_released").in("job_id", released.slice(i, i + 200));
      if (!reasons.error) runs = withReleaseReasons(runs, reasons.data);
    }
    return runs;
  } catch {
    return null;
  }
}
