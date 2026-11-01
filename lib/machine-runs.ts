/**
 * Live machine use and operator assignment (migration 044): the pure parts the Job Board, the schedule and the offline replay share.
 * The database holds the guarantee (one open run per machine); these helpers only shape what it returns and what the app sends.
 */
import { fmtDateText, fmtDateTime, fmtDateTimeText } from "@/lib/dates";

/** One open run, as machines_in_use() returns it: names only, never an e-mail. */
export type InUseRow = {
  run_id: string;
  machine_id: string;
  machine_name: string;
  job_id: string;
  job_no: string;
  booking_id: string | null;
  operator_id: string | null;
  operator_name: string | null;
  started_at: string;
  /** Open for 12 hours or more: probably a forgotten Finish or Pause (an admin can release the machine). */
  stale: boolean;
};

/** A row of machines_in_use() as it came over the wire, checked field by field (nothing else is trusted). */
export function inUseRows(rows: unknown): InUseRow[] {
  if (!Array.isArray(rows)) return [];
  const out: InUseRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.run_id !== "string" || typeof r.machine_id !== "string" || typeof r.job_id !== "string" || typeof r.started_at !== "string") continue;
    const name = typeof r.operator_name === "string" && r.operator_name.trim() && !r.operator_name.includes("@") ? r.operator_name.trim() : null;
    out.push({
      run_id: r.run_id, machine_id: r.machine_id, machine_name: typeof r.machine_name === "string" ? r.machine_name : "Machine", job_id: r.job_id,
      job_no: typeof r.job_no === "string" ? r.job_no : "", booking_id: typeof r.booking_id === "string" ? r.booking_id : null,
      operator_id: typeof r.operator_id === "string" ? r.operator_id : null, operator_name: name, started_at: r.started_at, stale: r.stale === true,
    });
  }
  return out;
}

/** The open runs by job and by machine. */
export function indexInUse(rows: InUseRow[]): { byJob: Map<string, InUseRow[]>; byMachine: Map<string, InUseRow> } {
  const byJob = new Map<string, InUseRow[]>();
  const byMachine = new Map<string, InUseRow>();
  for (const row of rows) {
    byJob.set(row.job_id, [...(byJob.get(row.job_id) ?? []), row]);
    byMachine.set(row.machine_id, row);
  }
  return { byJob, byMachine };
}

/** "IN USE: Mill by Dave since 12/10/2026, 09:12" for one run (the chip's text); the person is "—" when there is no name on file. */
export function inUseText(row: InUseRow, now = new Date()): string {
  const since = fmtDateTime(row.started_at);
  const who = row.operator_name ?? "—";
  return `${row.machine_name} by ${who} since ${since}${isStale(row, now) ? " (no Finish or Pause for 12 h+)" : ""}`;
}

export const STALE_AFTER_MS = 12 * 3_600_000;
/** Stale as the server said, or as the clock says now (the row may be older than the page). */
export function isStale(row: Pick<InUseRow, "started_at" | "stale">, now = new Date()): boolean {
  return row.stale || now.getTime() - new Date(row.started_at).getTime() >= STALE_AFTER_MS;
}

/** A machine the board can start a job on. */
export type StartableMachine = { id: string; name: string };
/** One line of the "Start on which machine?" sheet: planned machines first (preselected), the rest after. */
export type StartChoice = { machine: StartableMachine; planned: boolean; booked: boolean; inUse: InUseRow | null; preselected: boolean };

export function startChoices(machines: StartableMachine[], plan: { machine_id: string; booked: boolean }[], inUse: Map<string, InUseRow>, jobId: string): StartChoice[] {
  const planned = new Map(plan.map((p) => [p.machine_id, p]));
  const sorted = [...machines].sort((a, b) => Number(planned.has(b.id)) - Number(planned.has(a.id)) || a.name.localeCompare(b.name));
  return sorted.map((machine) => {
    const p = planned.get(machine.id);
    const live = inUse.get(machine.id) ?? null;
    // Held by another job: not preselected even when planned (the person decides, or an admin takes it over).
    const takenByOther = Boolean(live && live.job_id !== jobId);
    return { machine, planned: Boolean(p), booked: Boolean(p?.booked), inUse: live, preselected: Boolean(p) && !takenByOther };
  });
}

