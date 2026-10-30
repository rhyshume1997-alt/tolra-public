"use client";

/**
 * The offline scope in use (user + company), the status the banner shows, page snapshots, queueing, identity for
 * offline start-up and the wipes. No Supabase calls here (see lib/offline/sync.ts for replay).
 */
import { useSyncExternalStore } from "react";
import { blockOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";

import { conflictEntries, discardPending, exportFileName, dismissHeld, enqueue, pendingEntries, rejectedEntries, retryHeld, type HeldEntry, type OutboxEntry, type OutboxOp } from "@/lib/offline/outbox";
import { describePhotos, emptySummary, loadSnapshot, saveSnapshot, type Scope, scopeKey, setSupportSession, type UnsyncedSummary, unsyncedIdsForUser, unsyncedSummary, userPrefix, wipeAllOffline, wipeScope } from "@/lib/offline/store";

// ----- current scope (set by the user provider once the profile is known) -------------------------------------
let currentScope: Scope | null = null;
/** `support`: the session is the platform owner inside a company; nothing is then saved on this device (lib/offline/store.ts). */
export function setOfflineScope(scope: Scope | null, options: { support?: boolean } = {}) {
  if (scope && offlineAccessBlocked(scope.userId)) scope = null;
  const changed = (currentScope ? scopeKey(currentScope) : null) !== (scope ? scopeKey(scope) : null);
  currentScope = scope;
  setSupportSession(options.support === true);
  // A different company (or none): what was on show belonged to the old scope, so it goes at once, and any read still in
  // flight for the old scope is made obsolete. The new scope's counts then arrive from its own read.
  if (changed) clearStatus();
  void refreshCounts();
}
export const offlineScope = () => currentScope && !offlineAccessBlocked(currentScope.userId) ? currentScope : null;

/** Access ends without discarding any user or company's work. */
export function suspendOfflineAccess(userId: string) {
  if (currentScope?.userId === userId) {
    currentScope = null;
    clearStatus();
  }
  blockOfflineAccess(userId);
}

// ----- status for the banner -----------------------------------------------------------------------------------
/** `pendingItems`: every change still waiting in the queue, oldest first (the sync indicator lists them). */
export type OfflineStatus = { offline: boolean; syncedAt: string | null; pending: number; pendingItems: OutboxEntry[]; pendingPhotos: OutboxEntry[]; conflicts: HeldEntry[]; rejected: HeldEntry[] };
let status: OfflineStatus = { offline: false, syncedAt: null, pending: 0, pendingItems: [], pendingPhotos: [], conflicts: [], rejected: [] };
const listeners = new Set<() => void>();
function setStatus(next: Partial<OfflineStatus>) {
  status = { ...status, ...next };
  listeners.forEach((listener) => listener());
}
/** The status as it is now, outside React (tests). */
export const currentOfflineStatus = () => status;
export function useOfflineStatus() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => status, () => status);
}
/** A page fell back to its offline copy (or loaded live again). */
export function reportOffline(offline: boolean, syncedAt?: string | null) {
  setStatus(offline ? { offline: true, syncedAt: syncedAt ?? status.syncedAt } : { offline: false });
}
/** Which refreshCounts() is the newest; an older one that finishes later must not publish. */
let refreshToken = 0;
/** Empties the visible queue state and makes every read still in flight obsolete. */
function clearStatus() {
  refreshToken += 1;
  setStatus({ offline: false, syncedAt: null, pending: 0, pendingItems: [], pendingPhotos: [], conflicts: [], rejected: [] });
}
/**
 * Publishes the queue as read, unless it is exactly what is already on show: an unchanged queue (every sync pass of an idle shell)
 * gives the status no new arrays, so the sync indicator and banner do not re-render for nothing.
 */
