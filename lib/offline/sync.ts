"use client";

/** Replays queued offline changes against Supabase and runs the sync loop (on reconnect, on focus, every minute). */
import { useEffect } from "react";

import { friendlyError } from "@/lib/friendly-error";
import { type JobWorksheet, saveWorksheet, WorksheetConflictError, WorksheetMissingError } from "@/lib/job-worksheet";
import { type StartStage, stagesBeforeStart } from "@/lib/job-actions";
import { PHOTO_MIME } from "@/lib/photo-image";
import { type BenchStartAnswer, type RunStartAnswer, SERVER_UPGRADE_CODE, SERVER_UPGRADE_REASON, benchStartOutcome, isServerTooOld, missingRunsReason, replayedStartClashReason, requestedRunsPresent, runRefusal, runTimeConflictReason, timeConflictsOf } from "@/lib/machine-runs";
import { readAttachment, rejectedEntries, replayOutbox, requeueHeldRunOps, withReplayLock, type ClockOp, type LabourOp, type OutboxOp, type PauseOp, type PhotoOp, type ReplayOutcome, type RunPauseOp, type RunStartOp, type CustomerSignOffOp, type InspectOp, type InternalSignOffOp, type SignOffOp, type StartOp } from "@/lib/offline/outbox";
import { offlineScope, outboxState, refreshCounts, reportOffline, suspendOfflineAccess } from "@/lib/offline/scope";
import { organizationSwitchAffects } from "@/lib/access-recheck";
import { parseSessionInfo, offlineCopyAllowed } from "@/lib/session-info";
import { CONFIRMED_USER_REUSE_MS, confirmedUser } from "@/lib/confirmed-user";
import { authSessionGone, sessionEndedError } from "@/lib/session-end";
import { isNetworkError, scopeKey } from "@/lib/offline/store";
import { supabase } from "@/lib/supabase";
import { CLOCK_IN_NETWORK_LOCKED, reportClockInRefusal } from "@/lib/clock-in-lock";
import { reportHeldTimeRejections, reportTimeSyncRejection } from "@/lib/time-sync-rejections";

export const PHOTOS_BUCKET = "job-photos";

// ----- replay against Supabase ---------------------------------------------------------------------------------
const refusal = (err: unknown): ReplayOutcome => (isNetworkError(err) ? { status: "network" } : { status: "rejected", reason: friendlyError(err, "The server refused this change.") });
/** The same for a Play Start or Pause (049): a held run entry always carries a code (see requeueHeldRunOps). */
const runOpRefusal = (err: unknown): ReplayOutcome => (isNetworkError(err) ? { status: "network" } : { status: "rejected", code: "refused", reason: friendlyError(err, "The server refused this change.") });

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; hint?: string | null; code?: string } | null }> };
type Uploader = { upload: (path: string, body: Blob, options: { contentType: string; upsert: boolean }) => PromiseLike<{ error: { message: string; statusCode?: string } | null }> };

/**
 * A photo (migration 040): reserve (same id = same photo, so a retry returns the row), upload exactly the reserved object, finalise.
 * Every step is safe to repeat: an object already stored at the reserved path is taken as uploaded (the server refuses a
 * second write there anyway), and finalise on an uploaded photo returns it. A removed photo is refused by the server and filed
 * as rejected with the reason; "not uploaded yet" from finalise means the upload hasn't landed, so the entry stays queued.
 * The object at the reserved path not being this photo (finalise answers state 'abandoned', or reserve / finalise refuse with
 * hint photo_abandoned): held with code photo_mismatch / photo_abandoned and a clear reason; Retry then sends it under a new
 * photo id (lib/offline/outbox.ts retryHeld), never the old one again.
 */
export const PHOTO_MISMATCH_REASON = "The copy of this photo that reached the server didn't match it, so it wasn't attached. Press Retry to send it again as a new photo (the note is kept), or Export it.";
export async function executePhotoOp(op: PhotoOp, client: Rpc, store: Uploader, blob: Blob | null): Promise<ReplayOutcome> {
  if (!blob) return { status: "rejected", reason: "The photo's bytes are no longer on this device, so it can't be uploaded. Take it again." };
  const reserved = await client.rpc("reserve_job_photo", { p_id: op.photoId, p_job: op.jobId, p_note: op.note, p_captured_at: op.capturedAt, p_byte_size: op.byteSize });
  // Too many photos started this hour: not a refusal of this photo. It stays queued (as when offline) and the sync loop tries
  // again later, so the photos after it aren't all held.
  if (reserved.error?.hint === "photo_rate_limited") return { status: "network" };
  if (reserved.error) return reserved.error.hint === "photo_abandoned" ? { status: "rejected", code: "photo_abandoned", reason: PHOTO_MISMATCH_REASON } : refusal(reserved.error);
  const row = reserved.data as { state?: string; storage_path?: string } | null;
  if (row?.state !== "uploaded") {
    if (typeof row?.storage_path !== "string") return { status: "rejected", reason: "The server didn't reserve a place for this photo." };
    const { error } = await store.upload(row.storage_path, blob, { contentType: PHOTO_MIME, upsert: false });
    // 409 / "already exists": a previous attempt's upload landed although its answer was lost; finalise checks it is the right one.
    if (error && !(error.statusCode === "409" || /already exists|duplicate/i.test(error.message))) return refusal(error);
  }
  const done = await client.rpc("finalise_job_photo", { p_id: op.photoId });
  if (done.error) {
    if (done.error.hint === "photo_not_uploaded") return { status: "network" };
    if (done.error.hint === "photo_abandoned") return { status: "rejected", code: "photo_abandoned", reason: PHOTO_MISMATCH_REASON };
    return refusal(done.error);
  }
  if ((done.data as { state?: string } | null)?.state === "abandoned") return { status: "rejected", code: "photo_mismatch", reason: PHOTO_MISMATCH_REASON };
  return { status: "applied" };
}

