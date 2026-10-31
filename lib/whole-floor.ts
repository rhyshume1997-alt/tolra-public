/**
 * The workshop's Whole floor: every machine (and anything on the bench) right now, read-only, for the workshop tablet. Pure shaping
 * of reads the app already makes: machines, machines_in_use() (044), paused_machines() (049), bench_runs_state() (046), the jobs
 * those runs are on, and the machines' coming bookings. Fails closed: a read that failed is null here and shows as a dash, never
 * as 0 or as an idle floor.
 */
import { fmtDueBy } from "@/lib/dates";
import { requiredDate } from "@/lib/job-status";
import { requiredParts } from "@/lib/parts-quantity";
import { benchRows, inUseRows, isStale, pausedRows } from "@/lib/machine-runs";
import { COLOUR_CLASSES, SCHEDULE_STATES, STATUS_MAP, type StatusKey } from "@/lib/status-colours";

/** What a machine is doing now. Late is a flag on the job, shown beside it. */
export type FloorState = "running" | "paused" | "idle";

/** Each state's word and its place on the one status map (lib/status-colours): the dot's colour, never without the word. */
export const FLOOR_WORDS: Record<FloorState | "late", { label: string; status: StatusKey }> = {
  running: { label: "Running", status: "in_progress" },
  // The schedule's paused colour (SCHEDULE_STATES), so a paused machine looks the same here as on the timeline.
  paused: { label: "Paused", status: SCHEDULE_STATES.paused.status ?? "waiting_on_supplier" },
  idle: { label: "Idle", status: "not_started" },
  late: { label: "Late", status: "overdue" },
};
export const floorDotClass = (word: FloorState | "late") => COLOUR_CLASSES[STATUS_MAP[FLOOR_WORDS[word].status].colour].dot;

export type FloorJob = {
  id: string;
  jobNo: string;
  /** null: not on file, or the job read failed (detailsFailed). */
  customer: string | null;
  description: string | null;
  /** The required date (YYYY-MM-DD), or null. */
  due: string | null;
  /** true / false; null when it can't be told (the job read failed). */
  late: boolean | null;
  /** The quantity required (M), or null when none is on file or the job read failed: "N of M parts" shows only with one (lib/job-parts). */
  quantity: number | null;
};

export type FloorRow = {
  key: string;
  /** The machine's name, or "Bench" for a job worked on the bench. */
  place: string;
  bench: boolean;
  state: FloorState;
  job: FloorJob | null;
  operator: string | null;
  /** Running since (open run) or paused at (ISO); null when idle. */
  since: string | null;
  /** Open 12 hours or more: probably a forgotten Finish or Pause. */
  stale: boolean;
  /** The next booked job's number; null when nothing is booked; undefined when the bookings couldn't be read. */
  next: string | null | undefined;
};

export type FloorCounts = { running: number | null; paused: number | null; idle: number | null; late: number | null };

export type WholeFloor = {
  /** Machines, live runs or paused machines couldn't be read: nothing is shown as idle, every figure is a dash. */
  failed: boolean;
  rows: FloorRow[];
  counts: FloorCounts;
  benchFailed: boolean;
  detailsFailed: boolean;
  nextFailed: boolean;
};

/** Each read as it came back; null when it failed. */
export type FloorReads = { machines: unknown; inUse: unknown; paused: unknown; bench: unknown; jobs: unknown; bookings: unknown };

const DASHES: FloorCounts = { running: null, paused: null, idle: null, late: null };
export const FLOOR_FAILED: WholeFloor = { failed: true, rows: [], counts: DASHES, benchFailed: false, detailsFailed: false, nextFailed: false };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The jobs the second read needs: every job on a machine, paused on one, or on the bench now. */
export function floorJobIds(inUse: unknown, paused: unknown, bench: unknown): string[] {
  const ids = new Set<string>();
  for (const r of inUseRows(inUse)) ids.add(r.job_id);
  for (const r of pausedRows(paused)) ids.add(r.job_id);
  for (const r of benchRows(bench)) if (r.state === "on_bench") ids.add(r.job_id);
  return [...ids];
}

