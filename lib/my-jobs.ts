/** B45: operator "My jobs" — unfinished jobs assigned to the current user, soonest due first. */

export type MyJobInput = {
  id: string;
  job_no?: string | null;
  description?: string | null;
  stage?: string | null;
  date_required?: string | null;
  due_date?: string | null;
  finished_at?: string | null;
  assigned_to?: string | null;
};

export type MyJob = {
  id: string;
  jobNo: string;
  description: string;
  stage: string;
  due: string | null;
};

export const MY_JOBS_LIMIT = 20;

/** Unfinished jobs assigned to userId, soonest required/due date first (no date last). */
export function myJobs(rows: MyJobInput[], userId: string | null | undefined, limit = MY_JOBS_LIMIT): MyJob[] {
  if (!userId) return [];
  const mine = rows.filter((row) => !row.finished_at && row.assigned_to === userId);
  mine.sort((a, b) => {
    const da = a.date_required || a.due_date || "";
    const db = b.date_required || b.due_date || "";
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da.localeCompare(db);
  });
  return mine.slice(0, limit).map((row) => ({
    id: row.id,
    jobNo: row.job_no || "",
    description: row.description || "",
    stage: row.stage || "",
    due: row.date_required || row.due_date || null,
  }));
}