/** The board grouped by machine: a job sits under each machine it is planned for or running on, else under "No machine". */
export type MachineGroup<T> = { key: string; title: string; jobs: T[] };
export const NO_MACHINE_GROUP = "No machine";
export function groupJobsByMachine<T extends { id: string }>(jobs: T[], machinesOf: (job: T) => { machine_id: string; name: string }[]): MachineGroup<T>[] {
  const groups = new Map<string, MachineGroup<T>>();
  const none: T[] = [];
  for (const job of jobs) {
    const machines = machinesOf(job);
    if (!machines.length) { none.push(job); continue; }
    const seen = new Set<string>();
    for (const m of machines) {
      if (seen.has(m.machine_id)) continue;
      seen.add(m.machine_id);
      const group = groups.get(m.machine_id) ?? { key: m.machine_id, title: `On ${m.name}`, jobs: [] };
      group.jobs.push(job);
      groups.set(m.machine_id, group);
    }
  }
  const out = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  if (none.length) out.push({ key: "none", title: NO_MACHINE_GROUP, jobs: none });
  return out;
}

/** A new client operation id (the server's idempotency key for an offline Start or Pause). */
export const newClientOpId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

/** The server's refusal hints that mean something specific to the person. */
const REFUSAL_HINTS = ["machine_in_use", "job_finished", "time_too_old", "assign_self_only", "assignee_not_allowed", "override_reason", "finish_via_rpc", "client_op_reused", "run_overlap", "bench_run_open",
  "paused_ack_invalid", "bench_with_machines", "paused_ack_same_job", "support_read_only", "mfa_required"] as const;