/**
 * Applied, unless the server could not use the device's time for a run (it would have overlapped what the machine already recorded, or
 * ended a run before it started): the change is kept with the server's time and the entry is held as a conflict that says so, with both
 * times (the database keeps both too, and audits it). A replay of the same key answers the same, so it is never applied twice.
 */
function timeConflictOutcome(jobNo: string, action: "Start" | "Pause" | "Finish", data: unknown): ReplayOutcome {
  const conflicts = timeConflictsOf(data);
  if (!conflicts.length) return { status: "applied" };
  return { status: "conflict", reason: runTimeConflictReason(jobNo, action, conflicts), server: { time_conflicts: conflicts } };
}

/**
 * A Start with machines (migration 044): start_machine_run under the entry's client key, with the time from the device. A machine taken
 * meanwhile is never dropped silently: the job's own start is still recorded (the plain update, `fallback`) and the entry is held as a
 * conflict that says which machine, who has it and what to do. A job that is gone, or was finished meanwhile, is held as rejected.
 */
export async function executeStartRunOp(op: StartOp, client: Rpc, fallback: () => Promise<ReplayOutcome>): Promise<ReplayOutcome> {
  const bench = !op.machines?.length;
  const { data, error } = await client.rpc("start_machine_run", { p_job: op.jobId, p_machines: op.machines ?? [], p_client_op_id: op.clientOpId ?? null, p_started_at: op.at, p_override: false, p_reason: null });
  if (!error) {
    if (!bench) return timeConflictOutcome(op.jobNo, "Start", data);
    // A bench Start (migration 046): applied when it started the job or opened its bench run; a job someone started meanwhile (another
    // way) keeps their time, as the plain update's replay did: applied when the times agree, else held as a conflict that says so.
    const answer = data as BenchStartAnswer | null;
    const outcome = benchStartOutcome(answer);
    if (outcome === "started" || outcome === "resumed" || outcome === "running") return timeConflictOutcome(op.jobNo, "Start", data);
    // On a machine when it synced (046: machine -> bench is refused while a machine run is open): nothing changed on the server.
    if (outcome === "on_machine") return { status: "rejected", reason: `${op.jobNo} was running on a machine when this Start synced, so it wasn't started on the bench. Nothing changed.` };
    if (answer?.started_at && new Date(answer.started_at).getTime() === new Date(op.at).getTime()) return { status: "applied" };
    return { status: "conflict", reason: "This job was already started at a different time while you were offline. Their time is kept.", server: { id: op.jobId, started_at: answer?.started_at ?? null } };
  }
  if ((error as { code?: string }).code === "P0002") return { status: "rejected", reason: "This job no longer exists or you no longer have access to it." };
  const refusal_ = runRefusal(error);
  if (refusal_?.hint === "machine_in_use") {
    const kept = await fallback();
    if (kept.status === "network") return kept;
    return { status: "conflict", reason: replayedStartClashReason(op.jobNo, refusal_.message), server: { machine_in_use: true, detail: (error as { details?: unknown }).details ?? null } };
  }
  if (refusal_?.hint === "job_finished") return { status: "rejected", reason: `${op.jobNo} was finished before this Start synced, so it wasn't ${bench ? "started again" : "started on the machine"}.` };
  if (refusal_?.hint === "time_too_old" || refusal_?.hint === "client_op_reused" || refusal_?.hint === "run_overlap" || refusal_?.hint === "bench_run_open") return { status: "rejected", reason: refusal_.message };
  return refusal(error);
}

/** A Pause made offline: pause_machine_run under the entry's client key (a replay returns the first result). It ends the job's machine runs
 *  and its bench run (046) alike. */
export async function executePauseOp(op: PauseOp, client: Rpc): Promise<ReplayOutcome> {
  const { data, error } = await client.rpc("pause_machine_run", { p_job: op.jobId, p_machines: op.machines, p_client_op_id: op.clientOpId, p_ended_at: op.at });
  if (!error) return timeConflictOutcome(op.jobNo, "Pause", data);
  const refusal_ = runRefusal(error);
  if (refusal_?.hint === "time_too_old" || refusal_?.hint === "client_op_reused") return { status: "rejected", reason: refusal_.message };
  return refusal(error);
}

/**
 * The arguments a Play Start sends (migration 049, plan R3.3): 046's six, plus `p_bench: true` only when the person chose the bench and
 * `p_paused_ack` only when they confirmed a paused-machine check. Nothing is ever dropped: on a server without 049 the call fails and the
 * entry waits (blocked), it is never sent again without them.
 */
