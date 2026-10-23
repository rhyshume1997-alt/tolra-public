/**
 * Deep links to a job on the Job Board. The board scrolls to and highlights the job a link names: `/jobs?job=<id>` (preferred),
 * or `/jobs?created=<job_no>` when only the job number is to hand. Both are matched against the jobs the signed-in user can already
 * read (RLS-scoped, loaded by the board), so a link never reveals a job the user could not see anyway.
 */
export function jobHref(job: { id?: string | null; job_no?: string | null }): string {
  if (job.id) return `/jobs?job=${encodeURIComponent(job.id)}`;
  return `/jobs?created=${encodeURIComponent(job.job_no ?? "")}`;
}

/** The id of the loaded job a Job Board query string names, or null (no param, or no such job among those loaded). */
export function linkedJobId(search: string, jobs: ReadonlyArray<{ id: string; job_no: string }>): string | null {
  const params = new URLSearchParams(search);
  const id = params.get("job");
  if (id && jobs.some((job) => job.id === id)) return id;
  const jobNo = params.get("created")?.trim();
  if (jobNo) return jobs.find((job) => job.job_no === jobNo)?.id ?? null;
  return null;
}
