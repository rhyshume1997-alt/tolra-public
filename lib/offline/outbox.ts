/**
 * Outbox: worksheet saves, Start/Finish and job photos made while offline, replayed in order when the connection is back.
 *
 * Each entry is stored under the user + company scope (lib/offline/store.ts) with the server version it was based
 * on. Replay sends entries oldest first, one at a time, and stops at the first one that can't reach the server, so
 * order is kept. Outcomes:
 *   applied   - the server accepted it; removed from the outbox.
 *   conflict  - the server copy changed since it was taken offline. Nothing is overwritten: the local copy is kept
 *               in the conflicts list next to the server's, for the person to resolve (both kept, flagged).
 *   rejected  - the server refused it for good (the job is locked/issued, gone, or access was removed); kept in the
 *               rejected list with the reason, removed from the outbox.
 *   network   - still can't reach the server: replay stops, the entry and everything after it stay queued.
 *   blocked   - (049, R3.3) the server is older than this app (a Start with the explicit bench choice or a paused-machine check reached a
 *               database without 049): the entry STAYS in the outbox, unchanged byte for byte, marked `blocked` with the reason; every
 *               later entry for the same job is skipped for the rest of that pass (so a Pause never overtakes its Start), other jobs'
 *               entries carry on, and the next pass tries it again (it clears once the server is updated). Never counted as synced.
 *
 * Concurrency (audit L3): every change to the outbox and the held lists is one atomic storage transaction
 * (OfflineBackend.transact), so a save made while another save or a replay is running is never lost. Only one tab
 * replays a scope at a time (Web Locks; an in-tab guard where the browser has none). The entry being sent is marked
 * in flight so a newer save of the same worksheet queues behind it instead of replacing it, and once it applies the
 * queued save is moved onto the new server version (it was made on top of the one just sent).
 */
import { isSupportSession, offlineBackend, scopeKey, SUPPORT_NO_OFFLINE, type Scope } from "@/lib/offline/store";

/**
 * A photo (migration 040): the prepared JPEG is stored ONCE in the device store under `blobKey` (same scope prefix, so a wipe of
 * the scope removes it), written in the same atomic step as the entry. `photoId` is the idempotency key the server uses
 * (reserve and finalise are replays of the same photo, never a second one). The blob is removed when the entry applies or is
 * discarded; it stays while the entry is held as rejected, so the person can export it or retry.
 */
export type PhotoOp = { kind: "photo"; photoId: string; jobId: string; jobNo: string; note: string | null; capturedAt: string | null; byteSize: number; blobKey: string };
/**
 * A Start made offline (migration 044): with `machines` and `clientOpId` it replays through start_machine_run (the key makes a second
 * replay return the first result, never a second run); with `clientOpId` and `machines: []` it is a bench Start (046: the job's run with
 * no machine, so it can be paused), replayed the same way; without a key (an entry queued before 044 or 046) it is the plain started_at
 * update as before. A Pause replays through pause_machine_run the same way (it ends machine and bench runs alike).
 */
export type StartOp = {
  kind: "start"; jobId: string; jobNo: string; at: string; machines?: string[]; clientOpId?: string;
  /** The stage the Start moves the job to (lib/job-actions stageAfterStart), applied after the Start syncs; older entries have none. */
  stage?: "setup" | "machining";
};
export type PauseOp = { kind: "pause"; jobId: string; jobNo: string; at: string; machines: string[] | null; clientOpId: string };
/** One paused-machine check the person confirmed (migration 049): the run id they were shown by paused_machines(). */
export type PausedAck = { machine_id: string; paused_run_id: string };
/**
 * A Start made by the Job Board's Play (migration 049, plan R3.3). The job id is `jobRef`, deliberately not `jobId`: a previous build
 * (which knows only `start`) sends an unknown kind to its plain started_at update with `.eq("id", op.jobId)`, which is undefined here, so
 * the server refuses it (22P02) and the entry is held, never replayed as a 6-argument Start that would drop the bench choice.
 * `bench: true` only when the person ticked "No machine (bench)"; `machines: []` with `bench: false` is never queued (Play asks for a pick).
 * `stage`: the stage the Start moves the job to once it is on the server (lib/job-actions stageAfterStart).
 */
