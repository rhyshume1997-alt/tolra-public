/**
 * Live machine use on the Machine Schedule (migration 044, client only): what the status card says while a run is open, the "actual"
 * bars the timeline draws from machine_runs next to the planned bookings, and the "Running now (not booked)" rows of the table.
 * Runs are the truth for live use; bookings stay the plan and are never moved by a run. Names come from machines_in_use() /
 * company_people() (lib/people rules: never an e-mail, "—" when there is no name).
 */
import { isStale, type InUseRow } from "@/lib/machine-runs";
import { cleanName, personName, UNKNOWN, type PeopleMap } from "@/lib/people";
import { formatDayTime, formatHours, formatHoursClock, liveLeftText, localDateString, timeOf, windowFor, type Booking, type Machine, type MachineStatus } from "@/lib/machine-schedule";
import type { UnbookedRunView } from "@/lib/run-plan";

/** One machine run inside the timeline's window, as the page reads it from machine_runs. */
export type RunRow = {
  id: string;
  machine_id: string;
  job_id: string;
  job_no: string;
  booking_id: string | null;
  operator_id: string | null;
  started_at: string;
  ended_at: string | null;
  /** Why the run ended ('paused', 'finished', 'override', ...); null while it is open. */
  end_reason: string | null;
};

/** The columns the page selects (jobs(job_no) through the job_id foreign key). */
export const RUN_COLUMNS = "id, machine_id, job_id, booking_id, operator_id, started_at, ended_at, end_reason, jobs(job_no)";

/**
 * machine_runs rows as they came over the wire, checked field by field. A bench run (machine_id null, migration 046) is skipped: it has
 * no machine row to draw on. Works the same whether or not 046 is applied.
 */
export function runRows(rows: unknown): RunRow[] {
  if (!Array.isArray(rows)) return [];
  const out: RunRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.machine_id !== "string" || !r.machine_id || typeof r.job_id !== "string" || typeof r.started_at !== "string") continue;
    if (Number.isNaN(new Date(r.started_at).getTime())) continue;
    const job = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
    const jobNo = job && typeof job === "object" && typeof (job as { job_no?: unknown }).job_no === "string" ? (job as { job_no: string }).job_no : "";
    out.push({
      id: r.id, machine_id: r.machine_id, job_id: r.job_id, job_no: jobNo, booking_id: typeof r.booking_id === "string" ? r.booking_id : null,
      operator_id: typeof r.operator_id === "string" ? r.operator_id : null, started_at: r.started_at,
      ended_at: typeof r.ended_at === "string" && !Number.isNaN(new Date(r.ended_at).getTime()) ? r.ended_at : null,
      end_reason: typeof r.end_reason === "string" ? r.end_reason : null,
    });
  }
  return out;
}

/** "09:12" today, "Tue 09:12" on another day: the moment a run started, in the schedule's local time. */
export function sinceText(startedAt: string | Date, now = new Date()): string {
  const at = new Date(startedAt);
  return localDateString(at) === localDateString(now) ? timeOf(at) : formatDayTime(at);
}

/** What one status card says. `live` (an open run on the machine) wins over the booking-based guess. */
export type CardText = {
  inUse: boolean;
  /** The coloured pill: "In use by Dave since 09:12", "Busy until Tue 16:00", "Free now". */
  pill: string;
  /** A run open 12 hours or more: probably a forgotten Finish or Pause. */
  staleNote: string | null;
  body: string;
  nextFree: string;
};

/** "running for 1:25": this run's time so far. */
export const runningForText = (elapsedMinutes: number) => `running for ${formatHoursClock(elapsedMinutes / 60)}`;

/** "about Tue 16:40 (plan)" for an unbooked run's plan ETA; "-" with no plan hours; "Past the plan" once over the plan hours. */
export function unbookedFinishText(view: UnbookedRunView): string {
  if (view.finish) return `about ${formatDayTime(view.finish)} (plan)`;
  return view.planHours !== null && view.clock?.leftMinutes != null ? "Past the plan" : "-";
}

/** "2:35 left (plan 6:30)", "0:20 over (plan 6:30)", or "No hours planned" when the job has no plan hours on the machine. */
export function unbookedLeftText(view: UnbookedRunView): string {
  if (view.planHours === null || view.clock?.leftMinutes == null) return "No hours planned";
  return `${liveLeftText(view.clock.leftMinutes)} (plan ${formatHoursClock(view.planHours)})`;
}

/**
 * `unbooked`: the open run on this machine has no booking, so its clock and plan ETA (lib/run-plan) fill in what the booking would have:
 * "running for 1:25" in the body and "About Tue 16:40 (plan), or sooner if paused" as the next free time (an hours-only estimate, so it
 * is labelled as one). Without it the card reads as before.
 */
export function statusCardText(s: MachineStatus, live: InUseRow | undefined, now = new Date(), unbooked?: UnbookedRunView | null): CardText {
  if (live) {
    const who = cleanName(live.operator_name) ?? UNKNOWN;
    const booked = s.current ? `, ${formatHours(s.current.hoursLeft)} booked left` : "";
    return {
      inUse: true,
      pill: `In use by ${who} since ${sinceText(live.started_at, now)}`,
      staleNote: isStale(live, now) ? "No Finish or Pause for 12 h+" : null,
      body: `Job ${live.job_no || UNKNOWN} running${booked}${unbooked?.clock ? `, ${runningForText(unbooked.clock.elapsedMinutes)}` : ""}`,
      nextFree: unbooked?.finish ? `About ${formatDayTime(unbooked.finish)} (plan), or sooner if paused` : "When paused or finished",
    };
  }
  return {
    inUse: false,
    pill: s.busy && s.current ? `Busy until ${formatDayTime(s.current.finish)}` : "Free now",
    staleNote: null,
    body: s.current ? `Job ${s.current.jobNo}, ${formatHours(s.current.hoursLeft)} left` : "No job running",
    nextFree: s.busy ? formatDayTime(s.nextFree) : "Now",
  };
}

