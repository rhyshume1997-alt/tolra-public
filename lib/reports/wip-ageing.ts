/**
 * Work in progress ageing. Open = finished_at is empty. Age = whole London calendar days from the day started_at falls on to today (so it is
 * right across the clock changes). Bands: 0-7, 8-14, 15-30, 31-60, 61+ days. Open jobs with no started_at are "not started" and counted
 * apart, in no band. Internal jobs (is_internal) are left out.
 *
 * Inputs: job rows and `now`. Outputs: the band counts, the not-started count and one audit row per open job.
 * Must not change: the band edges (7/8, 14/15, 30/31, 60/61). Pure (no React, no I/O).
 */
import { calendarDate, toDateInput } from "@/lib/dates";

export type WipJob = { id: string; job_no: string | null; customer: string | null; is_internal: boolean | null; started_at: string | null; finished_at: string | null };

export const WIP_BANDS = [
  { key: "0-7", label: "0–7 days", max: 7 },
  { key: "8-14", label: "8–14 days", max: 14 },
  { key: "15-30", label: "15–30 days", max: 30 },
  { key: "31-60", label: "31–60 days", max: 60 },
  { key: "61+", label: "61+ days", max: Infinity },
] as const;

export type WipRow = { jobNo: string; customer: string; startedDate: string; ageDays: number | null; band: string };
export type WipReport = { bands: { key: string; label: string; count: number }[]; notStarted: number; open: number; rows: WipRow[] };

/** The band key for an age in whole days (never negative). */
export function wipBand(ageDays: number): string {
  return (WIP_BANDS.find((b) => ageDays <= b.max) ?? WIP_BANDS[WIP_BANDS.length - 1]).key;
}

export function wipAgeing(jobs: readonly WipJob[], now: Date): WipReport {
  const today = Math.round(Date.parse(`${toDateInput(now)}T00:00:00Z`) / 86_400_000);
  const counts = new Map<string, number>(WIP_BANDS.map((b) => [b.key, 0]));
  const rows: WipRow[] = [];
  let notStarted = 0;
  for (const job of jobs) {
    if (job.is_internal || job.finished_at) continue;
    const started = calendarDate(job.started_at);
    if (!started) {
      notStarted += 1;
      rows.push({ jobNo: job.job_no ?? "", customer: job.customer ?? "", startedDate: "", ageDays: null, band: "Not started" });
      continue;
    }
    const age = Math.max(0, today - Math.round(Date.parse(`${started}T00:00:00Z`) / 86_400_000));
    const band = wipBand(age);
    counts.set(band, (counts.get(band) ?? 0) + 1);
    rows.push({ jobNo: job.job_no ?? "", customer: job.customer ?? "", startedDate: started, ageDays: age, band });
  }
  rows.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) || (a.jobNo < b.jobNo ? -1 : a.jobNo > b.jobNo ? 1 : 0));
  return { bands: WIP_BANDS.map((b) => ({ key: b.key, label: b.label, count: counts.get(b.key) ?? 0 })), notStarted, open: rows.length, rows };
}