export type RunStartOp = {
  kind: "run_start"; v: 2; jobRef: string; jobNo: string; at: string; clientOpId: string; machines: string[]; bench: boolean; pausedAck: PausedAck[];
  stage?: "setup" | "machining";
};
/**
 * A Pause made by the Job Board (049). `afterStart`: the key of the job's latest pending run_start when the Pause was captured (so the
 * Pause belongs to that Start: if the Start is refused, this Pause is never sent), or null when the run it pauses was server-confirmed.
 * Set by enqueue in the same atomic step that queues it.
 */
export type RunPauseOp = { kind: "run_pause"; v: 2; jobRef: string; jobNo: string; at: string; clientOpId: string; machines: string[] | null; afterStart: string | null };
/**
 * A sign-off captured on the device (migration 045; Rhys: "sign and save offline but uploads when back"). Bound when it is captured to
 * the person who signed (`capturedBy`, their user id) and to the revision they saw (`expectedVersion` + `expectedSha256`, the snapshot
 * hash the server gave for it). Replayed through sign_off_job under `clientOpId`: a lost answer and a retry return the first record, never
 * a second one. It is only ever sent while `capturedBy` is the signed-in person (lib/offline/sync.ts executeSignOffOp), and the server
 * checks every rule again on upload: a revision that changed meanwhile is held as a conflict, never re-bound to the new revision.
 */
export type InternalSignOffOp = {
  kind: "signoff"; clientOpId: string; jobId: string; jobNo: string; expectedVersion: number; expectedSha256: string;
  initials: string; signerName: string; signedOn: string; signatureKind: "drawn" | "typed"; signatureData: string; role: "primary" | "inspector";
  capturedBy: string; capturedAt: string;
};
/**
 * A clock action on the daily job sheet (migration 050): Clock in, Clock out, Break start, Break end, replayed through
 * record_attendance_event under `clientOpId` (a replay returns the first answer, from any device, in any order). Like the 049 run ops it
 * carries no `jobId`, so a previous build (which doesn't know the kind) sends it to its plain jobs update, which the server refuses: the
 * entry is held there, never applied as something else, and requeued by this build (requeueHeldRunOps). `jobNo` is the label the
 * offline notices show.
 */
export type ClockOp = { kind: "clock"; v: 1; action: "in" | "out" | "break_start" | "break_end"; at: string; clientOpId: string; device: string | null; jobNo: string };
/**
 * Start or Stop of the person's own labour on a job, from the daily job sheet (migration 051): record_labour_event under `clientOpId`.
 * The job is `jobRef` (as the 049 run ops, for the same reason: a previous build holds it instead of misapplying it).
 */
export type LabourOp = { kind: "labour"; v: 1; action: "start" | "stop"; jobRef: string; jobNo: string; at: string; clientOpId: string };
/**
 * 128: the report of a clock action the network lock (114) refused, queued when the report itself could not reach the server
 * (record_clock_in_refusal under the refused action's own `clientOpId`, so a resend is answered, never doubled). Sent once on
 * reconnect; whatever the server answers (recorded, or not_refused because the database would no longer refuse it from there), the
 * entry is done, never held. No jobId: a previous build fails it harmlessly instead of applying it as a Start.
 */
