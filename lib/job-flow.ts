/**
 * The job flow (migration 081): In progress -> Finished (work done, awaiting inspection) -> Complete (inspection passed). There is no
 * "Done". The database works the flow out from the job's own row (public.flow_status(job)); flowStatusOf is the same rule for the app,
 * for a row read before 081 or kept on the device.
 *
 *   complete     inspected_at set (a pass, or an admin's concession) and not in rework;
 *   in_progress  in the rework stage: put back after a failed inspection (or replacements to make);
 *   finished     finished_at set;
 *   in_progress  otherwise.
 *
 * What people see (UI consistency release gate, Rhys Wed 21 Oct): four job statuses, a display mapping only (nothing stored changes):
 *
 *   Not started             in_progress, never started (no started_at) and not in rework;
 *   Running                 in_progress, started (or in rework: Rework is a purple TAG on a Running job, never a status);
 *   Waiting for inspection  finished;
 *   Complete                complete (never "Done").
 *
 * Open = Not started + Running + Waiting for inspection (everything not Complete; an unfinished job is never archived).
 * Stages: Material, Setup, Machining, Inspection. Despatch is an action, not a stage; rework is a tag, not a stage.
 */
import type { StatusKey } from "@/lib/status-colours";

export type FlowStatus = "in_progress" | "finished" | "complete";
export type FlowJob = { finished_at?: string | null; inspected_at?: string | null; stage?: string | null; flow_status?: string | null; finished_by?: string | null; started_at?: string | null };

/** The job was put back to In progress by a failed inspection (or for replacements): the visible "put back" flag. */
export const isPutBack = (job: FlowJob) => job.stage === "rework" && !job.inspected_at;

export function flowStatusOf(job: FlowJob): FlowStatus {
  if (job.stage === "rework") return "in_progress";
  if (job.inspected_at) return "complete";
  if (job.finished_at) return "finished";
  return "in_progress";
}

/** The four statuses shown to people, in board order. */
export type JobStatusKey = "not_started" | "running" | "waiting_for_inspection" | "complete";
export const JOB_STATUSES: readonly JobStatusKey[] = ["not_started", "running", "waiting_for_inspection", "complete"];
export const JOB_STATUS_LABELS: Record<JobStatusKey, string> = { not_started: "Not started", running: "Running", waiting_for_inspection: "Waiting for inspection", complete: "Complete" };
/** Each status's colour on the one map (grey, blue, yellow, green). */
export const JOB_STATUS_BADGE: Record<JobStatusKey, StatusKey> = { not_started: "not_started", running: "in_progress", waiting_for_inspection: "awaiting_inspection", complete: "complete" };

/** The job's status as shown: from the flow (081) and whether it has started. A job in rework is Running (with the Rework tag). */
export function jobStatusOf(job: FlowJob): JobStatusKey {
  const flow = flowStatusOf(job);
  if (flow === "complete") return "complete";
  if (flow === "finished") return "waiting_for_inspection";
  return job.started_at || job.stage === "rework" ? "running" : "not_started";
}

/** Open = not Complete: Not started, Running (rework included) and Waiting for inspection. */
export const isOpenJob = (job: FlowJob) => jobStatusOf(job) !== "complete";

/** The Rework tag: shown on a job in the rework stage (always Running). */
export const hasReworkTag = (job: FlowJob) => job.stage === "rework";

/**
 * The status badge (colour and word) for a job. `paused`: the Job Board's Play state says the job is paused (its run was paused and nothing
 * runs): a started job then shows a yellow "Paused" badge instead of "Running". Display only: jobStatusOf, the status tiles, the filters and
 * the stored flow are unchanged (a paused job is still counted as Running).
 */
export function flowBadge(job: FlowJob, opts: { paused?: boolean } = {}): { status: StatusKey; label: string } {
  const status = jobStatusOf(job);
  if (opts.paused && status === "running") return { status: "waiting_on_supplier", label: "Paused" };
  return { status: JOB_STATUS_BADGE[status], label: JOB_STATUS_LABELS[status] };
}