export function runStartArgs(op: Pick<RunStartOp, "jobRef" | "machines" | "clientOpId" | "at" | "bench" | "pausedAck">, override = false, reason: string | null = null): Record<string, unknown> {
  return {
    p_job: op.jobRef, p_machines: op.machines, p_client_op_id: op.clientOpId, p_started_at: op.at, p_override: override, p_reason: reason,
    ...(op.bench ? { p_bench: true } : {}),
    ...(op.pausedAck.length ? { p_paused_ack: op.pausedAck } : {}),
  };
}

/**
 * A Start made by Play (049), queued while offline or when the connection dropped. Outcomes:
 *  - the server has no 049 yet (PGRST202, or 42883): BLOCKED, "needs an app/server update"; the entry stays queued unchanged;
 *  - a malformed or stale paused-machine check, a bench Start naming machines, a key used with other details: rejected with that code
 *    (the person starts again with a fresh check);
 *  - success: applied only when every requested machine is in `runs` and, for a bench Start, `bench_run` is there; otherwise held as a
 *    conflict naming what is missing (opened nothing: the Pause after it is never sent). A device time the server couldn't use: a
 *    conflict that still opened the runs (the Pause after it is sent);
 *  - a machine taken meanwhile: the job's own start is still recorded (the plain update, `fallback`) and the entry is held as a conflict
 *    that opened nothing; a job finished meanwhile, gone, or a run overlap: rejected.
 * Every held outcome carries a code (so a later build can tell them from entries an older build held, see requeueHeldRunOps).
 */
export async function executeRunStartOp(op: RunStartOp, client: Rpc, fallback: () => Promise<ReplayOutcome> = async () => ({ status: "applied" })): Promise<ReplayOutcome> {
  const { data, error } = await client.rpc("start_machine_run", runStartArgs(op));
  if (!error) {
    const answer = data as RunStartAnswer | null;
    if (!requestedRunsPresent(op, answer)) {
      return { status: "conflict", code: "runs_missing", opened: false, reason: missingRunsReason(op, answer), server: { bench_skipped: answer?.bench_skipped ?? null, runs: answer?.runs ?? [] } };
    }
    const timed = timeConflictOutcome(op.jobNo, "Start", data);
    return timed.status === "conflict" ? { ...timed, code: "time_conflict", opened: true } : timed;
  }
  if (isNetworkError(error)) return { status: "network" };
  if (isServerTooOld(error)) return { status: "blocked", code: SERVER_UPGRADE_CODE, reason: SERVER_UPGRADE_REASON };
  if (error.code === "P0002") return { status: "rejected", code: "job_gone", reason: "This job no longer exists or you no longer have access to it." };
  const hint = error.hint ?? "";
  if (hint === "paused_ack_invalid" || hint === "bench_with_machines" || hint === "client_op_reused") {
    const reason = hint === "paused_ack_invalid"
      ? `${op.jobNo}: the paused-machine check made offline no longer matches. Nothing was started. Press Play again to check the machine afresh.`
      : error.message;
    return { status: "rejected", code: hint, reason };
  }
  const refused = runRefusal(error);
  if (refused?.hint === "machine_in_use") {
    const kept = await fallback();
    if (kept.status === "network") return kept;
    return { status: "conflict", code: "machine_in_use", opened: false, reason: replayedStartClashReason(op.jobNo, refused.message), server: { machine_in_use: true, detail: (error as { details?: unknown }).details ?? null } };
  }
  if (refused?.hint === "job_finished") return { status: "rejected", code: "job_finished", reason: `${op.jobNo} was finished before this Start synced, so it wasn't started again.` };
  if (refused) return { status: "rejected", code: refused.hint, reason: refused.message };
  return { status: "rejected", code: "refused", reason: friendlyError(error, "The server refused this change.") };
}

/** A Pause made by Play/Pause (049): pause_machine_run under its key, ending every open run of the job (machines and bench), as 044/046. */
export async function executeRunPauseOp(op: RunPauseOp, client: Rpc): Promise<ReplayOutcome> {
  const { data, error } = await client.rpc("pause_machine_run", { p_job: op.jobRef, p_machines: op.machines, p_client_op_id: op.clientOpId, p_ended_at: op.at });
  if (!error) {
    const timed = timeConflictOutcome(op.jobNo, "Pause", data);
    return timed.status === "conflict" ? { ...timed, code: "time_conflict" } : timed;
  }
  if (isNetworkError(error)) return { status: "network" };
  if (error.code === "P0002") return { status: "rejected", code: "job_gone", reason: "This job no longer exists or you no longer have access to it." };
  const refused = runRefusal(error);
  if (refused) return { status: "rejected", code: refused.hint, reason: refused.message };
  return { status: "rejected", code: "refused", reason: friendlyError(error, "The server refused this change.") };
}

/**
 * A Finish made offline (migration 044): finish_job under the entry's key, with the device's time. It fills an empty finish time only and
 * ends the job's machine runs in the database's lock order; a finish someone already recorded is kept and the entry held as a conflict
 * when the times differ (as the plain update did), applied when they are the same time.
 */