export type RunRefusal = { hint: (typeof REFUSAL_HINTS)[number]; message: string };
export function runRefusal(error: unknown): RunRefusal | null {
  const e = error as { hint?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return null;
  const hint = typeof e.hint === "string" ? (REFUSAL_HINTS as readonly string[]).find((h) => h === e.hint) : undefined;
  if (hint) return { hint: hint as RunRefusal["hint"], message: typeof e.message === "string" ? e.message : "The server refused this change." };
  return null;
}

/** One device time the server could not honour (migration 044): the run started or ended at the server's time instead. A bench run (046)
 *  has no machine: machine_id null (bench true on a Start). */
export type RunTimeConflict = { machine_id: string | null; machine?: string | null; bench?: boolean; what: "start" | "end"; why: string; device_at: string | null; used_at: string | null };

/** The time conflicts in a start_machine_run, pause_machine_run or finish_job answer (none: an empty list). */
export function timeConflictsOf(data: unknown): RunTimeConflict[] {
  const list = (data as { time_conflicts?: unknown } | null)?.time_conflicts;
  return Array.isArray(list) ? (list.filter((c) => c && typeof c === "object") as RunTimeConflict[]) : [];
}

/** What the person is told when an offline Start, Pause or Finish synced but its device time would have overlapped the machine's record. */
export function runTimeConflictReason(jobNo: string, action: "Start" | "Pause" | "Finish", conflicts: RunTimeConflict[]): string {
  const at = (v: string | null) => (v ? fmtDateTimeText(v, { numberAs: "number" }) : "now");
  const bench = (c: RunTimeConflict) => c.bench === true || c.machine_id === null;
  const parts = conflicts.map((c) => `${bench(c) ? "the bench" : c.machine ?? "the machine"}: ${c.what === "start" ? "started" : "ended"} at ${at(c.used_at)} instead of ${at(c.device_at)}`);
  const starts = conflicts.filter((c) => c.what === "start");
  const why = starts.length
    ? (starts.every(bench) ? "the job already has bench time recorded after that time"
      : starts.every((c) => String(c.why ?? "").startsWith("before_bench_run")) ? "the job was on the bench after that time" : "the machine already has use recorded after that time")
    : "that time is before the run started";
  return `${jobNo}: the ${action} made offline synced, but its time couldn't be used because ${why}. The server's time was used and both times are recorded (${parts.join("; ")}). Check the ${conflicts.every(bench) ? "job's bench" : "machine's"} times.`;
}

/** What the person is told when a Start made offline reached the server after someone else took the machine. */
export function replayedStartClashReason(jobNo: string, serverMessage: string): string {
  return `${jobNo} was started while you were offline, but when it synced the machine was already in use: ${serverMessage} The job is recorded as started without the machine. Start it on a free machine, or ask an admin to take the machine over.`;
}

/**
 * A job's latest bench run (migration 046: a run with no machine, for a job worked on the bench), as bench_runs_state() returns it for each
 * unfinished job, with the job's actual active work (`state`): on_machine (a machine run is open: never Paused, never on the bench),
 * on_bench (its bench run is open: Pause shows), paused (nothing open, its latest bench run ended 'paused' or 'to_machine': Start resumes
 * it on the bench), idle.
 */
export type BenchActivity = "on_machine" | "on_bench" | "paused" | "idle";
export type BenchRow = { job_id: string; run_id: string; is_open: boolean; started_at: string; ended_at: string | null; end_reason: string | null; operator_id: string | null; operator_name: string | null; on_machine: boolean; state: BenchActivity };
const ACTIVITIES: readonly string[] = ["on_machine", "on_bench", "paused", "idle"];
/** The state from the row's facts (a row kept on the device before 046's state column, or one changed on this device). */
function activityOf(isOpen: boolean, endReason: string | null, onMachine: boolean): BenchActivity {
  if (onMachine) return "on_machine";
  if (isOpen) return "on_bench";
  return endReason === "paused" || endReason === "to_machine" ? "paused" : "idle";
}

/** The rows of bench_runs_state() as they came over the wire, checked field by field (nothing else is trusted). */
export function benchRows(rows: unknown): BenchRow[] {
  if (!Array.isArray(rows)) return [];
  const out: BenchRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.job_id !== "string" || typeof r.run_id !== "string" || typeof r.started_at !== "string") continue;
    const name = typeof r.operator_name === "string" && r.operator_name.trim() && !r.operator_name.includes("@") ? r.operator_name.trim() : null;
    const isOpen = r.is_open === true;
    const endReason = typeof r.end_reason === "string" ? r.end_reason : null;
    const onMachine = r.on_machine === true || r.state === "on_machine";
    out.push({
      job_id: r.job_id, run_id: r.run_id, is_open: isOpen, started_at: r.started_at, ended_at: typeof r.ended_at === "string" ? r.ended_at : null,
      end_reason: endReason, operator_id: typeof r.operator_id === "string" ? r.operator_id : null, operator_name: name, on_machine: onMachine,
      state: typeof r.state === "string" && ACTIVITIES.includes(r.state) ? (r.state as BenchActivity) : activityOf(isOpen, endReason, onMachine),
    });
  }
  return out;
}

/**
 * The bench state of one job: running (on the bench now), paused (nothing runs, its last bench run was paused or moved to a machine whose
 * runs have ended), on_machine (a machine run is open: the job's work is on the machine, so it is neither Paused nor on the bench), or none.
 * `machineOpen`: the board's live machine runs for the job (machines_in_use), which win over a stale bench row.
 */
export type BenchState = "running" | "paused" | "on_machine" | null;
export function benchState(row: BenchRow | undefined, job: { finished_at?: string | null }, machineOpen = false): BenchState {
  if (!row || job.finished_at) return null;
  if (machineOpen || row.state === "on_machine") return "on_machine";
  if (row.state === "on_bench") return "running";
  return row.state === "paused" ? "paused" : null;
}

/**
 * The board's copy after a Start, Pause or Finish made on this device (offline, or before the reload): the job's bench row as it now is.
 * "machine": a Start on machines (046: the bench run, if open, ends 'to_machine'; the job is on a machine).
 */
