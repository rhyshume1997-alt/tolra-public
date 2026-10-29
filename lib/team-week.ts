/**
 * John's team view (Rhys, 28 Oct: "John sees who is doing the most work by worker, how long and such, but only he can see"): one row
 * per person for this week, worked out from the same records as Weekly hours (lib/time-week loadWeek: clock records and job time),
 * plus the jobs each person finished this week (jobs.finished_by, migration 035) and what they are doing right now. Admin only: the
 * Dashboard renders it only on the admin view, and the reads behind it return the whole company only to admin and office (RLS).
 */
import { effectiveEvents, type AttendanceEvent, type LabourSession, type WeekTotals } from "@/lib/time-sheet";
import { personName, type PeopleMap } from "@/lib/people";

export type NowState = { state: "on_job"; jobNo: string; since: string } | { state: "on_break" | "clocked_in"; since: string } | { state: "out" };

export type TeamRow = {
  userId: string;
  name: string;
  now: NowState;
  /** Minutes booked on jobs this week (job time, overlaps split). */
  jobMinutes: number;
  /** Paid minutes this week (clocked, less unpaid breaks), as on Weekly hours. */
  paidMinutes: number;
  /** Share of clocked time spent on jobs, or null when nobody clocked any time. */
  onJobsPercent: number | null;
  jobsFinished: number;
  daysWorked: number;
};

/** What a person is doing now: on a job (open, not voided job time), else on a break or clocked in (latest clock action), else out. */
export function nowState(userId: string, events: AttendanceEvent[], labour: LabourSession[], jobNos: Record<string, string>): NowState {
  const open = labour
    .filter((s) => s.user_id === userId && !s.ended_at && !s.voided_at)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  if (open) return { state: "on_job", jobNo: jobNos[open.job_id] || "a job", since: open.started_at };
  const last = effectiveEvents(events.filter((e) => e.user_id === userId)).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!last || last.action === "out") return { state: "out" };
  if (last.action === "break_start") return { state: "on_break", since: last.at };
  return { state: "clocked_in", since: last.at };
}

/** One row per person seen this week, busiest first (most time on jobs, then most jobs finished, then name). */
export function teamRows(input: {
  people: Array<{ userId: string; week: WeekTotals }>;
  events: AttendanceEvent[];
  labour: LabourSession[];
  jobNos: Record<string, string>;
  finishedBy: Array<string | null | undefined>;
  names: PeopleMap;
}): TeamRow[] {
  const finished = new Map<string, number>();
  for (const id of input.finishedBy) if (id) finished.set(id, (finished.get(id) ?? 0) + 1);
  const ids = new Set([...input.people.map((p) => p.userId), ...finished.keys()]);
  const weeks = new Map(input.people.map((p) => [p.userId, p.week]));
  return [...ids].map((userId) => {
    const week = weeks.get(userId);
    const jobMinutes = Math.round(week?.labour ?? 0);
    const attendance = week?.attendance ?? 0;
    return {
      userId,
      name: personName(input.names, userId),
      now: nowState(userId, input.events, input.labour, input.jobNos),
      jobMinutes,
      paidMinutes: Math.round(week?.paid ?? 0),
      onJobsPercent: attendance > 0 ? Math.min(100, Math.round((jobMinutes / attendance) * 100)) : null,
      jobsFinished: finished.get(userId) ?? 0,
      daysWorked: week?.daysWorked ?? 0,
    };
  }).sort((a, b) => b.jobMinutes - a.jobMinutes || b.jobsFinished - a.jobsFinished || a.name.localeCompare(b.name));
}
