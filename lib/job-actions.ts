/**
 * Start / Finish eligibility for the Job Board, shared by the cards, the compact list, the full table and the bulk
 * actions, so every surface agrees on when an action is allowed.
 *
 * The rules (unchanged from what the board already did, now in one place):
 * - A viewer sees neither action.
 * - A job in rework (failed inspection, not yet re-inspected) hides both: the rework dialog drives it.
 * - Start is allowed once: it is disabled as soon as the job has started, finished or been inspected.
 * - Finish is allowed once: it is disabled as soon as the job has finished or been inspected.
 * - A recorded started_at / finished_at is never replaced. The patch builders return null when the timestamp
 *   exists, so the client never sends a new one; the board also filters its update on "timestamp is still empty".
 */

import type { OutboxEntry } from "@/lib/offline/outbox";

export type JobActionState = {
  started_at?: string | null;
  finished_at?: string | null;
  inspected_at?: string | null;
  stage?: string | null;
};

/** A failed inspection holds the job in the rework stage (migration 037) until the rework is finished and it is inspected again. */
export const isInRework = (job: JobActionState) => job.stage === "rework" && !job.inspected_at;

export type ActionCheck = {
  /** false: do not render the control at all (viewer, rework). */
  shown: boolean;
  /** true: the control can be used now. */
  enabled: boolean;
  /** Why it is disabled or hidden (empty when enabled). */
  reason: string;
};

export type ActionContext = { viewer: boolean };

export function startCheck(job: JobActionState, context: ActionContext): ActionCheck {
  if (context.viewer) return { shown: false, enabled: false, reason: "Read-only view" };
  if (isInRework(job)) return { shown: false, enabled: false, reason: "In rework" };
  if (job.inspected_at) return { shown: true, enabled: false, reason: "Already inspected" };
  if (job.finished_at) return { shown: true, enabled: false, reason: "Already finished" };
  if (job.started_at) return { shown: true, enabled: false, reason: "Already started" };
  return { shown: true, enabled: true, reason: "" };
}

/**
 * Start on a bench job that is Paused (migration 046: its latest bench run ended with a Pause, no run open): Start resumes it, opening a new
 * bench run; the job's recorded start time is never replaced. Any other job: startCheck as it is.
 */
export function benchStartCheck(job: JobActionState, context: ActionContext, paused: boolean): ActionCheck {
  const base = startCheck(job, context);
  if (!paused || !base.shown || job.finished_at || job.inspected_at || !job.started_at) return base;
  return { shown: true, enabled: true, reason: "" };
}

export function finishCheck(job: JobActionState, context: ActionContext): ActionCheck {
  if (context.viewer) return { shown: false, enabled: false, reason: "Read-only view" };
  if (isInRework(job)) return { shown: false, enabled: false, reason: "In rework" };
  if (job.inspected_at) return { shown: true, enabled: false, reason: "Already inspected" };
  if (job.finished_at) return { shown: true, enabled: false, reason: "Already finished" };
  return { shown: true, enabled: true, reason: "" };
}

export type StartPatch = { started_at: string };
export type FinishPatch = { finished_at: string; stage: "inspection"; started_at?: string };

/** The update that starts a job, or null when it already has a start time (or cannot be started): never a new timestamp. */
export function startPatch(job: JobActionState, at: string): StartPatch | null {
  return startCheck(job, { viewer: false }).enabled ? { started_at: at } : null;
}

/**
 * The update that finishes a job, or null when it already has a finish time (or cannot be finished). Finishing a job
 * that was never started also records the start (same moment), so it reads as done; an existing start is kept.
 */
export function finishPatch(job: JobActionState, at: string): FinishPatch | null {
  if (!finishCheck(job, { viewer: false }).enabled) return null;
  return job.started_at ? { finished_at: at, stage: "inspection" } : { started_at: at, finished_at: at, stage: "inspection" };
}

/**
 * The stage a Start moves the job to (the board's stages: material, setup, machining, inspection, complete; rework is its own). Starting
 * work means the job is past "Material": a Start moves it to Machining by default, or to Setup when the person chooses that. A job already
 * at or past the chosen stage keeps its stage (never moved back), and a job in rework is never touched (037's guard refuses it anyway).
 */
export const START_STAGES = ["setup", "machining"] as const;
export type StartStage = (typeof START_STAGES)[number];
export const DEFAULT_START_STAGE: StartStage = "machining";