export async function executeFinishOp(op: { jobId: string; jobNo: string; at: string; clientOpId?: string }, client: Rpc): Promise<ReplayOutcome> {
  const { data, error } = await client.rpc("finish_job", { p_job: op.jobId, p_client_op_id: op.clientOpId ?? null, p_finished_at: op.at });
  if (error) {
    if ((error as { code?: string }).code === "P0002") return { status: "rejected", reason: "This job no longer exists or you no longer have access to it." };
    const refusal_ = runRefusal(error);
    if (refusal_?.hint === "time_too_old" || refusal_?.hint === "client_op_reused") return { status: "rejected", reason: refusal_.message };
    return refusal(error);
  }
  const row = data as { finished_at?: string; changed?: boolean } | null;
  if (row?.changed) return timeConflictOutcome(op.jobNo, "Finish", data);
  if (row?.finished_at && new Date(row.finished_at).getTime() === new Date(op.at).getTime()) return { status: "applied" };
  return { status: "conflict", reason: "This job was already finished at a different time while you were offline. Their time is kept.", server: { id: op.jobId, finished_at: row?.finished_at ?? null } };
}

/** Why a queued signature was held for the person (shown in the offline notice and next to the sign-off). */
export const SIGNOFF_OTHER_USER_REASON = "This signature was captured on this device by someone else. It is only uploaded while they are signed in, never as you.";
export const signOffStaleReason = (op: Pick<InternalSignOffOp, "jobNo" | "expectedVersion">) =>
  `${op.jobNo} changed after this signature was captured (it signed revision ${op.expectedVersion}), so it was not attached to the new revision. Open the job, check it and sign again.`;

/**
 * A sign-off captured offline (migration 045): sign_off_job under the entry's client key, with the revision and snapshot hash it was
 * captured against. Only the person who captured it may upload it: under anyone else it is held (rejected) without being sent. A replay
 * of the key answers the first record (applied). A revision that changed meanwhile, or one someone else already signed, is held as a
 * conflict with the reason (the signature is never re-bound to another revision); the co-sign rules (needs_primary, same_signer,
 * not_inspector) and a reused key are refusals, held with the server's message so the person can retry or dismiss.
 */
export async function executeSignOffOp(op: SignOffOp, client: Rpc, signedInUserId: string | null | undefined): Promise<ReplayOutcome> {
  if (!signedInUserId || signedInUserId !== op.capturedBy) return { status: "rejected", code: "signoff_other_user", reason: SIGNOFF_OTHER_USER_REASON };
  if (op.role === "customer") return executeCustomerSignOffOp(op, client);
  const { error } = await client.rpc("sign_off_job", {
    p_job_id: op.jobId, p_expected_version: op.expectedVersion, p_expected_snapshot_sha256: op.expectedSha256, p_initials: op.initials, p_signer_name: op.signerName,
    p_signed_on: op.signedOn, p_signature_kind: op.signatureKind, p_signature_data: op.signatureData, p_kind: op.role, p_client_op_id: op.clientOpId,
  });
  if (!error) return { status: "applied" };
  if (isNetworkError(error)) return { status: "network" };
  const hint = error.hint ?? "";
  if (hint === "stale_revision") return { status: "conflict", reason: signOffStaleReason(op), server: { stale_revision: true, message: error.message } };
  if (hint === "already_signed") return { status: "conflict", reason: `${error.message} Your signature was not added.`, server: { already_signed: true } };
  if (error.code === "P0002") return { status: "rejected", reason: "This job no longer exists or you no longer have access to it." };
  if (["needs_primary", "same_signer", "not_inspector", "client_op_reused"].includes(hint) || error.code === "22023") return { status: "rejected", code: hint || undefined, reason: error.message };
  return refusal(error);
}

/**
 * A clock action (migration 050): record_attendance_event under the entry's key, with the device's time. Applied once the server holds it
 * (a replay answers the first record: never a second one). A device time the server couldn't use (in the future) is recorded at the
 * server's time and shown on the sheet (flag time_adjusted). Held outcomes always carry a code (see requeueHeldRunOps): too old (more
 * than 14 days: an admin records it as a correction), the key used for something else, or no access any more. A server without 050:
 * blocked, kept unchanged until it is updated.
 * 090: sent as record_attendance_event_in_company with the company it was made in (the queue's company, `expectedOrg`), which the server checks against the session's: two
 * tabs share one session, and a switch in another tab moves it. Refused there (wrong_company): blocked, kept unchanged, sent again
 * once the session is in that company. A server without 090: blocked as needing an update (never sent without the company).
 */