/**
 * The tag beside the status: purple Rework on a job in rework; red Failed inspection while that rework's failed inspection has no
 * disposition recorded (`failedUndecided`, a fail recorded the older way, before 081). null for any other job.
 */
export function reworkTag(job: FlowJob, failedUndecided = false): { status: StatusKey; label: string } | null {
  if (!hasReworkTag(job)) return null;
  return failedUndecided && isPutBack(job) ? { status: "failed_inspection", label: "Failed inspection" } : { status: "rework", label: "Rework" };
}

/** The four stages, as shown. A stored "material" (or no stage yet) is Material; "complete" and "rework" are not stages. */
export type JobStage = "material" | "setup" | "machining" | "inspection";
export const JOB_STAGES: readonly JobStage[] = ["material", "setup", "machining", "inspection"];
export const STAGE_LABELS: Record<JobStage, string> = { material: "Material", setup: "Setup", machining: "Machining", inspection: "Inspection" };
export function stageOf(stage: string | null | undefined): JobStage | null {
  const value = stage || "material";
  return (JOB_STAGES as readonly string[]).includes(value) ? (value as JobStage) : null;
}
/** The stage word, or a dash for a job whose stored stage is not one of the four (Complete, or in rework: its status and tag say so). */
export const stageLabel = (stage: string | null | undefined) => { const key = stageOf(stage); return key ? STAGE_LABELS[key] : "\u2014"; };

/**
 * Database filters (PostgREST `or`) with the same rules, for counts read without the rows (the dashboard).
 * Open: not Complete (in rework, or not inspected). Running: in rework, or started and neither finished nor inspected.
 */
export const OPEN_JOBS_FILTER = "stage.eq.rework,inspected_at.is.null";
export const RUNNING_JOBS_FILTER = "stage.eq.rework,and(finished_at.is.null,inspected_at.is.null,started_at.not.is.null)";
/** Open jobs whose required date (date_required, or due_date for older rows) falls between two dates (inclusive): one `or`. */
export function openJobsDueFilter(from: string, to: string): string {
  const open = ["stage.eq.rework", "inspected_at.is.null"];
  const dates = [`date_required.gte.${from},date_required.lte.${to}`, `due_date.gte.${from},due_date.lte.${to}`];
  return open.flatMap((scope) => dates.map((range) => `and(${scope},${range})`)).join(",");
}

export type ReopenContext = { role: string | null | undefined; me: string | null | undefined };

/**
 * Who may reopen a job (reopen_job, 081): the person who finished it undoes their own Finish while it awaits inspection; the office or
 * an admin reopens anyone's, a Complete job too. Never a job in rework (finish the rework instead), never one not finished. The server
 * also refuses once a delivery note has gone out or the invoice has been issued, and asks for a reason of at least 10 characters.
 */
export function reopenCheck(job: FlowJob, context: ReopenContext): { allowed: boolean; reason: string } {
  if (!job.finished_at) return { allowed: false, reason: "Not finished" };
  if (isPutBack(job)) return { allowed: false, reason: "In rework: finish the rework instead" };
  const office = context.role === "admin" || context.role === "office";
  if (office) return { allowed: true, reason: "" };
  if (context.role !== "workshop") return { allowed: false, reason: "Read-only view" };
  if (flowStatusOf(job) === "complete") return { allowed: false, reason: "Passed inspection: ask the office or an admin" };
  if (!context.me || job.finished_by !== context.me) return { allowed: false, reason: "Finished by someone else: ask the office or an admin" };
  return { allowed: true, reason: "" };
}

/**
 * Offline Finish (081 follow-up): the jobs whose queued Finish has left the device's queue after a sync pass. A Finish still waiting, or
 * held as a conflict or refused, is not confirmed. `entries` is everything still on the device (pending, conflicts, rejected); a Finish
 * the person discarded is also gone from it, which is why the caller asks the server before it stamps anything (confirmedFinishers).
 */