function publishQueue(pending: OutboxEntry[], conflicts: HeldEntry[], rejected: HeldEntry[]) {
  const same = (shown: unknown[], read: unknown[]) => shown.length === read.length && JSON.stringify(shown) === JSON.stringify(read);
  if (status.pending === pending.length && same(status.pendingItems, pending) && same(status.conflicts, conflicts) && same(status.rejected, rejected)) return;
  setStatus({ pending: pending.length, pendingItems: pending, pendingPhotos: pending.filter((entry) => entry.op.kind === "photo"), conflicts, rejected });
}
export async function refreshCounts() {
  const scope = currentScope;
  const token = ++refreshToken;
  if (!scope) return publishQueue([], [], []);
  let read: [OutboxEntry[], HeldEntry[], HeldEntry[]];
  try {
    read = await Promise.all([pendingEntries(scope), conflictEntries(scope), rejectedEntries(scope)]);
  } catch (err) {
    console.error(err);
    return;
  }
  const [pending, conflicts, rejected] = read;
  // The scope was switched, signed out or wiped, or a newer read started, while this one waited: publishing now could show
  // another company's queue (or an older picture of this one).
  if (token !== refreshToken || !sameScope(scope)) return;
  publishQueue(pending, conflicts, rejected);
}

/** True while `scope` still names the scope in use: compared by key (user + company), because a refreshed scope object for the same company is not a change. */
const sameScope = (scope: Scope) => currentScope !== null && scopeKey(currentScope) === scopeKey(scope);

/**
 * The complete outbox for the current scope, read fresh: waiting, in conflict and refused. (A sync pass's own result only counts what
 * that pass found, not changes held by earlier ones.) Empty counts only when there is genuinely no scope. Returns null (unverified)
 * when the read could not be completed: it failed, or the company/user changed on every attempt. Callers must never read null as "nothing left".
 */
export async function outboxState(): Promise<{ pending: number; conflicts: number; rejected: number } | null> {
  // Counts come from this call's own read of the scope it started in, never from the shared status, which a newer or older
  // refresh may have written in between. If the scope's key changes while reading, the read is repeated for the new one.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scope = currentScope;
    if (!scope) return { pending: 0, conflicts: 0, rejected: 0 };
    const token = ++refreshToken;
    let read: [OutboxEntry[], HeldEntry[], HeldEntry[]];
    try {
      read = await Promise.all([pendingEntries(scope), conflictEntries(scope), rejectedEntries(scope)]);
    } catch (err) {
      console.error(err);
      return null;
    }
    if (!sameScope(scope)) continue;
    const [pending, conflicts, rejected] = read;
    if (token === refreshToken) publishQueue(pending, conflicts, rejected);
    return { pending: pending.length, conflicts: conflicts.length, rejected: rejected.length };
  }
  return null;
}

// ----- snapshots and queueing used by pages ----------------------------------------------------------------------
export const saveOfflineSnapshot = <T,>(name: string, data: T) => saveSnapshot(offlineScope(), name, data);
export const loadOfflineSnapshot = <T,>(name: string) => loadSnapshot<T>(offlineScope(), name);

