import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { enqueue, pendingEntries, photoBlobKey, readAttachment, rejectedEntries, replayOutbox, type PhotoOp } from "@/lib/offline/outbox";
import { loadOfflineIdentity, offlineScope, saveOfflineIdentity, setOfflineScope, suspendOfflineAccess } from "@/lib/offline/scope";
import { loadSnapshot, memoryBackend, saveSnapshot, setOfflineBackend, setSupportSession } from "@/lib/offline/store";

const alice = { userId: "revoke-alice", orgId: "org-a" };
const elsewhere = { ...alice, orgId: "org-b" };
const bob = { userId: "revoke-bob", orgId: "org-a" };
let records: Map<string, unknown>;

beforeEach(() => {
  confirmOfflineAccess(alice.userId); confirmOfflineAccess(bob.userId);
  records = new Map(); setOfflineBackend(memoryBackend(records)); setSupportSession(false);
});
afterEach(() => {
  vi.unstubAllGlobals(); confirmOfflineAccess(alice.userId); confirmOfflineAccess(bob.userId);
  setOfflineScope(null); setOfflineBackend(null);
});

async function capture(scope = alice) {
  const photoId = `photo-${scope.userId}-${scope.orgId}`;
  const op: PhotoOp = { kind: "photo", photoId, jobId: "job-a", jobNo: "J-1", note: "Evidence", capturedAt: null,
    byteSize: 3, blobKey: photoBlobKey(scope, photoId) };
  await enqueue(scope, op, new Date(), { [op.blobKey]: new Blob([new Uint8Array([1, 2, 3])]) });
  return op;
}

describe("revocation quarantines access without deleting work", () => {
  it("preserves pending and held photos, other users and other companies byte for byte", async () => {
    const held = await capture();
    await replayOutbox(alice, async () => ({ status: "rejected", reason: "held" }));
    await enqueue(alice, { kind: "start", jobId: "job-b", jobNo: "J-2", at: "2026-10-15T08:00:00Z" });
    const otherCompany = await capture(elsewhere); const otherUser = await capture(bob);
    await saveSnapshot(alice, "jobs", ["private job"]);
    await saveOfflineIdentity(alice.userId, { profile: { organization_id: alice.orgId }, organizations: [], hiddenSections: [] });
    const before = structuredClone(records);
    setOfflineScope(alice);
    suspendOfflineAccess(alice.userId);
    expect(offlineScope()).toBeNull();
    expect(await loadOfflineIdentity(alice.userId)).toBeNull();
    expect(await loadSnapshot(alice, "jobs")).toBeNull();
    expect(records).toEqual(before);
    for (const op of [held, otherCompany, otherUser]) expect(new Uint8Array(await (await readAttachment(op.blobKey))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await pendingEntries(alice)).toHaveLength(1);
    expect(await rejectedEntries(alice)).toHaveLength(1);
    setOfflineScope(bob); expect(offlineScope()).toEqual(bob);
    setOfflineScope(alice); expect(offlineScope()).toBeNull();
    confirmOfflineAccess(alice.userId); setOfflineScope(alice);
    expect(offlineScope()).toEqual(alice);
    expect(await pendingEntries(alice)).toHaveLength(1);
  });

  it("locks without waiting for IndexedDB, even if every database operation fails", async () => {
    const backend = memoryBackend(records);
    setOfflineBackend({ ...backend, keys: vi.fn(async () => { throw new Error("storage broken"); }), delete: vi.fn(async () => { throw new Error("storage broken"); }) });
    setOfflineScope(alice);
    suspendOfflineAccess(alice.userId);
    expect(offlineScope()).toBeNull();
    expect(offlineAccessBlocked(alice.userId)).toBe(true);
  });

  it("fails closed when browser revocation storage cannot be read", async () => {
    await saveOfflineIdentity(alice.userId, { profile: {}, organizations: [], hiddenSections: [] });
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("storage denied"); } } });
    expect(await loadOfflineIdentity(alice.userId)).toBeNull();
  });

  it("does not return a snapshot whose read finishes after revocation", async () => {
    await saveSnapshot(alice, "jobs", ["private job"]);
    const backend = memoryBackend(records);
    setOfflineBackend({ ...backend, get: async <T>(key: string) => {
      const value = await backend.get<T>(key); suspendOfflineAccess(alice.userId); return value;
    } });
    expect(await loadSnapshot(alice, "jobs")).toBeNull();
  });
});
