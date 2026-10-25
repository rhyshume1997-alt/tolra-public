/**
 * Sign-out removes only the signing-out person's unsent items, only the ids recorded before the prompt. Other people's items on a
 * shared device stay; work queued during the prompt (another tab) aborts the sign-out instead of being deleted unseen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, pendingEntries, readAttachment, rejectedEntries, replayOutbox, type ClockOp } from "@/lib/offline/outbox";
import { confirmSignOut, setOfflineScope, wipeOfflineData } from "@/lib/offline/scope";
import { memoryBackend, unsyncedIdsForUser, setOfflineBackend, setSupportSession, takeDiscardedNotice } from "@/lib/offline/store";

const alice = { userId: "user-a", orgId: "org-1" };
const aliceB = { userId: "user-a", orgId: "org-2" };
const bob = { userId: "user-b", orgId: "org-9" };
const clock = (id: string): ClockOp => ({ kind: "clock", v: 1, action: "in", at: "2026-10-15T07:00:00Z", clientOpId: id, device: "tablet", jobNo: "Daily job sheet" });
const offline = async () => { throw new Error("Failed to fetch"); };
let device: Map<string, unknown>;
const ids = async (scope: typeof alice) => (await pendingEntries(scope)).map((e) => (e.op as ClockOp).clientOpId);

beforeEach(() => {
  device = new Map();
  setOfflineBackend(memoryBackend(device));
  setSupportSession(false);
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) });
});
afterEach(() => { setOfflineBackend(null); setOfflineScope(null); vi.unstubAllGlobals(); });

describe("sign-out on a shared device", () => {
  it("two users: Alice signing out leaves Bob's unsent items (and his photo bytes) untouched", async () => {
    await enqueue(alice, clock("a1"));
    await enqueue(aliceB, clock("a2"));
    await enqueue(bob, clock("b1"));
    const blobKey = `u:user-b|o:org-9|photo|p1`;
    await enqueue(bob, { kind: "photo", photoId: "p1", jobId: "j", jobNo: "J-B", note: null, capturedAt: null, byteSize: 3, blobKey }, new Date(), { [blobKey]: "bytes" });
    setOfflineScope(alice);
    const ask = vi.fn(() => true);
    const confirmed = await confirmSignOut(offline, ask, vi.fn());
    expect(confirmed?.size).toBe(2);
    expect(ask.mock.calls.join()).not.toMatch(/other people|J-B/);
    await wipeOfflineData(confirmed!);
    expect(await ids(alice)).toEqual([]);
    expect(await ids(aliceB)).toEqual([]);
    expect(await ids(bob)).toEqual(["b1", undefined]); // his clock and his photo
    expect(await readAttachment(blobKey)).toBe("bytes");
    expect(takeDiscardedNotice()).toMatchObject({ count: 2, others: 0 });
  });

  it("two tabs: items queued after the ids were recorded are kept by the wipe, with bytes", async () => {
    await enqueue(alice, clock("a1"));
    setOfflineScope(alice);
    const recorded = await unsyncedIdsForUser(alice.userId);
    const blobKey = `u:user-a|o:org-1|photo|late`;
    await enqueue(alice, clock("late-clock"));
    await enqueue(alice, { kind: "photo", photoId: "late", jobId: "j", jobNo: "J-1", note: null, capturedAt: null, byteSize: 3, blobKey }, new Date(), { [blobKey]: "late-bytes" });
    await wipeOfflineData(recorded);
    expect(await ids(alice)).toContain("late-clock");
    expect((await pendingEntries(alice)).length).toBe(2);
    expect(await readAttachment(blobKey)).toBe("late-bytes");
    expect(takeDiscardedNotice()).toMatchObject({ count: 1 });
  });

  it("the queue grew between recording and confirming: sign-out aborts with the new count, deletes nothing", async () => {
    await enqueue(alice, clock("a1"));
    setOfflineScope(alice);
    const notify = vi.fn();
    const confirmed = await confirmSignOut(async () => { await enqueue(alice, clock("from-other-tab")); }, () => true, notify);
    expect(confirmed).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^1 change was saved offline in another tab/));
    expect((await ids(alice)).sort()).toEqual(["a1", "from-other-tab"]);
  });

  it("a failed sync leaves items unsent: they are asked about, then removed on OK; Cancel keeps them", async () => {
    await enqueue(alice, clock("a1"));
    await replayOutbox(alice, async () => ({ status: "rejected", reason: "Refused" }));
    await enqueue(alice, clock("a2"));
    setOfflineScope(alice);
    const no = vi.fn((_m: string) => false);
    expect(await confirmSignOut(offline, no, vi.fn())).toBeNull();
    expect(no.mock.calls[0][0]).toMatch(/^2 changes made offline haven't synced yet/);
    expect(await rejectedEntries(alice)).toHaveLength(1);
    const confirmed = await confirmSignOut(offline, () => true, vi.fn());
    await wipeOfflineData(confirmed!);
    expect(await ids(alice)).toEqual([]);
    expect(await rejectedEntries(alice)).toEqual([]);
  });

  it("re-login: Bob's items are still there, Alice's confirmed ones are gone, items added mid-prompt survive", async () => {
    await enqueue(alice, clock("a1"));
    await enqueue(bob, clock("b1"));
    setOfflineScope(alice);
    const recordedThenLate = await confirmSignOut(offline, () => true, vi.fn());
    await enqueue(alice, clock("a-late")); // lands after the check, before the wipe
    await wipeOfflineData(recordedThenLate!);
    setOfflineScope(bob);
    expect(await ids(bob)).toEqual(["b1"]);
    expect(await ids(alice)).toEqual(["a-late"]);
  });

  it("use-user signOut records ids before the prompt and wipes only them", () => {
    const source = readFileSync(path.resolve(__dirname, "../../lib/use-user.ts"), "utf8");
    const flow = source.slice(source.indexOf("const signOut"), source.indexOf("const switchOrganization"));
    expect(flow).toContain("confirmSignOut(syncNow)");
    expect(flow).toContain("wipeOfflineData(confirmedSignOut)");
    expect(flow.indexOf("confirmSignOut")).toBeLessThan(flow.indexOf("supabase.auth.signOut"));
  });
});