/** The stages a Start may move a job FROM to reach `to` (an empty stage reads as "material", as the board shows it). */
export function stagesBeforeStart(to: StartStage): string[] {
  return to === "machining" ? ["material", "setup"] : ["material"];
}

/** The stage the job moves to on Start, or null when it stays where it is. */
export function stageAfterStart(current: string | null | undefined, to: StartStage = DEFAULT_START_STAGE): StartStage | null {
  return stagesBeforeStart(to).includes(current || "material") ? to : null;
}

/**
 * Who may Play or Pause (start_machine_run / pause_machine_run, migrations 044/046/049: admin, office or workshop; a viewer is refused with
 * 42501). The Job Board hides Play/Pause for anyone else.
 */
export const PAUSE_ROLES = ["admin", "office", "workshop"] as const;
export const canPauseRole = (role: string | null | undefined) => (PAUSE_ROLES as readonly string[]).includes(role ?? "");

export type BulkKind = "start" | "finish";
export type BulkJob = JobActionState & { id: string; job_no: string };
export type BulkPlan<T extends BulkJob> = {
  targets: Array<{ job: T; patch: StartPatch | FinishPatch }>;
  skipped: Array<{ job: T; reason: string }>;
};

/** Which of the selected jobs a bulk Start / Finish would really change, and why the others are left alone. */
export function planBulk<T extends BulkJob>(kind: BulkKind, jobs: T[], at: string, context: ActionContext = { viewer: false }): BulkPlan<T> {
  const plan: BulkPlan<T> = { targets: [], skipped: [] };
  for (const job of jobs) {
    const check = (kind === "start" ? startCheck : finishCheck)(job, context);
    const patch = check.enabled ? (kind === "start" ? startPatch(job, at) : finishPatch(job, at)) : null;
    if (patch) plan.targets.push({ job, patch });
    else plan.skipped.push({ job, reason: check.reason || "Not allowed" });
  }
  return plan;
}

/**
 * Why a bulk Start / Finish is unavailable: none of the selected jobs can take it (already started, finished, in rework, or the
 * viewer may not). null when there is nothing selected (the caller says "select a job first") or at least one job would change.
 */
export function bulkDisabledReason<T extends BulkJob>(kind: BulkKind, jobs: T[], context: ActionContext = { viewer: false }): string | null {
  if (!jobs.length || planBulk(kind, jobs, "", context).targets.length) return null;
  return `None of the selected jobs can be ${kind === "start" ? "started" : "finished"}`;
}

/** The selection with the jobs that are no longer shown dropped, so a bulk action acts only on visible jobs. The same array when nothing is dropped. */
export function keepVisibleSelected(selected: string[], visibleIds: ReadonlySet<string>): string[] {
  const kept = selected.filter((id) => visibleIds.has(id));
  return kept.length === selected.length ? selected : kept;
}