const HOUR_MS = 3600_000;

/** Narrowest an actual bar is drawn, as a share of its day cell (as the planned bars). */
export const MIN_RUN_BAR_PERCENT = 12;

/** What a run looks like on the timeline: blue while running, yellow once paused, green once finished (colours: SCHEDULE_STATES in lib/status-colours.ts). */
export type RunKind = "running" | "paused" | "finished";

export function runKind(run: Pick<RunRow, "ended_at" | "end_reason">): RunKind {
  return run.ended_at === null ? "running" : run.end_reason === "paused" ? "paused" : "finished";
}

/**
 * One run's block in one day cell: open runs end at `now`; `outOfHours` when some of that day's run lies outside the machine's window.
 * `marks` are the hour boundaries inside the block (percent of the block's width), so it reads hour by hour like a booking.
 */
export type RunBar = { run: RunRow; left: number; width: number; open: boolean; kind: RunKind; outOfHours: boolean; from: Date; to: Date; marks: number[];
  /** The run's real time span in the cell (percent), without the minimum drawing width: what it takes away from a booking. */
  usedLeft: number; usedWidth: number };

/** The parts of [left, left + width] (percent of a day cell) not covered by any of `covers`. Slivers under half a percent are dropped. */
export function uncoveredParts(left: number, width: number, covers: { left: number; width: number }[]): { left: number; width: number }[] {
  let parts = [{ left, width }];
  for (const c of covers) {
    const cFrom = c.left, cTo = c.left + c.width;
    parts = parts.flatMap((p) => {
      const pTo = p.left + p.width;
      if (cTo <= p.left || cFrom >= pTo) return [p];
      const out = [];
      if (cFrom > p.left) out.push({ left: p.left, width: cFrom - p.left });
      if (cTo < pTo) out.push({ left: cTo, width: pTo - cTo });
      return out;
    });
  }
  return parts.filter((p) => p.width >= 0.5);
}

/**
 * The actual bars of a machine on one calendar day. The part of each run inside that day is laid over the machine's window for the day
 * (08:00 + hours per day, as the planned bars); a part outside the window is clamped to the cell's nearest edge and marked, never dropped.
 * Runs are drawn on any day they happened, working day or not.
 */
export function runBarsFor(runs: RunRow[], machine: Pick<Machine, "id" | "hoursPerDay" | "workingDays">, day: Date, now = new Date()): RunBar[] {
  const { start, end } = windowFor(day, machine);
  const total = end.getTime() - start.getTime();
  if (total <= 0) return [];
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const out: RunBar[] = [];
  for (const run of runs) {
    if (run.machine_id !== machine.id) continue;
    const open = run.ended_at === null;
    const runFrom = new Date(run.started_at).getTime();
    const runTo = Math.max(runFrom, open ? now.getTime() : new Date(run.ended_at!).getTime());
    const partFrom = Math.max(runFrom, dayStart);
    const partTo = Math.min(runTo, dayEnd);
    // Not on this day (a zero-length run counts on the day it started).
    if (partTo < partFrom || (partTo === partFrom && (runFrom < dayStart || runFrom >= dayEnd))) continue;
    const outOfHours = partFrom < start.getTime() || partTo > end.getTime();
    let from = Math.max(partFrom, start.getTime());
    let to = Math.min(partTo, end.getTime());
    if (to < from) from = to = partTo <= start.getTime() ? start.getTime() : end.getTime();
    const usedWidth = ((to - from) / total) * 100;
    const usedLeft = ((from - start.getTime()) / total) * 100;
    const width = Math.max(MIN_RUN_BAR_PERCENT, ((to - from) / total) * 100);
    const left = Math.max(0, Math.min(((from - start.getTime()) / total) * 100, 100 - width));
    const hourPercent = (HOUR_MS / total) * 100;
    const marks: number[] = [];
    for (let h = 1; h * hourPercent < 100 - 1e-9; h++) {
      const at = (h * hourPercent - left) / width * 100;
      if (at > 0.5 && at < 99.5) marks.push(at);
    }
    out.push({ run, left, width, open, kind: runKind(run), outOfHours, from: new Date(partFrom), to: new Date(partTo), marks, usedLeft, usedWidth });
  }
  return out.sort((a, b) => a.left - b.left);
}

/** The accessible label of an actual bar: what ran, where, who, and when. */
export function runBarLabel(bar: Pick<RunBar, "run" | "open">, machineName: string, people: PeopleMap, now = new Date()): string {
  const who = personName(people, bar.run.operator_id);
  const from = sinceText(bar.run.started_at, now);
  const to = bar.open ? "now (running)" : `${sinceText(bar.run.ended_at!, now)} (ended)`;
  return `Actual: ${bar.run.job_no || UNKNOWN} on ${machineName} by ${who}, ${from} to ${to}`;
}

/** The open runs the table lists as "Running now (not booked)": no booking, or a booking the schedule doesn't hold. */
export function unbookedRunning(live: InUseRow[], bookings: Pick<Booking, "id">[]): InUseRow[] {
  const ids = new Set(bookings.map((b) => b.id));
  return live.filter((r) => !r.booking_id || !ids.has(r.booking_id)).sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** The window the timeline shows, as the bounds of the machine_runs query: runs that started before its end and were open after its start. */
export function runWindowFilter(start: Date, end: Date): { before: string; or: string } {
  return { before: end.toISOString(), or: `ended_at.is.null,ended_at.gt."${start.toISOString()}"` };
}
