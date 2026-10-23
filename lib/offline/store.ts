import { offlineAccessBlocked } from "@/lib/offline/access";

/**
 * Offline store for the workshop (Job Board, worksheets, machine schedule, workshop pack).
 *
 * The app, not the service worker, keeps a copy of what the signed-in person last loaded, so staff can keep reading
 * jobs and filling worksheets when Supabase or the internet is down. Rules:
 *   - Everything is filed under a scope = user id + organisation id. A read only ever looks in the current scope, so
 *     one company's (or one person's) copy is never shown to another.
 *   - Explicit confirmed sign-out and company switching can discard it. Revocation and session expiry preserve
 *     records; revoked identities cannot read cached snapshots until fresh server confirmation.
 *   - Snapshots are refreshed on every successful load and carry the time of that sync ("last synced HH:MM").
 *   - Job rows are stored without money fields (stripJobMoney): the offline copy never shows more than the
 *     workshop needs.
 *   - Nothing is saved while the session is a support session (the platform owner inside a company, migration 036): no
 *     snapshot, no identity, no queued change. Support work happens online or not at all.
 * Storage is IndexedDB in the browser; tests use the in-memory backend.
 */

export type Scope = { userId: string; orgId: string };
export type Snapshot<T> = { data: T; syncedAt: string };

/**
 * Reads `keys` and writes back what `change` returns, as one atomic step: no other write (from this tab or another)
 * can land between the read and the write. `change` must be synchronous; a key it returns as undefined is deleted,
 * a key it leaves out is untouched. Resolves only once the write is durable; rejects (nothing written) if it fails.
 */
export type Transact = <R = void>(keys: string[], change: (values: Record<string, unknown>) => { set: Record<string, unknown>; result?: R }) => Promise<R>;

/** Minimal key-value backend: IndexedDB in browsers, a Map in tests. */
export interface OfflineBackend {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  transact: Transact;
}

export function scopeKey(scope: Scope) {
  if (!scope.userId || !scope.orgId) throw new Error("Offline store needs a user and an organisation.");
  return `u:${scope.userId}|o:${scope.orgId}`;
}

/** In-memory backend for tests. Pass the same Map to two backends to model two tabs sharing one device store. */
export function memoryBackend(data = new Map<string, unknown>()): OfflineBackend {
  return {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async set<T>(key: string, value: T) { data.set(key, structuredClone(value)); },
    async delete(key: string) { data.delete(key); },
    async keys() { return [...data.keys()]; },
    // Synchronous read-change-write: nothing else can run in between.
    async transact(keys, change) {
      const { set, result } = change(Object.fromEntries(keys.map((key) => [key, structuredClone(data.get(key))])));
      for (const [key, value] of Object.entries(set)) {
        if (value === undefined) data.delete(key);
        else data.set(key, structuredClone(value));
      }
      return result as never;
    },
  };
}

const DB_NAME = "tolra-offline";
const STORE = "kv";

/** IndexedDB backend; null where IndexedDB isn't available (server render, some private windows). */
export function indexedDbBackend(): OfflineBackend | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opened;
  };
  // Settles when the transaction does: resolves on complete (the write is committed), rejects on abort or error.
  const finish = <T>(tx: IDBTransaction, value: () => T) => new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => resolve(value());
    tx.onabort = () => reject(tx.error ?? new Error("Offline storage transaction was aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("Offline storage transaction failed."));
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const tx = (await db()).transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    return finish(tx, () => request.result as T);
  };
  return {
    get: <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key)),
    set: async <T>(key: string, value: T) => { await run("readwrite", (s) => s.put(value, key)); },
    delete: async (key: string) => { await run("readwrite", (s) => s.delete(key)); },
    keys: async () => (await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys())).map(String),
    // One readwrite transaction: IndexedDB runs overlapping readwrite transactions one at a time, across tabs too.
    async transact(keys, change) {
      const tx = (await db()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let result: unknown;
      let failure: unknown;
      const done = finish(tx, () => result);
      const values: Record<string, unknown> = {};
      const apply = () => {
        try {
          const out = change(values);
          result = out.result;
          for (const [key, value] of Object.entries(out.set)) {
            if (value === undefined) store.delete(key);
            else store.put(value, key);
          }
        } catch (err) {
          failure = err;
          tx.abort();
        }
      };
      let left = keys.length;
      if (!left) apply();
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          values[key] = request.result;
          left -= 1;
          if (!left) apply();
        };
      }
      try {
        return (await done) as never;
      } catch (err) {
        throw failure ?? err;
      }
    },
  };
}