export async function executeClockOp(op: ClockOp, client: Rpc, expectedOrg: string | null = offlineScope()?.orgId ?? null): Promise<ReplayOutcome> {
  const outcome = await clockOutcome(op, client, expectedOrg);
  // 075 (G18): a refusal for an approved week or a time over 14 days is reported to the office (best effort; never changes the outcome).
  await reportTimeSyncRejection(client, op, outcome);
  return outcome;
}
async function clockOutcome(op: ClockOp, client: Rpc, expectedOrg: string | null): Promise<ReplayOutcome> {
  // No company known on this page (not signed in to one yet): nothing is sent that the server would file in whatever the session is in.
  if (!expectedOrg) return { status: "blocked", code: "company_unknown", reason: "Waiting: Tolra doesn't know yet which company this belongs to. Reload the page and try again. Nothing was lost." };
  const { error } = await client.rpc("record_attendance_event_in_company", { p_client_op_id: op.clientOpId, p_action: op.action, p_at: op.at, p_device: op.device, p_expected_org: expectedOrg });
  if (!error) return { status: "applied" };
  if (isNetworkError(error)) return { status: "network" };
  if (isServerTooOld(error)) return { status: "blocked", code: SERVER_UPGRADE_CODE, reason: TIME_UPGRADE_REASON };
  const hint = error.hint ?? "";
  if (hint === CLOCK_WRONG_COMPANY) return { status: "blocked", code: CLOCK_WRONG_COMPANY, reason: CLOCK_WRONG_COMPANY_REASON };
  if (hint === "time_too_old") return { status: "rejected", code: hint, reason: `${clockLabel(op.action)} at ${new Date(op.at).toLocaleString("en-GB", { timeZone: "Europe/London" })} is more than 14 days old, so it wasn't recorded. Ask an admin to add it to your sheet.` };
  if (hint === "client_op_reused" || hint === "not_allowed" || hint === "bad_action" || hint === "week_approved") return { status: "rejected", code: hint, reason: error.message };
  // 128: refused by the network lock (114). Reported for the admin's banner (best effort; the outcome below is unchanged).
  if (hint === CLOCK_IN_NETWORK_LOCKED) await reportClockInRefusal(client, op);
  return { status: "rejected", code: "refused", reason: friendlyError(error, "The server refused this clock action.") };
}
/**
 * A labour Start or Stop from the daily job sheet (migration 051): record_labour_event under the entry's key. Applied once the server
 * holds it (a replay answers the first result). A Stop that found nothing open is applied too: the server keeps it and closes the
 * session when the Start from another device arrives. A time the server couldn't use (inside time already recorded) is applied with the
 * server's time; the sheet shows it. A job gone or no longer visible, a key reused, a time too old: held with a code. No 051: blocked.
 */
export async function executeLabourOp(op: LabourOp, client: Rpc): Promise<ReplayOutcome> {
  const outcome = await labourOutcome(op, client);
  await reportTimeSyncRejection(client, op, outcome);
  return outcome;
}
async function labourOutcome(op: LabourOp, client: Rpc): Promise<ReplayOutcome> {
  const { error } = await client.rpc("record_labour_event", { p_client_op_id: op.clientOpId, p_job: op.jobRef, p_action: op.action, p_at: op.at });
  if (!error) return { status: "applied" };
  if (isNetworkError(error)) return { status: "network" };
  if (isServerTooOld(error)) return { status: "blocked", code: SERVER_UPGRADE_CODE, reason: TIME_UPGRADE_REASON };
  if (error.code === "P0002") return { status: "rejected", code: "job_gone", reason: `${op.jobNo}: this job no longer exists or you no longer have access to it.` };
  const hint = error.hint ?? "";
  if (hint === "time_too_old") return { status: "rejected", code: hint, reason: `${op.jobNo}: ${op.action === "start" ? "Start" : "Stop"} at ${new Date(op.at).toLocaleString("en-GB", { timeZone: "Europe/London" })} is more than 14 days old, so it wasn't recorded. Add the time on your sheet with a reason, or ask an admin.` };
  if (hint === "client_op_reused" || hint === "not_allowed" || hint === "bad_action" || hint === "week_approved") return { status: "rejected", code: hint, reason: error.message };
  return { status: "rejected", code: "refused", reason: friendlyError(error, "The server refused this job time.") };
}

/** 090: the session is in another company than the one this clock action was made in (another tab switched it). Kept, never dropped. */
export const CLOCK_WRONG_COMPANY = "wrong_company";
export const CLOCK_WRONG_COMPANY_REASON = "Waiting: this was recorded in the company this page shows, but you are now working in another company (switched in another tab). It is sent once you are back in that company. Nothing was lost.";
export const TIME_UPGRADE_REASON ="Waiting: Tolra needs updating before your time can sync. Nothing was lost.";
export const clockLabel = (action: ClockOp["action"]) => ({ in: "Clock in", out: "Clock out", break_start: "Break start", break_end: "Break end" })[action];

/** Why a queued customer signature waits: the database doesn't have 072 yet (kept on the device, unchanged, until it has). */
export const CUSTOMER_SIGNOFF_UPGRADE_REASON = "Waiting: Tolra needs updating before this customer signature can upload. Nothing was lost.";

/**
 * A customer's sign-off captured on the fitter's phone (migration 072): sign_off_job_customer under the entry's client key. A replay of
 * the key answers the first record (applied), so a lost answer or a second pass never makes a second record. The worksheet changing
 * meanwhile is not a refusal (the server records the revision shown and the one it was bound to). A database without 072 keeps the entry
 * waiting (blocked) rather than refusing it; a customer sign-off already on the revision is held as a conflict; the setting turned off,
 * a reused key and bad input are refusals held with the server's message, so the signature stays on the device to retry or dismiss.
 */