export function finishesLeftQueue(queuedJobIds: Iterable<string>, entries: { op: { kind: string; jobId?: string } }[]): string[] {
  const remaining = new Set(entries.filter((entry) => entry.op.kind === "finish").map((entry) => entry.op.jobId));
  return [...queuedJobIds].filter((id) => !remaining.has(id));
}

/**
 * Puts the server's own finisher on the board's local jobs, so Reopen (reopenCheck needs finished_by === me) shows for the person whose
 * queued Finish just synced, without a reload (the offline twin of the online stamp in the Job Board). Only a job the board shows as
 * finished, and a row the server says is finished by someone, is touched: a refused or discarded Finish (the server has no finish time)
 * and a job finished by somebody else (their id, so Reopen stays hidden from this person) change nothing wrongly. Same array back when
 * nothing changes.
 */
export function confirmedFinishers<T extends { id: string; finished_at?: string | null; finished_by?: string | null }>(
  jobs: T[], server: { id: string; finished_at?: string | null; finished_by?: string | null }[],
): T[] {
  const by = new Map(server.filter((row) => row.finished_at && row.finished_by).map((row) => [row.id, row.finished_by as string]));
  if (!by.size) return jobs;
  let changed = false;
  const next = jobs.map((job) => {
    const who = by.get(job.id);
    if (!who || !job.finished_at || job.finished_by === who) return job;
    changed = true;
    return { ...job, finished_by: who };
  });
  return changed ? next : jobs;
}

/** The shortest reason reopen_job and release_job_early accept. */
export const REASON_MIN = 10;

/**
 * The admin's early release (release_job_early, 081; 8.6's exception): offered to an admin only, on a customer job that is finished
 * and not Complete (awaiting inspection, or put back after a failure). The server checks all of it again and refuses anyone else.
 */
export function earlyReleaseOffered(job: FlowJob & { is_internal?: boolean | null }, role: string | null | undefined) {
  return role === "admin" && Boolean(job.finished_at) && !job.is_internal && flowStatusOf(job) !== "complete";
}

type RpcClient = { rpc: (fn: "release_job_early", args: { p_job: string; p_reason: string }) => PromiseLike<{ data: unknown; error: unknown }> };

/**
 * Send an early release: the reason is checked here first (at least REASON_MIN characters, as the server does), then release_job_early
 * is called once with it trimmed. Returns what to tell the admin, or the server's refusal (the caller words it with friendlyError).
 */
export async function sendEarlyRelease(client: RpcClient, job: { id: string; job_no: string }, reason: string): Promise<{ ok: true; message: string } | { ok: false; error: unknown; local?: string }> {
  const text = reason.trim();
  if (text.length < REASON_MIN) return { ok: false, error: null, local: `Say why it is released before inspection (at least ${REASON_MIN} characters).` };
  const { data, error } = await client.rpc("release_job_early", { p_job: job.id, p_reason: text });
  if (error) return { ok: false, error };
  const already = Boolean(data && typeof data === "object" && (data as { already?: unknown }).already);
  return { ok: true, message: already ? `${job.job_no} was already released early.` : `${job.job_no} released early: it can go out before inspection. Recorded with your reason.` };
}

/**
 * A draft invoice made for a job (081: one draft per job, made when it is finished; numbered only when issued): "Draft, awaiting
 * inspection" until the job is Complete, then "Ready to issue". null for anything else (an issued invoice, a draft with no job).
 */
export function jobDraftStage(invoice: { status?: string | null; job_id?: string | null }, job: FlowJob | null | undefined): "Draft, awaiting inspection" | "Ready to issue" | null {
  if ((invoice.status ?? "draft").toLowerCase() !== "draft" || !invoice.job_id || !job) return null;
  return flowStatusOf(job) === "complete" ? "Ready to issue" : "Draft, awaiting inspection";
}