export function benchAfter(rows: BenchRow[], jobId: string, action: "start" | "pause" | "finish" | "machine", at: string, operatorId: string | null = null): BenchRow[] {
  const current = rows.find((r) => r.job_id === jobId);
  const rest = rows.filter((r) => r.job_id !== jobId);
  if (action === "finish") return rest;
  if (action === "machine") {
    if (!current) return rows;
    return [...rest, current.is_open ? { ...current, is_open: false, ended_at: at, end_reason: "to_machine", on_machine: true, state: "on_machine" } : { ...current, on_machine: true, state: "on_machine" }];
  }
  if (action === "pause") {
    if (!current) return rows;
    if (current.is_open) return [...rest, { ...current, is_open: false, ended_at: at, end_reason: "paused", on_machine: false, state: "paused" }];
    // A Pause of the job's machine runs: back to how its last bench run ended. Nothing running: nothing changes.
    if (current.state === "on_machine") return [...rest, { ...current, on_machine: false, state: activityOf(false, current.end_reason, false) }];
    return rows;
  }
  // A bench Start: refused while on a machine (the server says on_machine); else running on the bench.
  if (current?.is_open || current?.state === "on_machine") return rows;
  return [...rest, { job_id: jobId, run_id: `local-${jobId}-${at}`, is_open: true, started_at: at, ended_at: null, end_reason: null, operator_id: operatorId, operator_name: null, on_machine: false, state: "on_bench" }];
}

/** What start_machine_run answered for a Start that named no machine (046). */
export type BenchStartAnswer = { started_at?: string; job_start_stamped?: boolean; bench_run?: { run_id: string; already: boolean } | null; bench_skipped?: string | null };
/**
 * How a bench Start came out: started (the job's start stamped and its bench run opened), resumed (a new bench run after a Pause), running
 * (it was already on the bench), or unchanged: started some other way and never on the bench (its recorded start is kept), or on a machine.
 */
export function benchStartOutcome(answer: BenchStartAnswer | null | undefined): "started" | "resumed" | "running" | "already_started" | "on_machine" {
  if (answer?.bench_run) return answer.bench_run.already ? "running" : answer.job_start_stamped ? "started" : "resumed";
  if (answer?.job_start_stamped) return "started";
  return answer?.bench_skipped === "on_machine" ? "on_machine" : "already_started";
}

// ----- 049: Play/Pause, the paused-machine warning, server skew ------------------------------------------------------------------

/** What start_machine_run answers (044/046, plus 049's paused_warnings). */
export type PausedWarning = { machine_id: string; machine?: string | null; paused_run_id: string; job_no: string | null; operator_name: string | null; paused_by_name: string | null; paused_at: string | null };
export type RunStartAnswer = BenchStartAnswer & {
  job_id?: string; job_no?: string; runs?: { run_id: string; machine_id: string; machine?: string; started_at?: string; already?: boolean }[];
  time_conflicts?: unknown[]; paused_warnings?: PausedWarning[]; replayed?: boolean;
};

/** Whether the answer holds every run the Start asked for: each requested machine in `runs`, and the bench run when the bench was asked for. */
export function requestedRunsPresent(op: { machines: string[]; bench: boolean }, answer: RunStartAnswer | null | undefined): boolean {
  if (!answer) return false;
  const got = new Set((answer.runs ?? []).map((run) => run.machine_id));
  if (!op.machines.every((id) => got.has(id))) return false;
  if (op.bench && !answer.bench_run) return false;
  return true;
}

/** What a Start that came back without what it asked for is held with (never shown as synced). */
export function missingRunsReason(op: { jobNo: string; machines: string[]; bench: boolean }, answer: RunStartAnswer | null | undefined, name: (id: string) => string = () => "a machine"): string {
  if (op.bench && !answer?.bench_run) {
    if (answer?.bench_skipped === "on_machine") return `${op.jobNo} was running on a machine when this Start synced, so it wasn't started on the bench. Nothing changed.`;
    return `${op.jobNo}: the bench Start synced but no bench run was opened${answer?.bench_skipped ? ` (${answer.bench_skipped.replaceAll("_", " ")})` : ""}. Nothing is being timed: press Play again.`;
  }
  const got = new Set((answer?.runs ?? []).map((run) => run.machine_id));
  const missing = op.machines.filter((id) => !got.has(id)).map(name);
  return `${op.jobNo}: the Start synced but ${missing.join(", ") || "a machine"} wasn't started. Press Play again.`;
}