export async function executeCustomerSignOffOp(op: CustomerSignOffOp, client: Rpc): Promise<ReplayOutcome> {
  const { error } = await client.rpc("sign_off_job_customer", {
    p_job_id: op.jobId, p_signer_name: op.signerName, p_signer_position: op.customer.position, p_signer_company: op.customer.company, p_statement: op.customer.statement,
    p_comment: op.customer.comment, p_signature_kind: op.signatureKind, p_signature_data: op.signatureData, p_device_signed_at: op.customer.deviceSignedAt,
    p_client_op_id: op.clientOpId, p_shown_version: op.expectedVersion, p_shown_snapshot_sha256: op.expectedSha256,
  });
  if (!error) return { status: "applied" };
  if (isNetworkError(error)) return { status: "network" };
  if (isServerTooOld(error)) return { status: "blocked", code: SERVER_UPGRADE_CODE, reason: CUSTOMER_SIGNOFF_UPGRADE_REASON };
  const hint = error.hint ?? "";
  if (hint === "already_signed") return { status: "conflict", reason: `${error.message} This customer signature was not added.`, server: { already_signed: true } };
  if (error.code === "P0002") return { status: "rejected", reason: "This job no longer exists or you no longer have access to it." };
  if (["customer_signoff_off", "client_op_reused", "device_time_out_of_range"].includes(hint) || error.code === "22023") return { status: "rejected", code: hint || undefined, reason: error.message };
  return refusal(error);
}

/** Why a queued inspection waits: the database doesn't have 081 yet (kept on the device, unchanged, until it has). */
export const INSPECTION_UPGRADE_REASON = "Waiting: Tolra needs updating before this inspection can sync. Nothing was lost.";
export const INSPECTION_OTHER_USER_REASON = "This inspection was recorded on this device by someone else. It is only sent while they are signed in, never as you.";

/**
 * An inspection recorded offline (migration 081): inspect_job under the entry's key, bound to the inspector who recorded it. A replay of
 * the key answers the first record (applied). Every rule is checked again on upload: the person who finished the job can't record its
 * pass (not_independent) unless an admin's reason is in the entry, a job changed since (stale version), a job in rework or already
 * released: all held as rejected with the server's message, never applied as something else. A database without 081: blocked.
 */
export async function executeInspectOp(op: InspectOp, client: Rpc, signedInUserId: string | null | undefined): Promise<ReplayOutcome> {
  if (!signedInUserId || signedInUserId !== op.capturedBy) return { status: "rejected", code: "inspection_other_user", reason: INSPECTION_OTHER_USER_REASON };
  const { error } = await client.rpc("inspect_job", {
    p_job: op.jobRef, p_result: op.result, p_criteria: op.criteria, p_measured: op.measured, p_expected_version: op.expectedVersion,
    p_concession_reason: op.concessionReason, p_override_reason: op.overrideReason, p_disposition: op.disposition, p_failure: op.failure, p_client_op_id: op.clientOpId,
  });
  if (!error) return { status: "applied" };
  if (isNetworkError(error)) return { status: "network" };
  if (isServerTooOld(error)) return { status: "blocked", code: SERVER_UPGRADE_CODE, reason: INSPECTION_UPGRADE_REASON };
  if (error.code === "P0002") return { status: "rejected", code: "job_gone", reason: `${op.jobNo}: this job no longer exists or you no longer have access to it.` };
  const hint = error.hint ?? "";
  if (hint || error.code === "22023" || error.code === "42501") return { status: "rejected", code: hint || "refused", reason: `${op.jobNo}: ${friendlyError(error, "The server refused this inspection.")}` };
  return { status: "rejected", code: "refused", reason: friendlyError(error, "The server refused this inspection.") };
}

/** A replayed Start's stage move (see lib/job-actions stageAfterStart): from an earlier stage only, never back, never out of rework. */
async function advanceStartStage(client: NonNullable<typeof supabase>, jobId: string, to: StartStage) {
  // Two filtered updates: PostgREST refuses an `or` filter on an update (42703 "column jobs.stage does not exist").
  await client.from("jobs").update({ stage: to }).eq("id", jobId).in("stage", stagesBeforeStart(to));
  await client.from("jobs").update({ stage: to }).eq("id", jobId).is("stage", null);
}