export type ClockRefusalOp = { kind: "clock_refusal"; v: 1; action: ClockOp["action"]; clientOpId: string; jobRef: string; jobNo: string };
/**
 * A customer's sign-off captured on the fitter's phone (migration 072). Same kind ("signoff") so it is listed, retried and dismissed like
 * any signature, and a build without 072 support sends it to sign_off_job, which refuses the role (held, never lost). `capturedBy` is
 * the fitter; `expectedVersion` / `expectedSha256` are the revision the screen showed (null when the device had none): the server
 * records them and binds the row to the revision current at upload (a customer can't be asked to sign again). `customer.deviceSignedAt`
 * is the phone's clock when the customer signed. Replayed through sign_off_job_customer under `clientOpId`.
 */
export type CustomerSignOffOp = {
  kind: "signoff"; clientOpId: string; jobId: string; jobNo: string; expectedVersion: number | null; expectedSha256: string | null;
  initials: string; signerName: string; signedOn: string; signatureKind: "drawn" | "typed"; signatureData: string; role: "customer";
  capturedBy: string; capturedAt: string;
  customer: { position: string | null; company: string | null; statement: string; comment: string | null; deviceSignedAt: string };
};
export type SignOffOp = InternalSignOffOp | CustomerSignOffOp;
/**
 * An inspection recorded while offline (migration 081): replayed through inspect_job under `clientOpId` (a replay answers the first
 * record, never a second one). On the device it is only "Sync pending", never a release: the job stays as the server last said. The
 * server checks every rule again on upload, the independence rule included: a pass by the person who finished the job is refused unless
 * the queued entry carries an admin's reason (`overrideReason`). Only sent while `capturedBy` is the signed-in person. The job is
 * `jobRef` (as the 049 run ops): a previous build holds it instead of applying it as something else. No photo or file offline.
 */
export type InspectOp = {
  kind: "inspect"; v: 1; jobRef: string; jobNo: string; clientOpId: string; capturedBy: string; capturedAt: string;
  result: "pass" | "fail" | "concession"; criteria: string; measured: string; expectedVersion: number;
  concessionReason: string | null; overrideReason: string | null; disposition: "rework" | "scrap" | "concession" | null; failure: Record<string, unknown> | null;
};
export type OutboxOp =
  | { kind: "worksheet"; jobId: string; jobNo: string; worksheet: Record<string, unknown>; baseVersion: number | null }
  | ClockOp
  | LabourOp
  | ClockRefusalOp
  | SignOffOp
  | InspectOp
  | StartOp
  | { kind: "finish"; jobId: string; jobNo: string; at: string; clientOpId?: string }
  | PauseOp
  | RunStartOp
  | RunPauseOp
  | PhotoOp;

/** Why an entry is waiting although the device is online (049: the server needs updating first). The op itself is never changed. */
export type BlockedMark = { code: string; reason: string; at: string };
export type OutboxEntry = { id: string; queuedAt: string; op: OutboxOp; inFlight?: boolean; blocked?: BlockedMark };

/** The pseudo job every clock action belongs to: one person's clock actions replay in order, after one another. */
export const ATTENDANCE_LANE = "attendance";
/** 128: the lane of queued refusal reports (apart from the clock actions, so a report never holds one up). */
export const CLOCK_REFUSAL_LANE = "clock-refusals";
/** The job an op belongs to (run, labour and inspection ops carry it as jobRef; clock actions share one lane). */
export const jobOfOp = (op: OutboxOp): string =>
  op.kind === "run_start" || op.kind === "run_pause" || op.kind === "labour" || op.kind === "inspect" || op.kind === "clock_refusal" ? op.jobRef : op.kind === "clock" ? ATTENDANCE_LANE : op.jobId;
/** A Start or Pause of the Job Board's Play/Pause (049), or the 044/046 ones still on devices. */
export const isRunOp = (op: OutboxOp) => op.kind === "run_start" || op.kind === "run_pause";
/** A keyed time op of the daily job sheet (050 clock actions, 051 labour Start/Stop). */
export const isTimeOp = (op: OutboxOp): op is ClockOp | LabourOp => op.kind === "clock" || op.kind === "labour";

