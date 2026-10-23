import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conflictEntries, enqueue, pendingEntries, rejectedEntries, replayOutbox, type OutboxOp, type ReplayOutcome } from "@/lib/offline/outbox";
import { loadOfflineSnapshot, saveOfflineSnapshot, setOfflineScope, wipeOfflineData, wipeOfflineScope } from "@/lib/offline/scope";
import { isNetworkError, lastSyncedLabel, loadSnapshot, memoryBackend, offlineBackend, saveSnapshot, setOfflineBackend, stripJobMoney } from "@/lib/offline/store";

const alice = { userId: "user-a", orgId: "org-1" };
const bob = { userId: "user-b", orgId: "org-2" };
const start = (jobNo: string): OutboxOp => ({ kind: "start", jobId: `id-${jobNo}`, jobNo, at: "2026-10-09T08:00:00Z" });

beforeEach(() => setOfflineBackend(memoryBackend()));
afterEach(() => { setOfflineBackend(null); setOfflineScope(null); });

describe("offline outbox replay", () => {
  it("replays in the order the changes were made and empties the queue", async () => {
    for (const no of ["J-1", "J-2", "J-3"]) await enqueue(alice, start(no));
    const seen: string[] = [];
    const result = await replayOutbox(alice, async (op) => { seen.push(op.jobNo); return { status: "applied" }; });
    expect(seen).toEqual(["J-1", "J-2", "J-3"]);
    expect(result).toMatchObject({ applied: 3, remaining: 0 });
    expect(await pendingEntries(alice)).toEqual([]);
  });

  it("stops at the first change that can't reach the server and keeps it and everything after it, in order", async () => {
    for (const no of ["J-1", "J-2", "J-3"]) await enqueue(alice, start(no));
    const outcomes: ReplayOutcome[] = [{ status: "applied" }, { status: "network" }];
    const result = await replayOutbox(alice, async () => outcomes.shift() ?? { status: "applied" });
    expect(result).toMatchObject({ applied: 1, remaining: 2 });
    expect((await pendingEntries(alice)).map((e) => e.op.jobNo)).toEqual(["J-2", "J-3"]);
    // A thrown error (fetch failed) counts as offline too: nothing is lost.
    await replayOutbox(alice, async () => { throw new TypeError("Failed to fetch"); });
    expect((await pendingEntries(alice)).map((e) => e.op.jobNo)).toEqual(["J-2", "J-3"]);
    await replayOutbox(alice, async () => ({ status: "applied" }));
    expect(await pendingEntries(alice)).toEqual([]);
  });

  it("a conflict keeps both versions and flags it; a refusal (locked/issued) is held with its reason; replay carries on", async () => {
    await enqueue(alice, { kind: "worksheet", jobId: "id-J-1", jobNo: "J-1", worksheet: { heat_cast_no: "MINE" }, baseVersion: 3 });
    await enqueue(alice, start("J-2"));
    await enqueue(alice, start("J-3"));
    const outcomes: ReplayOutcome[] = [
      { status: "conflict", reason: "changed while offline", server: { heat_cast_no: "THEIRS", worksheet_version: 4 } },
      { status: "rejected", reason: "This job is locked." },
      { status: "applied" },
    ];
    const result = await replayOutbox(alice, async () => outcomes.shift()!);
    expect(result).toMatchObject({ applied: 1, conflicts: 1, rejected: 1, remaining: 0 });
    const [conflict] = await conflictEntries(alice);
    expect(conflict.op).toMatchObject({ kind: "worksheet", worksheet: { heat_cast_no: "MINE" } }); // ours kept
    expect(conflict.server).toMatchObject({ heat_cast_no: "THEIRS" }); // theirs kept
    expect((await rejectedEntries(alice))[0]).toMatchObject({ reason: "This job is locked.", op: { jobNo: "J-2" } });
  });

  it("a later offline save of the same worksheet replaces the queued one (same base version)", async () => {
    await enqueue(alice, { kind: "worksheet", jobId: "id-J-1", jobNo: "J-1", worksheet: { drawing_no: "A" }, baseVersion: 2 });
    await enqueue(alice, start("J-2"));
    await enqueue(alice, { kind: "worksheet", jobId: "id-J-1", jobNo: "J-1", worksheet: { drawing_no: "B" }, baseVersion: 2 });
    const queue = await pendingEntries(alice);
    expect(queue.map((e) => e.op.kind)).toEqual(["start", "worksheet"]);
    expect(queue[1].op).toMatchObject({ worksheet: { drawing_no: "B" }, baseVersion: 2 });
  });
});

describe("offline copies stay with their person and company", () => {
  it("never reads another user's or company's copy", async () => {
    await saveSnapshot(alice, "jobs", [{ job_no: "A-1" }]);
    expect(await loadSnapshot(bob, "jobs")).toBeNull();
    expect(await loadSnapshot({ userId: "user-a", orgId: "org-2" }, "jobs")).toBeNull();
    expect((await loadSnapshot(alice, "jobs"))?.data).toEqual([{ job_no: "A-1" }]);
    await enqueue(alice, start("J-1"));
    expect(await pendingEntries(bob)).toEqual([]);
  });

  it("wipe on sign-out removes every copy and queued change on the device", async () => {
    setOfflineScope(alice);
    await saveOfflineSnapshot("jobs", [{ job_no: "A-1" }]);
    await enqueue(alice, start("J-1"));
    await saveSnapshot(bob, "jobs", [{ job_no: "B-1" }]);
    await wipeOfflineData();
    expect(await offlineBackend()!.keys()).toEqual([]);
    expect(await loadOfflineSnapshot("jobs")).toBeNull(); // scope cleared too
  });

  it("switching company removes only that company's copy", async () => {
    await saveSnapshot(alice, "jobs", [1]);
    await saveSnapshot({ userId: "user-a", orgId: "org-9" }, "jobs", [2]);
    await wipeOfflineScope(alice);
    expect(await loadSnapshot(alice, "jobs")).toBeNull();
    expect((await loadSnapshot({ userId: "user-a", orgId: "org-9" }, "jobs"))?.data).toEqual([2]);
  });

  it("job rows are stored without money fields", () => {
    expect(stripJobMoney({ id: "1", job_no: "J-1", value: 8400, total: 10, heat_cast_no: "H" })).toEqual({ id: "1", job_no: "J-1", heat_cast_no: "H" });
  });
});

describe("offline helpers", () => {
  it("tells unreachable from refused", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError({ message: "TypeError: NetworkError when attempting to fetch resource." })).toBe(true);
    expect(isNetworkError({ status: 503, message: "Service Unavailable" })).toBe(true);
    expect(isNetworkError({ code: "42501", message: "permission denied for table jobs" })).toBe(false);
    expect(isNetworkError({ code: "PT409", message: "This record is locked" })).toBe(false);
  });

  it("labels the last sync", () => {
    const now = new Date("2026-10-09T15:00:00");
    expect(lastSyncedLabel(new Date("2026-10-09T14:05:00").toISOString(), now)).toBe("Offline - last synced 14:05");
    expect(lastSyncedLabel(null, now)).toBe("Offline - not synced on this device yet");
  });
});