export async function executeOutboxOp(op: OutboxOp, orgId: string | null = offlineScope()?.orgId ?? null): Promise<ReplayOutcome> {
  if (!supabase) return { status: "network" };
  if (op.kind === "clock") {
    try {
      return await executeClockOp(op, supabase, orgId);
    } catch (err) {
      return runOpRefusal(err);
    }
  }
  if (op.kind === "labour") {
    try {
      return await executeLabourOp(op, supabase);
    } catch (err) {
      return runOpRefusal(err);
    }
  }
  if (op.kind === "signoff") {
    try {
      const { data } = await supabase.auth.getSession();
      return await executeSignOffOp(op, supabase, data.session?.user.id ?? null);
    } catch (err) {
      return refusal(err);
    }
  }
  if (op.kind === "inspect") {
    try {
      const { data } = await supabase.auth.getSession();
      return await executeInspectOp(op, supabase, data.session?.user.id ?? null);
    } catch (err) {
      return refusal(err);
    }
  }
  if (op.kind === "finish") {
    try {
      return await executeFinishOp(op, supabase);
    } catch (err) {
      return refusal(err);
    }
  }
  if (op.kind === "pause") {
    try {
      return await executePauseOp(op, supabase);
    } catch (err) {
      return refusal(err);
    }
  }
  if (op.kind === "run_pause") {
    try {
      return await executeRunPauseOp(op, supabase);
    } catch (err) {
      return runOpRefusal(err);
    }
  }
  if (op.kind === "run_start") {
    try {
      const outcome = await executeRunStartOp(op, supabase, () => executeOutboxOp({ kind: "start", jobId: op.jobRef, jobNo: op.jobNo, at: op.at }));
      // The stage the Start chose, once the Start opened its runs on the server (best effort, as for the 044/046 Start).
      if (op.stage && (outcome.status === "applied" || (outcome.status === "conflict" && outcome.opened))) await advanceStartStage(supabase, op.jobRef, op.stage).catch(() => undefined);
      return outcome;
    } catch (err) {
      return refusal(err);
    }
  }
  // A Start with a client key: with machines (044) or a bench Start, machines [] (046). Without a key (queued before 044) it is the plain
  // started_at update below.
  if (op.kind === "start" && op.clientOpId && Array.isArray(op.machines)) {
    try {
      const outcome = await executeStartRunOp(op, supabase, () => executeOutboxOp({ kind: "start", jobId: op.jobId, jobNo: op.jobNo, at: op.at }));
      // The stage the Start chose (Machining by default), once the Start is on the server: only a job still at an earlier stage moves
      // (the update is filtered on the stage). Best effort: the Start's outcome stands whatever happens here.
      const timesOnly = outcome.status === "conflict" && Boolean((outcome.server as { time_conflicts?: unknown } | undefined)?.time_conflicts);
      if (op.stage && (outcome.status === "applied" || timesOnly)) await advanceStartStage(supabase, op.jobId, op.stage).catch(() => undefined);
      return outcome;
    } catch (err) {
      return runOpRefusal(err);
    }
  }
  if (op.kind === "photo") {
    try {
      return await executePhotoOp(op, supabase, supabase.storage.from(PHOTOS_BUCKET), await readAttachment<Blob>(op.blobKey));
    } catch (err) {
      return refusal(err);
    }
  }
  if (op.kind === "worksheet") {
    try {
      const saved = await saveWorksheet(op.jobId, op.worksheet as unknown as JobWorksheet, op.baseVersion, { queueWhenOffline: false });
      return { status: "applied", version: saved.version };
    } catch (err) {
      if (err instanceof WorksheetConflictError) {
        const { data } = await supabase.from("jobs").select("*").eq("id", op.jobId).maybeSingle();
        return { status: "conflict", reason: "Someone changed this worksheet while you were offline. Both versions are kept: check theirs, then apply yours if it is still right.", server: data };
      }
      if (err instanceof WorksheetMissingError) return { status: "rejected", reason: err.message };
      return refusal(err);
    }
  }
  const column = "started_at";
  const patch = { started_at: op.at };
  try {
    // Only fills an empty time: a Start someone already recorded is never overwritten.
    const { data, error } = await supabase.from("jobs").update(patch).eq("id", op.jobId).is(column, null).select("id");
    if (error) return refusal(error);
    if (data?.length === 1) return { status: "applied" };
    const { data: row, error: readError } = await supabase.from("jobs").select(`id, ${column}`).eq("id", op.jobId).maybeSingle();
    if (readError) return refusal(readError);
    if (!row) return { status: "rejected", reason: "This job no longer exists or you no longer have access to it." };
    // A Start queued before 044 has no client key, so the server can't recognise a resend. The update above only fills an empty time,
    // so a resend (the first answer lost, the entry still in flight) never starts the job twice; the time it finds being this entry's
    // own is this entry applied, not someone else's Start.
    const recorded = (row as Record<string, unknown>)[column];
    if (typeof recorded === "string" && new Date(recorded).getTime() === new Date(op.at).getTime()) return { status: "applied" };
    return { status: "conflict", reason: "This job was already started at a different time while you were offline. Their time is kept.", server: row };
  } catch (err) {
    return refusal(err);
  }
}

const syncListeners = new Set<(event: SyncPassEvent) => void>();
/**
 * What a sync pass tells its listeners. sessionGone: the pass found the session gone and sent nothing (the access recheck should run
 * now). quiet: no queued change got an answer from the server in this pass (nothing was sent, or the pass stopped before sending).
 * idle: a background pass found nothing queued, in conflict or refused, and asked the server nothing (syncNow `background`).
 */
export type SyncPassEvent = { sessionGone: boolean; quiet: boolean; idle?: boolean };

/** Runs `listener` after every sync pass (the signed-in person's access is asked again then; lib/use-user.ts). Returns the unsubscribe. */
export function onSyncComplete(listener: (event: SyncPassEvent) => void): () => void {
  syncListeners.add(listener);
  return () => { syncListeners.delete(listener); };
}