/** The device-store keys an op owns besides its entry (a photo's bytes). */
export const attachmentKeys = (op: OutboxOp): string[] => (op.kind === "photo" ? [op.blobKey] : []);
/** Where a photo's bytes live in the device store: under the scope, so they go with it. */
export const photoBlobKey = (scope: Scope, photoId: string) => `${scopeKey(scope)}|blob:${photoId}`;
/** `code` (photos): why it was held, when Retry must do more than send it again (see retryHeld). */
export type HeldEntry = OutboxEntry & { reason: string; server?: unknown; heldAt: string; code?: string };
/**
 * `opened` (run_start only): whether the Start still opened what it asked for (a time conflict did; a machine taken meanwhile, or an answer
 * missing a requested run, did not). A Pause queued after a Start that opened nothing is never sent (R3.4).
 */
export type ReplayOutcome =
  | { status: "applied"; version?: number | null }
  | { status: "conflict"; reason: string; server?: unknown; code?: string; opened?: boolean }
  | { status: "rejected"; reason: string; code?: string }
  | { status: "blocked"; code: string; reason: string }
  | { status: "network" };
export type Executor = (op: OutboxOp) => Promise<ReplayOutcome>;

/**
 * Held photo codes whose Retry sends the photo again under a NEW photo id (same note, same bytes): the server marked the old
 * reservation abandoned (photo_mismatch: the object stored at its path wasn't this photo; photo_abandoned: refused under that id),
 * so retrying the old id could only be refused again.
 */
export const RENEW_ON_RETRY = ["photo_mismatch", "photo_abandoned"];
/** A new photo id (UUID; the server's idempotency key). */
export const newPhotoId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
/** A file name for a photo exported from the device. */
export const exportFileName = (op: Pick<PhotoOp, "jobNo" | "photoId">) => `photo-${op.jobNo.replace(/[^\w.-]+/g, "_") || "job"}-${op.photoId.slice(0, 8)}.jpg`;

type List = "outbox" | "conflicts" | "rejected";
const key = (scope: Scope, list: List) => `${scopeKey(scope)}|${list}`;

async function read<T>(scope: Scope, list: List): Promise<T[]> {
  const store = offlineBackend();
  return store ? ((await store.get<T[]>(key(scope, list))) ?? []) : [];
}
const listOf = <T>(values: Record<string, unknown>, k: string) => (values[k] as T[] | undefined) ?? [];

let counter = 0;
/**
 * Queues a change. `attachments` (a photo's bytes under its blob key) are written in the same atomic step as the entry, so
 * the entry never exists without its bytes, or the bytes without an entry; resolves only once both are durable.
 */