/** The server predates 049 (PostgREST can't find the function with these arguments, or Postgres can't). */
export const isServerTooOld = (error: { code?: string | null } | null | undefined) => error?.code === "PGRST202" || error?.code === "42883";
export const SERVER_UPGRADE_CODE = "server_upgrade_needed";
export const SERVER_UPGRADE_REASON = "Waiting: Tolra needs updating before this Start can sync. Nothing was lost.";
/** The row's suffix while an entry for the job is blocked. */
export const NEEDS_UPDATE_LABEL = "needs an app/server update";

/** One machine whose last run was paused on another unfinished job (paused_machines(), 049): names only, never an e-mail. */
export type PausedRow = { machine_id: string; paused_run_id: string; job_id: string; job_no: string; operator_name: string | null; paused_by_name: string | null; paused_at: string };
export function pausedRows(rows: unknown): PausedRow[] {
  if (!Array.isArray(rows)) return [];
  const clean = (v: unknown) => (typeof v === "string" && v.trim() && !v.includes("@") ? v.trim() : null);
  const out: PausedRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.machine_id !== "string" || typeof r.paused_run_id !== "string" || typeof r.job_id !== "string" || typeof r.paused_at !== "string") continue;
    out.push({ machine_id: r.machine_id, paused_run_id: r.paused_run_id, job_id: r.job_id, job_no: typeof r.job_no === "string" ? r.job_no : "", operator_name: clean(r.operator_name), paused_by_name: clean(r.paused_by_name), paused_at: r.paused_at });
  }
  return out;
}

/** The paused machines a Start of `jobId` on `machineIds` must warn about (same job resuming: none). */
export function pausedFor(rows: PausedRow[], jobId: string, machineIds: string[]): PausedRow[] {
  const wanted = new Set(machineIds);
  return rows.filter((row) => wanted.has(row.machine_id) && row.job_id !== jobId);
}

/** The acknowledgement sent with the Start: exactly the run ids the dialog showed, one per machine. */
export function pausedAckPayload(shown: PausedRow[]): { machine_id: string; paused_run_id: string }[] {
  const seen = new Set<string>();
  const out: { machine_id: string; paused_run_id: string }[] = [];
  for (const row of shown) {
    if (seen.has(row.machine_id)) continue;
    seen.add(row.machine_id);
    out.push({ machine_id: row.machine_id, paused_run_id: row.paused_run_id });
  }
  return out;
}

/** "Mill was paused on J-118 by Dave at 12:05 today and J-118 isn't finished. Check with Dave before using the Mill so the job isn't missed." */
export function pausedWarningText(row: Pick<PausedRow, "job_no" | "operator_name" | "paused_by_name" | "paused_at">, machineName: string, now = new Date()): string {
  const when = new Date(row.paused_at);
  const time = when.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  const sameDay = when.toLocaleDateString("en-GB", { timeZone: "Europe/London" }) === now.toLocaleDateString("en-GB", { timeZone: "Europe/London" });
  const day = sameDay ? "today" : `on ${fmtDateText(when, { numberAs: "number" })}`;
  const operator = row.operator_name ?? "the operator";
  const by = row.paused_by_name && row.paused_by_name !== row.operator_name ? ` (paused by ${row.paused_by_name})` : "";
  const job = row.job_no || "another job";
  return `${machineName} was paused on ${job} by ${operator}${by} at ${time} ${day} and ${job} isn't finished. Check with ${operator} before using the ${machineName} so the job isn't missed.`;
}

/** "Paused: J-118, Dave 12:05" for the machine picker. */
export function pausedChoiceText(row: Pick<PausedRow, "job_no" | "operator_name" | "paused_at">): string {
  const time = new Date(row.paused_at).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  return `Paused: ${row.job_no || "another job"}${row.operator_name ? `, ${row.operator_name}` : ""} ${time}`;
}

