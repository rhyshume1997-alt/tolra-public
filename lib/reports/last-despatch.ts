/**
 * Latest despatch per job, from delivery notes. INFORMATION ONLY: it is shown beside a job and never decides whether the job is
 * finished, on time or late (part deliveries never mean finished; only jobs.finished_at does).
 *
 * Inputs: delivery note rows (job_id, despatched_at). Output: job id -> the latest despatched_at instant (ISO as given).
 * Rows with no job, no despatch time or an unreadable time are ignored.
 * Must not change: it must not be used by any completion rule. Pure (no React, no I/O).
 */
export type DespatchRow = { job_id: string | null; despatched_at: string | null };

export function lastDespatchByJob(rows: readonly DespatchRow[]): Map<string, string> {
  const latest = new Map<string, { at: string; ms: number }>();
  for (const row of rows) {
    if (!row.job_id || !row.despatched_at) continue;
    const ms = Date.parse(row.despatched_at);
    if (!Number.isFinite(ms)) continue;
    const held = latest.get(row.job_id);
    if (!held || ms > held.ms) latest.set(row.job_id, { at: row.despatched_at, ms });
  }
  return new Map([...latest].map(([id, v]) => [id, v.at]));
}