export async function enqueue(scope: Scope, op: OutboxOp, now = new Date(), attachments: Record<string, unknown> = {}): Promise<OutboxEntry> {
  const store = offlineBackend();
  if (isSupportSession()) throw new Error(SUPPORT_NO_OFFLINE);
  if (!store) throw new Error("This device can't store changes offline. Reconnect and try again.");
  const keys = Object.keys(attachments);
  if (keys.some((k) => !attachmentKeys(op).includes(k))) throw new Error("An attachment must belong to the change it is queued with.");
  counter += 1;
  const entry: OutboxEntry = { id: `${now.getTime()}-${counter}-${Math.random().toString(36).slice(2, 8)}`, queuedAt: now.toISOString(), op };
  const out = key(scope, "outbox");
  await store.transact([out, ...keys], (values) => {
    // A newer save of the same worksheet replaces a queued one (same base version, latest content wins locally),
    // but never the one being sent right now: that one stays and this queues behind it.
    const queue = listOf<OutboxEntry>(values, out).filter((item) => item.inFlight || !(op.kind === "worksheet" && item.op.kind === "worksheet" && item.op.jobId === op.jobId));
    // The same photo queued twice (a double tap) stays one entry.
    if (op.kind === "photo" && queue.some((item) => item.op.kind === "photo" && item.op.photoId === op.photoId)) return { set: {} };
    // The same signature (one client key) queued twice stays one entry.
    if (op.kind === "signoff" && queue.some((item) => item.op.kind === "signoff" && item.op.clientOpId === op.clientOpId)) return { set: {} };
    // The same Start or Pause (one client key) queued twice stays one entry.
    if (isRunOp(op) && queue.some((item) => isRunOp(item.op) && (item.op as RunStartOp | RunPauseOp).clientOpId === (op as RunStartOp | RunPauseOp).clientOpId)) return { set: {} };
    // The same refused clock action's report (one client key) queued twice stays one entry.
    if (op.kind === "clock_refusal" && queue.some((item) => item.op.kind === "clock_refusal" && item.op.clientOpId === op.clientOpId)) return { set: {} };
    // The same clock action or labour Start/Stop (one client key) queued twice stays one entry.
    if (isTimeOp(op) && queue.some((item) => isTimeOp(item.op) && item.op.clientOpId === op.clientOpId)) return { set: {} };
    // A Pause belongs to the job's latest Start still waiting here (R3.4 capture rule), read in this same atomic step.
    if (op.kind === "run_pause") {
      const starts = queue.filter((item) => item.op.kind === "run_start" && item.op.jobRef === op.jobRef);
      entry.op = { ...op, afterStart: starts.length ? (starts[starts.length - 1].op as RunStartOp).clientOpId : null };
    }
    return { set: { [out]: [...queue, entry], ...attachments } };
  });
  return entry;
}

export const pendingEntries = (scope: Scope) => read<OutboxEntry>(scope, "outbox");
export const conflictEntries = (scope: Scope) => read<HeldEntry>(scope, "conflicts");
export const rejectedEntries = (scope: Scope) => read<HeldEntry>(scope, "rejected");

/** The bytes stored with a queued or held photo (null when they are gone). */
export async function readAttachment<T = Blob>(keyName: string): Promise<T | null> {
  const store = offlineBackend();
  return store ? ((await store.get<T>(keyName)) ?? null) : null;
}

/** Removes a resolved conflict or acknowledged rejection, and the bytes it owned, in one step. */
export async function dismissHeld(scope: Scope, list: "conflicts" | "rejected", id: string) {
  const store = offlineBackend();
  if (!store) return;
  const k = key(scope, list);
  const held = (await read<HeldEntry>(scope, list)).find((item) => item.id === id);
  const owned = held ? attachmentKeys(held.op) : [];
  await store.transact([k, ...owned], (values) => ({
    set: { [k]: listOf<HeldEntry>(values, k).filter((item) => item.id !== id), ...Object.fromEntries(owned.map((o) => [o, undefined])) },
  }));
}

/** Removes a change still waiting in the queue, and the bytes it owned, in one step (the person chose to discard it). */
export async function discardPending(scope: Scope, id: string) {
  const store = offlineBackend();
  if (!store) return;
  const out = key(scope, "outbox");
  const entry = (await read<OutboxEntry>(scope, "outbox")).find((item) => item.id === id);
  const owned = entry ? attachmentKeys(entry.op) : [];
  await store.transact([out, ...owned], (values) => ({
    set: { [out]: listOf<OutboxEntry>(values, out).filter((item) => item.id !== id), ...Object.fromEntries(owned.map((o) => [o, undefined])) },
  }));
}

/**
 * Puts a rejected change back in the queue to be sent again (a photo keeps its bytes). A photo held with a RENEW_ON_RETRY code
 * goes back under a new photo id (a new reservation; the old one stays abandoned on the server). Returns false when it is no
 * longer held.
 */