let supportSession = false;
/** Set by the user provider from the session info: true while the platform owner is working inside a company. */
export function setSupportSession(value: boolean) {
  supportSession = value;
}
export const isSupportSession = () => supportSession;
export const SUPPORT_NO_OFFLINE = "Support access doesn't keep anything on this device, so changes can't be queued offline. Reconnect and try again.";

let backend: OfflineBackend | null | undefined;
/** The backend in use (IndexedDB by default). Tests swap in memoryBackend(). */
export function offlineBackend(): OfflineBackend | null {
  if (backend === undefined) backend = indexedDbBackend();
  return backend;
}
export function setOfflineBackend(next: OfflineBackend | null) {
  backend = next;
}

/** Saves a snapshot under the current scope, stamped with the sync time. Never throws: offline copies are a bonus. */
export async function saveSnapshot<T>(scope: Scope | null, name: string, data: T, now = new Date()) {
  const store = offlineBackend();
  if (!store || !scope || supportSession || offlineAccessBlocked(scope.userId)) return;
  try {
    await store.set<Snapshot<T>>(`${scopeKey(scope)}|snap:${name}`, { data, syncedAt: now.toISOString() });
  } catch (err) {
    console.error(err);
  }
}

export async function loadSnapshot<T>(scope: Scope | null, name: string): Promise<Snapshot<T> | null> {
  const store = offlineBackend();
  if (!store || !scope || offlineAccessBlocked(scope.userId)) return null;
  try {
    const saved = await store.get<Snapshot<T>>(`${scopeKey(scope)}|snap:${name}`);
    return offlineAccessBlocked(scope.userId) ? null : saved ?? null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** What unsynced work a set of device-store keys holds: queued changes and held ones (refused or in conflict), photos apart. */
export type UnsyncedSummary = {
  changes: number;
  photosWaiting: number;
  photosHeld: number;
  jobNos: string[];
  /** Signatures captured offline among them (migration 045), waiting or held: a sign-out says so before they go. */
  signatures: number;
  /** The photos among them (no bytes: where the bytes are, for an export before a discard). */
  photos: { blobKey: string; jobNo: string; photoId: string }[];
};
type Listed = { id?: string; op?: { kind?: string; jobNo?: string; blobKey?: string; photoId?: string } };
const isListKey = (key: string) => key.endsWith("|outbox") || key.endsWith("|rejected") || key.endsWith("|conflicts");
/** Adds one list's entries to `out` (`waiting`: the outbox, not a held list). */
function tally(out: UnsyncedSummary, entries: Listed[], waiting: boolean) {
  for (const entry of entries) {
    out.changes += 1;
    const op = entry?.op ?? {};
    if (op.jobNo && !out.jobNos.includes(op.jobNo)) out.jobNos.push(op.jobNo);
    if (op.kind === "signoff") out.signatures += 1;
    if (op.kind === "photo") {
      if (waiting) out.photosWaiting += 1;
      else out.photosHeld += 1;
      out.photos.push({ blobKey: String(op.blobKey ?? ""), jobNo: String(op.jobNo ?? ""), photoId: String(op.photoId ?? "") });
    }
  }
}
async function summarise(store: OfflineBackend, keys: string[]): Promise<UnsyncedSummary> {
  const out: UnsyncedSummary = { changes: 0, photosWaiting: 0, photosHeld: 0, jobNos: [], signatures: 0, photos: [] };
  for (const key of keys) {
    if (!isListKey(key)) continue;
    tally(out, (await store.get<Listed[]>(key)) ?? [], key.endsWith("|outbox"));
  }
  return out;
}

export const emptySummary = (): UnsyncedSummary => ({ changes: 0, photosWaiting: 0, photosHeld: 0, jobNos: [], signatures: 0, photos: [] });
/** The key prefix of everything one person keeps on this device, across their companies (scopeKey starts with it). */
export const userPrefix = (userId: string) => `u:${userId}|`;

/** Unsynced work on this device: under one key prefix (a scope: `${scopeKey(scope)}|`), or everywhere when none is given. */
export async function unsyncedSummary(prefix?: string): Promise<UnsyncedSummary> {
  const store = offlineBackend();
  if (!store) return emptySummary();
  const keys = (await store.keys()).filter((key) => prefix === undefined || key.startsWith(prefix));
  return summarise(store, keys);
}

/** "2 photos waiting to upload, 1 photo that failed" (empty when there are no photos). */
export function describePhotos(summary: Pick<UnsyncedSummary, "photosWaiting" | "photosHeld">) {
  const parts: string[] = [];
  if (summary.photosWaiting) parts.push(`${summary.photosWaiting} photo${summary.photosWaiting === 1 ? "" : "s"} waiting to upload`);
  if (summary.photosHeld) parts.push(`${summary.photosHeld} photo${summary.photosHeld === 1 ? "" : "s"} that failed`);
  return parts.join(", ");
}

const DISCARDED_KEY = "tolra-offline-discarded";
/**
 * What a wipe removed without the person choosing to (access revoked, session ended), and what a confirmed discard removed:
 * kept in this browser tab's sessionStorage, outside every wiped scope, as counts and job numbers only (never a picture, a
 * note or a worksheet), and shown once on the sign-in page or the banner. Only the signed-in person's own work is described (count, photos,
 * job numbers); other people's on a shared device is a bare count in `others`, never their jobs.
 */
export type DiscardedNotice = { count: number; photos: number; jobNos: string[]; others: number };
function noteDiscarded(summary: UnsyncedSummary, others = 0) {
  if (!summary.changes && !others) return;
  try {
    const before = readNotice();
    const notice: DiscardedNotice = {
      count: (before?.count ?? 0) + summary.changes,
      photos: (before?.photos ?? 0) + summary.photosWaiting + summary.photosHeld,
      jobNos: [...new Set([...(before?.jobNos ?? []), ...summary.jobNos])].slice(0, 50),
      others: (before?.others ?? 0) + others,
    };
    sessionStorage.setItem(DISCARDED_KEY, JSON.stringify(notice));
  } catch {
    // no sessionStorage (server render, blocked storage): nothing to show later
  }
}
function readNotice(): DiscardedNotice | null {
  const raw = sessionStorage.getItem(DISCARDED_KEY);
  if (!raw) return null;
  const parsed: unknown = /^\d+$/.test(raw) ? { count: Number(raw), photos: 0, jobNos: [], others: 0 } : JSON.parse(raw);
  const n = parsed as Partial<DiscardedNotice>;
  const count = Number(n.count) || 0;
  const others = Number(n.others) || 0;
  if (count < 0 || others < 0 || count + others <= 0) return null;
  return { count, photos: Number(n.photos) || 0, jobNos: Array.isArray(n.jobNos) ? n.jobNos.map(String) : [], others };
}
/** What the last wipes removed (null when nothing); reading clears it, so it is said once. */
export function takeDiscardedNotice(): DiscardedNotice | null {
  try {
    const notice = readNotice();
    sessionStorage.removeItem(DISCARDED_KEY);
    return notice;
  } catch {
    return null;
  }
}
/** How many unsynced changes the last wipes removed (the person's own and other people's); reading clears it. */
export function takeDiscardedCount() {
  const notice = takeDiscardedNotice();
  return notice ? notice.count + notice.others : 0;
}
/**
 * "3 offline changes that hadn't synced were removed from this device. 2 of them were photos. Jobs: J-1, J-2. Please enter them
 * again." The first sentence is the one the sign-in page and banner have always shown; photos and jobs follow as their own.
 */
export function discardedMessage(notice: DiscardedNotice, when: string) {
  const { count, photos, jobNos, others } = notice;
  const sentences: string[] = [];
  if (count) {
    sentences.push(`${count} offline change${count === 1 ? "" : "s"} that hadn't synced ${count === 1 ? "was" : "were"} removed from this device${when}.`);
    if (photos) sentences.push(count === 1 ? "It was a photo." : `${photos} of them ${photos === 1 ? "was a photo" : "were photos"}.`);
    if (jobNos.length) sentences.push(`Job${jobNos.length === 1 ? "" : "s"}: ${jobNos.join(", ")}.`);
    sentences.push(`Please enter ${count === 1 ? "it" : "them"} again.`);
  }
  if (others) sentences.push(`${others} unsynced change${others === 1 ? "" : "s"} by other people on this device ${others === 1 ? "was" : "were"} also removed${count ? "" : when}.`);
  return sentences.join(" ");
}

/**
 * Removes everything stored for one user and company. Returns how many unsynced changes (queued or held) it removed.
 * `confirmed` (a company switch): the ids of the queued and held changes the person agreed to remove. Any other change (queued in
 * another tab while the switch was waiting for the server) is kept under this company with its bytes, and sends when the person
 * is in this company again. The lists are read and changed in ONE storage transaction, which a queueing tab's own transaction
 * (enqueue: entry and bytes together) runs entirely before or after, so nothing queued in between is lost. Bytes stored after the
 * key listing below are not in the transaction at all, so they are never touched.
 */
export async function wipeScope(scope: Scope, confirmed?: ReadonlySet<string>) {
  const store = offlineBackend();
  if (!store) return 0;
  const prefix = `${scopeKey(scope)}|`;
  const keys = (await store.keys()).filter((key) => key.startsWith(prefix));
  if (!confirmed) {
    const discarded = await summarise(store, keys);
    for (const key of keys) await store.delete(key);
    noteDiscarded(discarded);
    return discarded.changes;
  }
  const lists = ["outbox", "conflicts", "rejected"].map((list) => `${prefix}${list}`);
  const all = [...new Set([...keys, ...lists])];
  const discarded = await store.transact<UnsyncedSummary>(all, (values) => {
    const gone = emptySummary();
    const keep = new Set<string>();
    const set: Record<string, unknown> = {};
    for (const list of lists) {
      const entries = (values[list] as Listed[] | undefined) ?? [];
      const kept = entries.filter((entry) => !confirmed.has(String(entry?.id)));
      tally(gone, entries.filter((entry) => !kept.includes(entry)), list.endsWith("|outbox"));
      if (!kept.length) continue;
      set[list] = kept;
      keep.add(list);
      for (const entry of kept) if (entry?.op?.blobKey) keep.add(entry.op.blobKey);
    }
    for (const key of all) if (!keep.has(key)) set[key] = undefined;
    return { set, result: gone };
  });
  noteDiscarded(discarded);
  return discarded.changes;
}

/**
 * Removes every offline copy on this device (sign-out, disabled account, ended session). Returns unsynced changes removed. The
 * notice describes only `ownerUserId`'s own work; anyone else's (a shared tablet) is counted, never named.
 */
export async function wipeAllOffline(ownerUserId?: string) {
  const store = offlineBackend();
  if (!store) return 0;
  const keys = await store.keys();
  const ownKey = (key: string) => ownerUserId !== undefined && key.startsWith(userPrefix(ownerUserId));
  const mine = await summarise(store, keys.filter(ownKey));
  const others = await summarise(store, keys.filter((key) => !ownKey(key)));
  for (const key of keys) await store.delete(key);
  noteDiscarded(mine, others.changes);
  return mine.changes + others.changes;
}

/** Money fields never stored offline (Job Board rows carry the job value for office/admin screens). */
const JOB_MONEY_FIELDS = ["value", "total", "total_value", "unit_price", "price", "cost", "amount", "amount_paid"];
export function stripJobMoney<T extends Record<string, unknown>>(row: T): T {
  const copy = { ...row };
  for (const key of JOB_MONEY_FIELDS) delete copy[key];
  return copy;
}

/** "Offline - last synced 14:05" (today) or with the date when older. */
export function lastSyncedLabel(syncedAt: string | null | undefined, now = new Date()) {
  if (!syncedAt) return "Offline - not synced on this device yet";
  const at = new Date(syncedAt);
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  return `Offline - last synced ${sameDay ? time : `${at.toLocaleDateString("en-GB")} ${time}`}`;
}

/**
 * True for errors that mean "couldn't reach the server" (as opposed to a refusal from it). A session that ended server-side
 * (017, SQLSTATE 28000 "Your session has ended") counts too: the device is offline until the person signs in again, so a queued
 * change waits (it is not held as rejected) and sends after that sign-in.
 */
export function isNetworkError(err: unknown) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const message = err instanceof Error ? err.message : typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : String(err ?? "");
  const status = typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : NaN;
  const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "";
  if (code === "28000" || /your session has ended/i.test(message)) return true;
  return /Failed to fetch|NetworkError|Load failed|network|fetch failed|ECONNREFUSED|timed? ?out/i.test(message) || status === 0 || status === 502 || status === 503 || status === 504;
}