/** Queues a change made offline; returns false when this device can't hold it (no scope or no storage). */
export async function queueOffline(op: OutboxOp) {
  const scope = offlineScope();
  if (!scope) return false;
  try {
    await enqueue(scope, op);
    await refreshCounts();
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/**
 * Queues a change together with the bytes it owns (a photo), in one atomic step. Unlike queueOffline it throws when the
 * device can't hold it (support session, no storage), so the caller can say why nothing was kept.
 */
export async function queueOfflineWith(op: OutboxOp, attachments: Record<string, unknown>) {
  if (!currentScope) throw new Error("Sign in again to keep this on the device.");
  const entry = await enqueue(currentScope, op, new Date(), attachments);
  await refreshCounts();
  return entry;
}

export async function dismissOfflineIssue(list: "conflicts" | "rejected", id: string) {
  if (!currentScope) return;
  await dismissHeld(currentScope, list, id);
  await refreshCounts();
}

/** Puts a refused change back in the queue to be sent again. */
export async function retryOfflineIssue(id: string) {
  if (!currentScope) return false;
  const back = await retryHeld(currentScope, id);
  await refreshCounts();
  return back;
}

/** Removes a change still waiting in the queue (the person chose to discard it), with the bytes it owned. */
export async function discardOfflinePending(id: string) {
  if (!currentScope) return;
  await discardPending(currentScope, id);
  await refreshCounts();
}

/** Saves photos still on the device as JPEG files (the browser's downloads). Returns how many were saved. */
export async function downloadPhotos(photos: UnsyncedSummary["photos"]) {
  const { readAttachment } = await import("@/lib/offline/outbox");
  let saved = 0;
  for (const photo of photos) {
    const blob = await readAttachment<Blob>(photo.blobKey);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(photo);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    saved += 1;
  }
  return saved;
}

export type DiscardOptions = {
  /** Sign-out: everything on the device is removed, so everything on it is counted (not only the current company's). */
  everything?: boolean;
  /** Saves the photos before they go (default: browser downloads). */
  exportPhotos?: (photos: UnsyncedSummary["photos"]) => Promise<number>;
};

/**
 * Before a sign-out or company switch removes this device's queue: syncs first, then, if changes are still waiting or were
 * held (refused or in conflict, photos included), asks. When photos would go it first offers to export them (saved as files),
 * then asks to remove. Returns false when the person chooses to stay. Unsynced work is never dropped silently.
 * Only the signed-in person's own work is described or exported (their scopes, across their companies). On a sign-out, which
 * wipes the whole device, other people's unsynced work on a shared tablet is a bare count: no job numbers, no photos, no export.
 */
export async function confirmUnsyncedDiscard(action: string, sync: () => Promise<unknown>, ask: (message: string) => boolean = (m) => window.confirm(m), options: DiscardOptions = {}) {
  const scope = currentScope;
  if (!scope && !options.everything) return true;
  const measure = async () => {
    const mine = scope ? await unsyncedSummary(options.everything ? userPrefix(scope.userId) : `${scopeKey(scope)}|`) : emptySummary();
    const others = 0; // sign-out removes only this person's own work; other people's stays on the device untouched
    return { mine, others };
  };
  let { mine, others } = await measure();
  if (!mine.changes && !others) return true;
  if (scope && (await pendingEntries(scope)).length) {
    try {
      await sync();
    } catch (err) {
      console.error(err);
    }
    ({ mine, others } = await measure());
    if (!mine.changes && !others) return true;
  }
  const n = mine.changes;
  const total = n + others;
  const changes = n === 1 ? "1 change made offline hasn't" : `${n} changes made offline haven't`;
  const signatures = mine.signatures ? `${mine.signatures} signature${mine.signatures === 1 ? "" : "s"} captured offline` : "";
  const photos = [describePhotos(mine), signatures].filter(Boolean).join(", ");
  const jobs = mine.jobNos.length ? ` Job${mine.jobNos.length === 1 ? "" : "s"}: ${mine.jobNos.join(", ")}.` : "";
  const detail = photos ? `\n\nNot uploaded: ${photos}.${jobs}` : jobs ? `\n\n${jobs.trim()}` : "";
  const otherPeople = "";
  if (mine.photos.length) {
    const count = mine.photos.length;
    if (ask(`${changes} synced yet.${detail}\n\nExport the ${count === 1 ? "photo" : `${count} photos`} first? OK saves ${count === 1 ? "it" : "them"} to this device as ${count === 1 ? "a file" : "files"}; Cancel goes on without saving.`)) {
      await (options.exportPhotos ?? downloadPhotos)(mine.photos);
    }
  }
  const head = n ? `${changes} synced yet. ${action} removes ${n === 1 ? "it" : "them"} from this device for good.${detail}` : `${action} removes unsynced changes from this device for good.`;
  return ask(`${head}${otherPeople}\n\nPress Cancel, reconnect and use "Sync now" to keep ${total === 1 ? "it" : "them"}, or OK to remove ${total === 1 ? "it" : "them"}.`);
}

/**
 * Company switch: the wait for other tabs' replays can last seconds, and the queue it then removes is shared by every tab.
 * Counts what is waiting or held for the company before and after the wait; true when more is there now (another tab queued
 * work, or a pass held an entry), so the switch is refused instead of removing what the person was never asked about.
 */
export async function queueGrewDuring(scope: Scope, during: () => Promise<unknown>) {
  const count = async () => (await unsyncedSummary(`${scopeKey(scope)}|`)).changes;
  const before = await count();
  await during();
  return (await count()) > before;
}

/** What a company switch tells the person when changes queued during it were kept under the company they left. */
export function keptAfterSwitchMessage(kept: number) {
  const one = kept === 1;
  return `${one ? "1 change" : `${kept} changes`} saved offline while switching ${one ? "was" : "were"} kept for the company you left. ${one ? "It sends" : "They send"} when you switch back to that company.`;
}

// ----- identity for offline start-up and wipes ------------------------------------------------------------------
export type OfflineIdentity = { profile: unknown; organizations: unknown; hiddenSections: string[] };
const identityScope = (userId: string): Scope => ({ userId, orgId: "identity" });
export const saveOfflineIdentity = (userId: string, identity: OfflineIdentity) => saveSnapshot(identityScope(userId), "identity", identity);
export const loadOfflineIdentity = (userId: string) => loadSnapshot<OfflineIdentity>(identityScope(userId), "identity");

/** Sign-out, disabled account or session ended: nothing stays on the device. */
export async function wipeOfflineData(confirmed?: ReadonlySet<string>) {
  const owner = currentScope?.userId;
  currentScope = null;
  clearStatus();
  try {
    await wipeAllOffline(owner, confirmed);
  } catch (err) {
    console.error(err);
  }
  setStatus({ offline: false, syncedAt: null, pending: 0, pendingItems: [], pendingPhotos: [], conflicts: [], rejected: [] });
}

/**
 * Sign-out: records the signing-out person's unsent change ids BEFORE asking, asks, then checks nothing new arrived (another tab
 * queued work during the prompt or the sync). Returns the recorded ids for wipeOfflineData to remove (only those, only this
 * person's), or null when the person cancelled or the queue grew: then nothing is removed and `notify` says why (ask again).
 */
export async function confirmSignOut(sync: () => Promise<unknown>, ask?: (message: string) => boolean, notify: (message: string) => void = (m) => window.alert(m), options: DiscardOptions = {}): Promise<Set<string> | null> {
  const userId = currentScope?.userId;
  const recorded = userId ? await unsyncedIdsForUser(userId) : new Set<string>();
  if (!(await confirmUnsyncedDiscard("Signing out", sync, ask, { ...options, everything: true }))) return null;
  const now = userId ? await unsyncedIdsForUser(userId) : new Set<string>();
  const added = [...now].filter((id) => !recorded.has(id)).length;
  if (added) {
    notify(`${added === 1 ? "1 change was" : `${added} changes were`} saved offline in another tab while you were signing out, so nothing was removed. Check ${added === 1 ? "it" : "them"} (Sync now) and sign out again.`);
    return null;
  }
  return recorded;
}

/**
 * The ids of every change queued or held for `scope`, read before a company switch asks the person: only these may be removed by
 * the switch's wipe (wipeOfflineScope `confirmed`). Anything queued later, in this tab or another, was never asked about.
 */
export async function unsyncedIds(scope: Scope | null): Promise<Set<string>> {
  if (!scope) return new Set();
  const lists = await Promise.all([pendingEntries(scope), conflictEntries(scope), rejectedEntries(scope)]);
  return new Set(lists.flat().map((entry) => entry.id));
}

/**
 * Switching away from a company: that company's copy and queue are removed from this device. With `confirmed` (unsyncedIds before
 * the person was asked), only those changes go: a change queued meanwhile (another tab, while switch_organization was on the wire)
 * stays under this company with its bytes, and sends when the person is in this company again. Returns how many changes were kept
 * (null when the wipe could not be completed).
 */
export async function wipeOfflineScope(scope: Scope | null, confirmed?: ReadonlySet<string>): Promise<number | null> {
  if (!scope) return 0;
  try {
    await wipeScope(scope, confirmed);
    return (await unsyncedSummary(`${scopeKey(scope)}|`)).changes;
  } catch (err) {
    console.error(err);
    return null;
  }
}