/** Targets that share one update, so each group is a single database call. */
export function groupByPatch<T extends BulkJob>(targets: BulkPlan<T>["targets"]) {
  const groups = new Map<string, { patch: StartPatch | FinishPatch; ids: string[] }>();
  for (const { job, patch } of targets) {
    const key = JSON.stringify(patch);
    const group = groups.get(key) ?? { patch, ids: [] };
    group.ids.push(job.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** "J-1, J-2, J-3 +4 more": a long list is cut after `max` names, with the number left out. */
export function summariseJobNumbers(numbers: string[], max = 8): string {
  if (numbers.length <= max) return numbers.join(", ");
  return `${numbers.slice(0, max).join(", ")} +${numbers.length - max} more`;
}

/**
 * Why jobs weren't updated: the update only reaches rows whose time is still empty, so a job missing from the result was
 * either already started/finished elsewhere (its recorded time is kept) or removed / no longer visible to this person.
 */
export function missedReason(kind: "start" | "finish", alreadyDone: number, gone: number): string {
  const parts: string[] = [];
  const done = kind === "start" ? "started" : "finished";
  if (alreadyDone) parts.push(`${alreadyDone === 1 ? "1 was" : `${alreadyDone} were`} already ${done}, so the recorded time is kept`);
  if (gone) parts.push(`${gone === 1 ? "1 was" : `${gone} were`} removed, or you no longer have access`);
  return parts.join("; ");
}

// ----- 049: one Play/Pause control (plan 2.1, R2.3, R3.4) -------------------------------------------------------------------------

/**
 * What the board knows about a job's runs from the server: the open machine runs (machines_in_use), an open bench run (bench_runs_state),
 * and the latest closed run (the run-state read of R2.3). `hasRuns`: any run at all, open or closed.
 */
export type JobRunState = {
  jobId: string;
  /** Machine ids the job holds now. */
  machines: string[];
  /** Its bench run is open (046). */
  bench: boolean;
  hasRuns?: boolean;
  /** How its latest closed run ended: paused, to_machine, admin_released, override, finished. */
  lastEnd?: string | null;
};

/** The job's state as the board shows it: the server's, with this device's pending Starts and Pauses folded in, in capture order. */
export type RunView = {
  running: boolean;
  /** Running or paused on the bench. */
  bench: boolean;
  /** Machine ids it runs on (empty when paused or on the bench). */
  machines: string[];
  /** A pending Start or Pause of this device decided the state. */
  waiting: boolean;
  /** One of those entries waits for an app/server update (R3.3). */
  blocked: boolean;
  /** A pending Start or Pause exists for the job (folded or not). */
  pending: number;
};

const unique = (ids: string[]) => [...new Set(ids)];

/**
 * The fold (R3.4): server state, then each pending run_start / run_pause (and a legacy keyed start / pause) of the job in outbox order, which
 * is capture order (enqueue only appends). Blocked entries are included (they are still pending); held entries are not in the outbox.
 *  - a Start: running, on its machines (added to what runs) or the bench, waiting;
 *  - a Pause: if the folded state is running, paused, waiting; otherwise nothing changes.
 * So a pending Start followed by a Pause shows "Paused, waiting to sync" with Play; a Pause then a Start on a running job shows running.
 */
export function pendingRunView(server: JobRunState, entries: OutboxEntry[]): RunView {
  let view: RunView = { running: server.machines.length > 0 || server.bench, bench: server.bench && server.machines.length === 0, machines: [...server.machines], waiting: false, blocked: false, pending: 0 };
  for (const entry of entries) {
    const op = entry.op;
    if (op.kind === "run_start" || (op.kind === "start" && op.clientOpId && Array.isArray(op.machines))) {
      if ((op.kind === "run_start" ? op.jobRef : op.jobId) !== server.jobId) continue;
      const machines = op.kind === "run_start" ? op.machines : op.machines ?? [];
      const bench = op.kind === "run_start" ? op.bench : machines.length === 0;
      view.pending += 1;
      // A bench Start while machines run is refused by the server (046): it changes nothing here either.
      if (bench && view.machines.length) view = { ...view, waiting: true };
      else view = { ...view, running: true, bench, machines: bench ? [] : unique([...view.machines, ...machines]), waiting: true };
      if (entry.blocked) view.blocked = true;
    } else if (op.kind === "run_pause" || op.kind === "pause") {
      if ((op.kind === "run_pause" ? op.jobRef : op.jobId) !== server.jobId) continue;
      view.pending += 1;
      if (entry.blocked) view.blocked = true;
      if (!view.running) continue;
      const named = op.machines;
      if (named && named.length) {
        // A Pause naming machines ends only those machines' runs (never the bench run).
        const rest = view.machines.filter((id) => !named.includes(id));
        view = { ...view, machines: rest, running: rest.length > 0 || view.bench, waiting: true };
      } else {
        view = { ...view, running: false, machines: [], waiting: true };
      }
    }
  }
  return view;
}

/** "Running on Mill, waiting to sync" / "On the bench, waiting to sync" / "Paused, waiting to sync", plus the update suffix when blocked. */
export function runViewLabel(view: RunView, machineName: (id: string) => string = () => "a machine"): string | null {
  if (!view.waiting) return view.blocked ? "Waiting: needs an app/server update" : null;
  const base = view.running
    ? view.bench ? "On the bench, waiting to sync" : `Running on ${view.machines.map(machineName).join(", ") || "a machine"}, waiting to sync`
    : "Paused, waiting to sync";
  return view.blocked ? `${base} · needs an app/server update` : base;
}

export type PlayStateKind = "hidden" | "not_started" | "started_untimed" | "running_machine" | "running_bench" | "paused" | "stopped_admin" | "stopped_override" | "finished" | "inspected" | "rework";
export type PlayState = {
  kind: PlayStateKind;
  /** The control: play (green outline), pause (solid amber), or none. */
  button: "play" | "pause" | null;
  /** The word on the button. */
  label: string;
  /** Its accessible name ("Start J-123", "Pause J-123, stops the job and frees Mill, Lathe"). */
  aria: string;
  /** The row's progress words ("Started (not timed)", "Paused", "Stopped (taken over)"...). */
  status: string;
};

/**
 * Play/Pause for one job (plan 2.1, R2.3): from the job's times, the role, rework, and its run view (server + pending ops). Play shows
 * for a job that isn't running; Pause only while the folded state is running (a server-confirmed open run, or a pending Start not
 * followed by a pending Pause): never a false Pause.
 */
/**
 * The words for a job stopped by an admin's Release machine: "Stopped by Sam Admin: Forgot to finish" (who released it and the reason
 * they gave, 092), the same on the Job Board and on the job time rows. Without a name or a reason, as much as is known.
 */
export function adminStopText(name?: string | null, reason?: string | null): string {
  const who = name?.trim();
  const why = reason?.trim();
  if (who && why) return `Stopped by ${who}: ${why}`;
  if (who) return `Stopped by ${who} (machine released)`;
  if (why) return `Stopped (machine released by admin): ${why}`;
  return "Stopped (machine released by admin)";
}

export function playState(job: JobActionState & { job_no: string }, context: ActionContext, view: RunView, facts: { hasRuns?: boolean; lastEnd?: string | null; releasedBy?: string | null; releaseReason?: string | null } = {}, machineName: (id: string) => string = () => "a machine"): PlayState {
  const none = (kind: PlayStateKind, status: string): PlayState => ({ kind, button: null, label: "", aria: "", status });
  if (context.viewer) return none("hidden", job.inspected_at ? "Inspected" : job.finished_at ? "Waiting for inspection" : job.started_at ? "Running" : "Not started");
  if (isInRework(job)) return none("rework", "Failed inspection, being reworked");
  if (job.inspected_at) return none("inspected", "Inspected");
  if (job.finished_at) return none("finished", "Waiting for inspection");
  if (view.running) {
    if (view.bench) return { kind: "running_bench", button: "pause", label: "Pause", aria: `Pause ${job.job_no}`, status: "On the bench" };
    const names = view.machines.map(machineName).join(", ");
    return { kind: "running_machine", button: "pause", label: "Pause", aria: `Pause ${job.job_no}, stops the job and frees ${names || "the machine"}`, status: `Running on ${names || "a machine"}` };
  }
  if (!job.started_at && !view.waiting) return { kind: "not_started", button: "play", label: "Start", aria: `Start ${job.job_no}`, status: "Not started" };
  if (view.waiting) return { kind: "paused", button: "play", label: "Resume", aria: `Resume ${job.job_no}`, status: "Paused" };
  if (!facts.hasRuns) return { kind: "started_untimed", button: "play", label: "Start timer", aria: `Start timer ${job.job_no}`, status: "Started (not timed)" };
  if (facts.lastEnd === "admin_released") return { kind: "stopped_admin", button: "play", label: "Resume", aria: `Resume ${job.job_no}`, status: adminStopText(facts.releasedBy, facts.releaseReason) };
  if (facts.lastEnd === "override") return { kind: "stopped_override", button: "play", label: "Resume", aria: `Resume ${job.job_no}`, status: "Stopped (taken over)" };
  return { kind: "paused", button: "play", label: "Resume", aria: `Resume ${job.job_no}`, status: "Paused" };
}

/** The machines Play starts on, as the Machine column shows them before Play (plan R2.4). */
export type MachinePick = { machines: string[]; bench: boolean };
/** Something is chosen: a machine, or the bench ticked on purpose (never a guessed default). The phone sheet's Start needs it. */
export function pickIsChosen(pick: MachinePick): boolean { return pick.bench || pick.machines.length > 0; }
/**
 * The column's preselection: Resume is prefilled with what the job last ran on (its machines, or the bench); otherwise the FREE planned
 * machines. A machine another job holds is never preselected. Nothing preselected (all planned busy, or no plan): Play asks for a pick.
 */
export function defaultPick(input: { planned: string[]; lastMachines?: string[]; lastBench?: boolean; resuming: boolean; busy: (machineId: string) => boolean }): MachinePick {
  if (input.resuming && (input.lastMachines?.length || input.lastBench)) {
    const free = (input.lastMachines ?? []).filter((id) => !input.busy(id));
    if (free.length) return { machines: free, bench: false };
    if (input.lastBench && !(input.lastMachines ?? []).length) return { machines: [], bench: true };
  }
  return { machines: input.planned.filter((id) => !input.busy(id)), bench: false };
}