/** today: the UK date (YYYY-MM-DD) lateness is judged on; now: the clock for a run left open 12 hours or more. */
export function wholeFloor(reads: FloorReads, today: string, now = new Date()): WholeFloor {
  if (!Array.isArray(reads.machines) || !Array.isArray(reads.inUse) || !Array.isArray(reads.paused)) return FLOOR_FAILED;
  const detailsFailed = !Array.isArray(reads.jobs);
  const nextFailed = !Array.isArray(reads.bookings);
  const benchFailed = !Array.isArray(reads.bench);

  const jobs = new Map<string, Record<string, unknown>>();
  for (const row of detailsFailed ? [] : (reads.jobs as unknown[])) {
    if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") jobs.set((row as { id: string }).id, row as Record<string, unknown>);
  }
  const jobOf = (id: string, jobNo: string): FloorJob => {
    const row = jobs.get(id);
    if (!row) return { id, jobNo: jobNo || "—", customer: null, description: null, due: null, late: detailsFailed ? null : false, quantity: null };
    const due = requiredDate(row as { date_required?: string | null; due_date?: string | null }) || null;
    return {
      id, jobNo: text(row.job_no) ?? (jobNo || "—"), customer: text(row.customer), description: text(row.description), due,
      late: !row.finished_at && due !== null && due < today,
      quantity: requiredParts(row.quantity_required as number | string | null | undefined),
    };
  };

  // The next booked job on each machine: the earliest booking still to come that isn't the job on it now.
  const bookings = nextFailed ? [] : (reads.bookings as unknown[]).filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object")
    .filter((b) => typeof b.machine_id === "string" && typeof b.start_at === "string" && b.status !== "complete")
    .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
  const nextFor = (machineId: string, current: string | null): string | null | undefined => {
    if (nextFailed) return undefined;
    const b = bookings.find((x) => x.machine_id === machineId && (!current || x.job_id !== current));
    return b ? text(b.job_no) : null;
  };

  const live = new Map(inUseRows(reads.inUse).map((r) => [r.machine_id, r]));
  const paused = new Map(pausedRows(reads.paused).map((r) => [r.machine_id, r]));
  const machines = new Map<string, string>();
  for (const m of reads.machines as unknown[]) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    // A retired machine is left out unless something is on it.
    if (r.active === false && !live.has(r.id) && !paused.has(r.id)) continue;
    machines.set(r.id, text(r.name) ?? "Machine");
  }
  // A run on a machine the machines read didn't return (it still counts: the run is the truth).
  for (const r of live.values()) if (!machines.has(r.machine_id)) machines.set(r.machine_id, r.machine_name);

  const rows: FloorRow[] = [...machines].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => {
    const run = live.get(id);
    if (run) {
      const job = jobOf(run.job_id, run.job_no);
      return { key: id, place: name, bench: false, state: "running", job, operator: run.operator_name, since: run.started_at, stale: isStale(run, now), next: nextFor(id, run.job_id) };
    }
    const p = paused.get(id);
    if (p) return { key: id, place: name, bench: false, state: "paused", job: jobOf(p.job_id, p.job_no), operator: p.operator_name, since: p.paused_at, stale: false, next: nextFor(id, p.job_id) };
    return { key: id, place: name, bench: false, state: "idle", job: null, operator: null, since: null, stale: false, next: nextFor(id, null) };
  });

  // Jobs worked on the bench now (no machine), after the machines, oldest first.
  const onBench = benchRows(reads.bench).filter((r) => r.state === "on_bench").sort((a, b) => a.started_at.localeCompare(b.started_at));
  for (const r of onBench) {
    rows.push({ key: `bench-${r.job_id}`, place: "Bench", bench: true, state: "running", job: jobOf(r.job_id, ""), operator: r.operator_name, since: r.started_at, stale: isStale({ started_at: r.started_at, stale: false }, now), next: null });
  }

  const count = (state: FloorState) => rows.filter((r) => r.state === state).length;
  const withJob = rows.filter((r) => r.job);
  const late = detailsFailed && withJob.length ? null : withJob.filter((r) => r.job!.late).length;
  // Without the bench read, jobs worked on the bench are missing, so Running and Late are unknown (a dash), not short.
  return { failed: false, rows, counts: { running: benchFailed ? null : count("running"), paused: count("paused"), idle: count("idle"), late: benchFailed ? null : late }, benchFailed, detailsFailed, nextFailed };
}

const TZ = "Europe/London";
const time = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const day = (d: Date) => d.toLocaleDateString("en-GB", { timeZone: TZ });

/** "Since 08:05", "Paused at 12:05", or with the date when it wasn't today ("Since 28/10 08:05"). */
export function sinceText(row: Pick<FloorRow, "state" | "since">, now = new Date()): string {
  if (!row.since) return "";
  const at = new Date(row.since);
  if (Number.isNaN(at.getTime())) return "";
  const when = day(at) === day(now) ? time(at) : `${at.toLocaleDateString("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit" })} ${time(at)}`;
  return `${row.state === "paused" ? "Paused at" : "Since"} ${when}`;
}

/** How long it has been running: "6h 25m", "12m"; "" when not running. */
export function elapsedText(row: Pick<FloorRow, "state" | "since">, now = new Date()): string {
  if (row.state !== "running" || !row.since) return "";
  const ms = now.getTime() - new Date(row.since).getTime();
  if (!Number.isFinite(ms)) return "";
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${String(mins % 60).padStart(2, "0")}m` : `${mins}m`;
}

/** "Due Thu 5 Nov", "No due date", or a dash when the job couldn't be read. */
export function dueText(job: FloorJob, detailsFailed: boolean): string {
  if (job.due) return `Due ${fmtDueBy(job.due)}`;
  return detailsFailed ? "Due —" : "No due date";
}

/** A count for the summary line: a dash when it couldn't be read, never 0. */
export const countText = (value: number | null) => (value === null ? "—" : String(value));