/**
 * Each unfinished job's run facts (R2.3), read straight from machine_runs (SELECT for the four roles): whether it has any run at all, which
 * runs are open, and how its latest closed run ended. "Started (not timed)" is a started job with no run of any kind.
 */
export type RunFact = { job_id: string; machine_id: string | null; started_at: string; ended_at: string | null; end_reason: string | null; ended_by: string | null; release_reason: string | null };
/** lastEndedBy / lastReleaseReason: who ended the latest run (its ended_by) and, for an admin's release, the reason on the job time it ended (092). */
export type JobRunFacts = { hasRuns: boolean; openMachines: string[]; benchOpen: boolean; lastEnd: string | null; lastMachines: string[]; lastBench: boolean; lastEndedBy?: string | null; lastReleaseReason?: string | null };
export function runFactsByJob(rows: unknown): Map<string, JobRunFacts> {
  const map = new Map<string, JobRunFacts>();
  if (!Array.isArray(rows)) return map;
  const byJob = new Map<string, RunFact[]>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.job_id !== "string" || typeof r.started_at !== "string") continue;
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    const fact: RunFact = { job_id: r.job_id, machine_id: text(r.machine_id), started_at: r.started_at, ended_at: text(r.ended_at), end_reason: text(r.end_reason), ended_by: text(r.ended_by), release_reason: text(r.release_reason) };
    byJob.set(fact.job_id, [...(byJob.get(fact.job_id) ?? []), fact]);
  }
  for (const [jobId, facts] of byJob) {
    const open = facts.filter((f) => !f.ended_at);
    const closed = facts.filter((f) => f.ended_at).sort((a, b) => b.ended_at!.localeCompare(a.ended_at!));
    const last = closed[0];
    // What the job last ran on: every run that ended at that same moment (one Pause ends them all together).
    const lastSet = last ? closed.filter((f) => f.ended_at === last.ended_at) : [];
    map.set(jobId, {
      hasRuns: facts.length > 0, openMachines: open.filter((f) => f.machine_id).map((f) => f.machine_id!), benchOpen: open.some((f) => !f.machine_id),
      lastEnd: last?.end_reason ?? null, lastMachines: lastSet.filter((f) => f.machine_id).map((f) => f.machine_id!), lastBench: lastSet.some((f) => !f.machine_id),
      lastEndedBy: last?.ended_by ?? null, lastReleaseReason: last?.end_reason === "admin_released" ? last.release_reason : null,
    });
  }
  return map;
}

/** For the board's status line: the releasing admin's name (from the people map; null when unknown) and their reason. */
export function releaseFacts(facts: Pick<JobRunFacts, "lastEnd" | "lastEndedBy" | "lastReleaseReason">, people: Record<string, string | null | undefined>): { releasedBy: string | null; releaseReason: string | null } {
  if (facts.lastEnd !== "admin_released") return { releasedBy: null, releaseReason: null };
  return { releasedBy: (facts.lastEndedBy && people[facts.lastEndedBy]) || null, releaseReason: facts.lastReleaseReason ?? null };
}

/**
 * 092: the reason an admin gave when releasing a machine is kept on the job time the release ended (operator_sessions.end_reason, read
 * under the viewer's own row rules: a workshop member sees their own). Copied onto each released run that ended at the same moment, so
 * the board (and its offline copy) can show it. Before 092, or when it can't be read, the runs are returned as they were.
 */
export function withReleaseReasons(runs: Record<string, unknown>[], sessions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(sessions) || !sessions.length) return runs;
  const at = (v: unknown) => (typeof v === "string" ? new Date(v).getTime() : NaN);
  return runs.map((run) => {
    if (run.end_reason !== "admin_released") return run;
    const s = sessions.find((x) => x && typeof x === "object" && x.job_id === run.job_id && typeof x.end_reason === "string" && at(x.ended_at) === at(run.ended_at));
    return s ? { ...run, release_reason: (s as { end_reason: string }).end_reason } : run;
  });
}