export async function retryHeld(scope: Scope, id: string): Promise<boolean> {
  const store = offlineBackend();
  if (!store) return false;
  if (isSupportSession()) throw new Error(SUPPORT_NO_OFFLINE);
  const held = key(scope, "rejected");
  const out = key(scope, "outbox");
  return store.transact<boolean>([held, out], (values) => {
    const item = listOf<HeldEntry>(values, held).find((entry) => entry.id === id);
    if (!item) return { set: {}, result: false };
    const op: OutboxOp = item.op.kind === "photo" && item.code && RENEW_ON_RETRY.includes(item.code) ? { ...item.op, photoId: newPhotoId() } : item.op;
    const entry: OutboxEntry = { id: item.id, queuedAt: item.queuedAt, op };
    return { set: { [held]: listOf<HeldEntry>(values, held).filter((entry) => entry.id !== id), [out]: [...listOf<OutboxEntry>(values, out), entry] }, result: true };
  });
}

// ----- one replayer per scope across tabs ----------------------------------------------------------------------
/** Runs `work` if this tab gets the named lock; resolves null when another tab (or call) already holds it. */
export type ReplayLock = <T>(name: string, work: () => Promise<T>) => Promise<T | null>;
const heldHere = new Set<string>();
const defaultLock: ReplayLock = async (name, work) => {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks) return locks.request(name, { ifAvailable: true }, (lock) => (lock ? work() : null));
  if (heldHere.has(name)) return null;
  heldHere.add(name);
  try {
    return await work();
  } finally {
    heldHere.delete(name);
  }
};
let replayLock: ReplayLock = defaultLock;
/** Tests swap in a lock shared between simulated tabs; null restores the default. */
export function setReplayLock(lock: ReplayLock | null) {
  replayLock = lock ?? defaultLock;
}

/** Replays the outbox in order. Returns counts; only one replay per scope runs at a time, across tabs. */
export async function replayOutbox(scope: Scope, execute: Executor, now = () => new Date()) {
  const ran = await withReplayLock(scope, () => drain(scope, execute, now));
  return ran ?? { applied: 0, conflicts: 0, rejected: 0, blocked: 0, remaining: (await pendingEntries(scope)).length };
}

/** Runs `work` holding `scope`'s replay lock (the one replayOutbox holds); null when another tab or call holds it. */
export function withReplayLock<T>(scope: Scope, work: () => Promise<T>): Promise<T | null> {
  return replayLock(`tolra-outbox-replay|${scopeKey(scope)}`, work);
}

/**
 * Waits until no tab is sending `scope`'s queue (an entry already sent has been answered), for at most `timeoutMs`; false when
 * one still is at the deadline. A company switch announces itself first (lib/access-recheck.ts beginOrganizationSwitch), so a
 * pass that starts after this returns sends nothing, and the session's company changes only once no request of the old one is open.
 */