/** This build's id (the service worker's version): held run entries filed by an older build are requeued once per build. */
export const BUILD_ID = process.env.NEXT_PUBLIC_APP_VERSION || "dev";

/**
 * Replays the queue for the current scope; safe to call often. `background` (the shell's minute loop, page visible, "online"): when
 * this scope has nothing queued, in conflict or refused, the pass makes no request (phone lag: it used to ask the auth server and
 * my_session every minute for an empty queue) and returns null. Its listeners are told it was idle: the access recheck then asks the
 * server only if nothing has confirmed the person for ACCESS_RECHECK_EVERY_MS (lib/access-recheck.ts syncPassNeedsRecheck), so a
 * page opened offline still ends a removed person's access at the first answer once the connection is back.
 */
export async function syncNow(options: { background?: boolean } = {}) {
  const scope = offlineScope();
  if (!scope || !supabase) return null;
  // While this page switches company on purpose (lib/use-user.ts switchOrganization), the server may already answer for the NEW
  // company: that is not a removal, so nothing is locked, and nothing of the old company is sent under the new session either.
  // The switch wipes the old scope and reloads; the next load confirms the person and company again. Another open tab shares the
  // session, so its switch away from this company holds this tab too (it announces itself; checked before and after every entry).
  const stillCurrent = () => {
    if (organizationSwitchAffects(scope.orgId)) return false;
    const current = offlineScope();
    return current !== null && scopeKey(current) === scopeKey(scope);
  };
  if (options.background) {
    // A failed read (null) is not "empty": the full pass below runs as before.
    const queued = await outboxState();
    if (queued && queued.pending + queued.conflicts + queued.rejected === 0) {
      if (stillCurrent()) for (const listener of syncListeners) listener({ sessionGone: false, quiet: true, idle: true });
      return null;
    }
  }
  {
    // A cached token is not permission to recover quarantined work. Confirm the same user AND company first. The user is the auth
    // server's answer, shared with this page load when it is seconds old and the device's session still names that user
    // (lib/confirmed-user.ts); my_session below is the database's answer for this request (017's session check refuses an ended one).
    const { data, error } = await confirmedUser({ maxAgeMs: CONFIRMED_USER_REUSE_MS });
    if (authSessionGone(error)) {
      // The session is gone (timeout, sign-out elsewhere, or a disabled account signed out by the middleware): nothing is sent,
      // and the access recheck runs now (lib/use-user.ts) instead of at the next focus or 10-minute check. It decides; the queue stays.
      for (const listener of syncListeners) listener({ sessionGone: true, quiet: true });
      return null;
    }
    if (error || data.user?.id !== scope.userId || !stillCurrent()) return null;
    const { data: sessionData, error: sessionError } = await supabase.rpc("my_session");
    if (sessionEndedError(sessionError)) {
      // The database says this session has ended (a confirmation shared from seconds ago can predate that): the same as the auth
      // server saying so above. Nothing is sent and the access recheck runs now.
      for (const listener of syncListeners) listener({ sessionGone: true, quiet: true });
      return null;
    }
    if (sessionError || !stillCurrent()) return null;
    const info = parseSessionInfo(sessionData);
    if (!info) return null;
    if (info.user_id !== scope.userId || info.organization_id !== scope.orgId || !info.role) {
      suspendOfflineAccess(scope.userId);
      return null;
    }
    // A support session (platform owner inside this company) is not a revocation: nothing is kept on the device for it,
    // so skip replay without locking the account.
    if (!offlineCopyAllowed(info)) return null;
  }
  if (!stillCurrent()) return null;
  await requeueHeldRunOps(scope, BUILD_ID).catch(() => 0);
  const result = await replayOutbox(scope, async (op) => {
    if (!stillCurrent()) return { status: "network" };
    const outcome = await executeOutboxOp(op, scope.orgId);
    // Access may end during the request. Keep its key and bytes for an authorised, idempotent retry.
    return stillCurrent() ? outcome : { status: "network" };
  });
  // 075 (G18): refusals held on this device for an approved week or a time over 14 days reach the office (once per page load; a
  // refusal held before 075 was applied is reported once it is). Best effort: never holds up or fails the sync.
  // Under the replay lock, so a company switch (which waits for it) cannot change the session's company while reports are open.
  const client = supabase;
  if (stillCurrent()) await withReplayLock(scope, async () => stillCurrent() ? reportHeldTimeRejections(client, await rejectedEntries(scope).catch(() => [])) : 0).catch(() => 0);
  await refreshCounts();
  const quiet = result.applied + result.conflicts + result.rejected + result.blocked === 0;
  for (const listener of syncListeners) listener({ sessionGone: false, quiet });
  return result;
}

/** Runs the sync loop while the dashboard is open. */
export function useOfflineSync() {
  useEffect(() => {
    // Background passes: nothing is asked of the server while this scope's queue is empty (syncNow).
    const run = () => { void syncNow({ background: true }); };
    const onOnline = () => { reportOffline(false); run(); };
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(run, 60_000);
    run();
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);
}