export async function waitForReplayIdle(scope: Scope, timeoutMs = 15_000, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await withReplayLock(scope, async () => true)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** What a Pause that was never sent is told (R3.4): the Start it belonged to was refused or opened nothing. */
export function startRefusedReason(start: RunStartOp, machineName: (id: string) => string = () => "the machine") {
  const where = start.bench ? "on the bench" : `on ${start.machines.map(machineName).join(", ") || "the machine"}`;
  return `Not sent: the Start before it (${start.jobNo} ${where}) was refused, so there was nothing of yours to pause.`;
}
export const START_REFUSED = "start_refused";

/** Names for machines in reasons written while replaying (the board passes its list; the default says "the machine"). */
let machineNamer: (id: string) => string = () => "the machine";
export function setReplayMachineNames(namer: ((id: string) => string) | null) {
  machineNamer = namer ?? (() => "the machine");
}

/** An entry with its in-flight claim removed (the stored record goes back to the shape it was queued with). */
function released(item: OutboxEntry): OutboxEntry {
  const copy = { ...item };
  delete copy.inFlight;
  return copy;
}

async function drain(scope: Scope, execute: Executor, now: () => Date) {
  const result = { applied: 0, conflicts: 0, rejected: 0, blocked: 0, remaining: 0 };
  const store = offlineBackend();
  if (!store) return result;
  const out = key(scope, "outbox");
  const rejectedKey = key(scope, "rejected");
  // Jobs whose entry was blocked in this pass: their later entries wait for the next pass (a Pause never overtakes its Start).
  const skipped = new Set<string>();
  for (;;) {
    // Claim the oldest entry of a job not skipped in this pass: mark it in flight in the same step that reads it.
    const next = await store.transact<OutboxEntry | undefined>([out], (values) => {
      const queue = listOf<OutboxEntry>(values, out);
      const index = queue.findIndex((item) => !skipped.has(jobOfOp(item.op)));
      if (index < 0) return { set: {} };
      const head = queue[index];
      return { set: { [out]: queue.map((item, i) => (i === index ? { ...item, inFlight: true } : item)) }, result: head };
    });
    if (!next) break;
    let outcome: ReplayOutcome;
    try {
      outcome = await execute(next.op);
    } catch {
      outcome = { status: "network" };
    }
    if (outcome.status === "network") {
      result.remaining = await store.transact<number>([out], (values) => {
        // Released exactly as it was queued: the in-flight mark is removed, not left behind as `inFlight: false` on a kept record.
        const queue = listOf<OutboxEntry>(values, out).map((item) => (item.id === next.id ? released(item) : item));
        return { set: { [out]: queue }, result: queue.length };
      });
      return result;
    }
    if (outcome.status === "blocked") {
      // Stays queued exactly as it is (op unchanged), marked with why; the rest of this job waits for the next pass.
      const mark: BlockedMark = { code: outcome.code, reason: outcome.reason, at: now().toISOString() };
      await store.transact([out], (values) => ({
        set: { [out]: listOf<OutboxEntry>(values, out).map((item) => (item.id === next.id ? { id: item.id, queuedAt: item.queuedAt, op: item.op, blocked: mark } : item)) },
      }));
      skipped.add(jobOfOp(next.op));
      result.blocked += 1;
      continue;
    }
    const settled = outcome;
    const held = settled.status === "applied" ? null : key(scope, settled.status === "conflict" ? "conflicts" : "rejected");
    // An applied change's bytes (a photo) go with it; a held one keeps them for export or retry.
    const owned = settled.status === "applied" ? attachmentKeys(next.op) : [];
    // R3.4: a Start that opened nothing takes the Pauses captured after it out of the queue (held as start_refused, never sent).
    const sent = next.op;
    const startOpenedNothing = sent.kind === "run_start" && (settled.status === "rejected" || (settled.status === "conflict" && settled.opened === false));
    const keys = [out, ...(held ? [held] : []), ...(startOpenedNothing && held !== rejectedKey ? [rejectedKey] : []), ...owned];
    // Remove it and file it (conflicts / rejected) in one step: it is never in both lists, or in neither.
    const moved = await store.transact<number>(keys, (values) => {
      const current = listOf<OutboxEntry>(values, out);
      // Wiped while it was being sent (sign-out, company switch): nothing is filed back under that scope.
      if (!current.some((item) => item.id === next.id)) return { set: {}, result: 0 };
      let queue = current.filter((item) => item.id !== next.id);
      const set: Record<string, unknown> = {};
      if (settled.status === "applied") {
        for (const o of owned) set[o] = undefined;
        const version = settled.version;
        if (sent.kind === "worksheet" && typeof version === "number") {
          // A save queued behind this one was made on top of it: move it onto the version this one produced.
          queue = queue.map((item) => (item.op.kind === "worksheet" && item.op.jobId === sent.jobId && item.op.baseVersion === sent.baseVersion ? { ...item, op: { ...item.op, baseVersion: version } } : item));
        }
      } else if (held) {
        const entry: OutboxEntry = { id: next.id, queuedAt: next.queuedAt, op: next.op };
        const code = settled.status === "rejected" || settled.status === "conflict" ? settled.code : undefined;
        set[held] = [...listOf<HeldEntry>(values, held), { ...entry, reason: settled.reason, server: settled.status === "conflict" ? settled.server : undefined, heldAt: now().toISOString(), ...(code ? { code } : {}) }];
      }
      let dropped = 0;
      if (startOpenedNothing && sent.kind === "run_start") {
        const pauses = queue.filter((item) => item.op.kind === "run_pause" && item.op.afterStart === sent.clientOpId);
        if (pauses.length) {
          dropped = pauses.length;
          queue = queue.filter((item) => !pauses.includes(item));
          const heldAt = now().toISOString();
          const base = (set[rejectedKey] as HeldEntry[] | undefined) ?? listOf<HeldEntry>(values, rejectedKey);
          set[rejectedKey] = [...base, ...pauses.map((item): HeldEntry => ({ id: item.id, queuedAt: item.queuedAt, op: item.op, reason: startRefusedReason(sent, machineNamer), heldAt, code: START_REFUSED }))];
        }
      }
      set[out] = queue;
      return { set, result: dropped };
    });
    if (settled.status === "conflict") result.conflicts += 1;
    else if (settled.status === "rejected") result.rejected += 1;
    else result.applied += 1;
    result.rejected += moved;
  }
  result.remaining = (await pendingEntries(scope)).length;
  return result;
}

/**
 * Re-upgrade (plan R3.6 D1): a previous build sends a run_start / run_pause entry to its plain started_at update, which the server
 * refuses (the entry has no `jobId`), so that build files it as rejected WITHOUT a code. When this build loads, those
 * entries go back into the outbox in their original capture order per job (queued time, then id), with the op exactly as captured. Entries
 * this build held itself always carry a code and are left for the person.
 */
export async function requeueHeldRunOps(scope: Scope, _buildId: string): Promise<number> {
  const store = offlineBackend();
  if (!store || isSupportSession()) return 0;
  const out = key(scope, "outbox");
  const lists = [key(scope, "rejected"), key(scope, "conflicts")];
  // No per-build marker: recovery is per entry. An entry leaves the held list the moment it is recovered (so it is never recovered
  // twice), and this build never holds a run op without a code, so whatever is held without one was held by an older build, including
  // after a rollback that came after this build's first load.
  return store.transact<number>([out, ...lists], (values) => {
    const set: Record<string, unknown> = {};
    const back: HeldEntry[] = [];
    for (const list of lists) {
      const held = listOf<HeldEntry>(values, list);
      // 050/051: clock actions and labour Start/Stop are recovered the same way (this build always holds them with a code).
      const mine = held.filter((item) => (isRunOp(item.op) || isTimeOp(item.op)) && !item.code);
      if (mine.length) {
        back.push(...mine);
        set[list] = held.filter((item) => !mine.includes(item));
      }
    }
    if (!back.length) return { set: {}, result: 0 };
    const ordered = back.sort(byCapture);
    // Merge into the queue by capture order (not appended behind it): a Start the older build refused goes back BEFORE the Pause it
    // still had pending, so the Pause never overtakes its Start. Entries already queued keep their relative order.
    const queue = listOf<OutboxEntry>(values, out).slice();
    for (const item of ordered) {
      const at = queue.findIndex((q) => byCapture(q, item) > 0);
      queue.splice(at < 0 ? queue.length : at, 0, { id: item.id, queuedAt: item.queuedAt, op: item.op });
    }
    set[out] = queue;
    return { set, result: ordered.length };
  });
}
const byCapture = (a: { queuedAt: string; id: string }, b: { queuedAt: string; id: string }) => a.queuedAt.localeCompare(b.queuedAt) || entryOrder(a.id, b.id);
/** Entry ids are "<time>-<counter>-<random>": the counter orders two entries queued in the same millisecond. */
function entryOrder(a: string, b: string) {
  const [ta, ca] = a.split("-").map(Number);
  const [tb, cb] = b.split("-").map(Number);
  return (ta - tb) || (ca - cb) || a.localeCompare(b);
}
