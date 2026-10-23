/**
 * Offline outbox under concurrency (audit L3), against real IndexedDB semantics (fake-indexeddb).
 * Each "tab" is a fresh copy of the offline modules with its own IndexedDB connection, as in a browser.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxOp, ReplayOutcome } from "@/lib/offline/outbox";

type Tab = {
  outbox: typeof import("@/lib/offline/outbox");
  store: typeof import("@/lib/offline/store");
  scope: typeof import("@/lib/offline/scope");
};
async function openTab(): Promise<Tab> {
  vi.resetModules();
  const store = await import("@/lib/offline/store");
  const outbox = await import("@/lib/offline/outbox");
  const scope = await import("@/lib/offline/scope");
  store.setOfflineBackend(store.indexedDbBackend());
  return { store, outbox, scope };
}

/** Web Locks as the browser provides them: one holder per name across every tab of the origin. */
function webLocks() {
  const held = new Set<string>();
  return {
    async request<T>(name: string, _options: { ifAvailable: boolean }, work: (lock: { name: string } | null) => Promise<T>) {
      if (held.has(name)) return work(null);
      held.add(name);
      try {
        return await work({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

const alice = { userId: "user-a", orgId: "org-1" };
const aliceOtherCompany = { userId: "user-a", orgId: "org-2" };
const start = (n: number | string): OutboxOp => ({ kind: "start", jobId: `id-${n}`, jobNo: `J-${n}`, at: "2026-10-09T08:00:00Z" });
const sheet = (jobNo: string, content: string, baseVersion: number): OutboxOp => ({ kind: "worksheet", jobId: `id-${jobNo}`, jobNo, worksheet: { drawing_no: content }, baseVersion });
const applied: ReplayOutcome = { status: "applied" };
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

let session: Map<string, string>;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // a clean device for every test
  session = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => session.set(k, v), removeItem: (k: string) => session.delete(k) });
  vi.stubGlobal("navigator", { onLine: true, locks: webLocks() });
});
afterEach(() => vi.unstubAllGlobals());

describe("offline outbox: no lost or duplicated work under concurrency", () => {
  it("concurrent saves for different jobs are all kept, in order of arrival", async () => {
    const tab = await openTab();
    await Promise.all(Array.from({ length: 10 }, (_, i) => tab.outbox.enqueue(alice, start(i))));
    const queued = (await tab.outbox.pendingEntries(alice)).map((e) => e.op.jobNo).sort();
    expect(queued).toEqual(Array.from({ length: 10 }, (_, i) => `J-${i}`).sort());
  });

  it("a save made while replay is sending is kept and sent after", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, start(1));
    const g = gate();
    const sent: string[] = [];
    const replay = tab.outbox.replayOutbox(alice, async (op) => { sent.push(op.jobNo); if (op.jobNo === "J-1") await g.opened; return applied; });
    await tick();
    await tab.outbox.enqueue(alice, start(2)); // lands while J-1 is in flight
    g.open();
    expect(await replay).toMatchObject({ applied: 2, remaining: 0 });
    expect(sent).toEqual(["J-1", "J-2"]);
    expect(await tab.outbox.pendingEntries(alice)).toEqual([]);
  });

  it("two tabs replaying at once send each change exactly once", async () => {
    const one = await openTab();
    const two = await openTab();
    for (const n of [1, 2, 3]) await one.outbox.enqueue(alice, start(n));
    const sent: string[] = [];
    const g = gate();
    const exec = async (op: OutboxOp) => { sent.push(op.jobNo); await g.opened; return applied; };
    const first = one.outbox.replayOutbox(alice, exec);
    await tick();
    const second = await two.outbox.replayOutbox(alice, exec); // the other tab holds the lock: it waits its turn
    expect(second).toMatchObject({ applied: 0, remaining: 3 });
    g.open();
    expect(await first).toMatchObject({ applied: 3, remaining: 0 });
    expect(sent).toEqual(["J-1", "J-2", "J-3"]);
    // Meanwhile both tabs queued more: none lost, and they replay once each.
    await Promise.all([one.outbox.enqueue(alice, start(4)), two.outbox.enqueue(alice, start(5))]);
    await Promise.all([one.outbox.replayOutbox(alice, exec), two.outbox.replayOutbox(alice, exec)]);
    await one.outbox.replayOutbox(alice, exec); // whichever tab lost the race leaves nothing behind
    expect(sent.slice(3).sort()).toEqual(["J-4", "J-5"]);
    expect(await two.outbox.pendingEntries(alice)).toEqual([]);
  });

  it("a storage transaction that aborts after its write succeeded rejects, and nothing is kept as saved", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, start(1));
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      const request = put.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort()); // e.g. quota or the browser closing the store
      return request;
    });
    await expect(tab.outbox.enqueue(alice, start(2))).rejects.toBeTruthy();
    await expect(tab.store.offlineBackend()!.set("k", 1)).rejects.toBeTruthy();
    // The UI-facing queue reports it couldn't keep the change instead of claiming it was saved.
    tab.scope.setOfflineScope(alice);
    expect(await tab.scope.queueOffline(start(3))).toBe(false);
    spy.mockRestore();
    expect((await tab.outbox.pendingEntries(alice)).map((e) => e.op.jobNo)).toEqual(["J-1"]);
    expect(await tab.store.offlineBackend()!.get("k")).toBeUndefined();
  });

  it("a change in transact that throws leaves storage untouched", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, start(1));
    const backend = tab.store.offlineBackend()!;
    await expect(backend.transact(["x"], () => { throw new Error("bad change"); })).rejects.toThrow("bad change");
    expect(await tab.outbox.pendingEntries(alice)).toHaveLength(1);
  });

  it("pending work survives a reload and replays from the new page", async () => {
    const before = await openTab();
    await before.outbox.enqueue(alice, start(1));
    await before.outbox.enqueue(alice, sheet("J-2", "A", 4));
    const after = await openTab(); // new page, new connection, same device
    expect((await after.outbox.pendingEntries(alice)).map((e) => e.op.jobNo)).toEqual(["J-1", "J-2"]);
    const sent: OutboxOp[] = [];
    await after.outbox.replayOutbox(alice, async (op) => { sent.push(op); return applied; });
    expect(sent.map((op) => op.jobNo)).toEqual(["J-1", "J-2"]);
    expect(sent[1]).toMatchObject({ baseVersion: 4, worksheet: { drawing_no: "A" } });
  });
});

describe("worksheet coalescing", () => {
  it("a newer save replaces a queued one that hasn't been sent", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, sheet("J-1", "A", 2));
    await tab.outbox.enqueue(alice, start(2));
    await tab.outbox.enqueue(alice, sheet("J-1", "B", 2));
    const queue = await tab.outbox.pendingEntries(alice);
    expect(queue.map((e) => e.op.kind)).toEqual(["start", "worksheet"]);
    expect(queue[1].op).toMatchObject({ worksheet: { drawing_no: "B" }, baseVersion: 2 });
  });

  it("a save made while the same worksheet is being sent queues behind it on the new version (no false conflict)", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, sheet("J-1", "A", 2));
    const g = gate();
    const sent: OutboxOp[] = [];
    const replay = tab.outbox.replayOutbox(alice, async (op) => {
      sent.push(op);
      if (sent.length === 1) { await g.opened; return { status: "applied", version: 3 }; }
      return { status: "applied", version: 4 };
    });
    await tick();
    await tab.outbox.enqueue(alice, sheet("J-1", "B", 2)); // made on top of A while A is in flight
    g.open();
    expect(await replay).toMatchObject({ applied: 2, conflicts: 0 });
    expect(sent.map((op) => op.kind === "worksheet" && [op.worksheet.drawing_no, op.baseVersion])).toEqual([["A", 2], ["B", 3]]);
  });

  it("a save on a different base version is not moved (the version check still decides)", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, sheet("J-1", "A", 2));
    const g = gate();
    const sent: OutboxOp[] = [];
    const replay = tab.outbox.replayOutbox(alice, async (op) => { sent.push(op); if (sent.length === 1) await g.opened; return { status: "applied", version: 3 }; });
    await tick();
    await tab.outbox.enqueue(alice, sheet("J-1", "C", 7));
    g.open();
    await replay;
    expect(sent[1]).toMatchObject({ baseVersion: 7 });
  });
});

describe("conflicts and refusals", () => {
  it("are filed and removed from the queue in one step, with both versions kept", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, sheet("J-1", "MINE", 3));
    await tab.outbox.enqueue(alice, start(2));
    await tab.outbox.enqueue(alice, start(3));
    const outcomes: ReplayOutcome[] = [
      { status: "conflict", reason: "changed while offline", server: { drawing_no: "THEIRS", worksheet_version: 4 } },
      { status: "rejected", reason: "This job is locked." },
      applied,
    ];
    expect(await tab.outbox.replayOutbox(alice, async () => outcomes.shift()!)).toMatchObject({ applied: 1, conflicts: 1, rejected: 1, remaining: 0 });
    const [conflict] = await tab.outbox.conflictEntries(alice);
    expect(conflict).toMatchObject({ op: { worksheet: { drawing_no: "MINE" } }, server: { drawing_no: "THEIRS" } });
    expect(conflict).not.toHaveProperty("inFlight");
    expect((await tab.outbox.rejectedEntries(alice))[0]).toMatchObject({ reason: "This job is locked.", op: { jobNo: "J-2" } });
    expect(await tab.outbox.pendingEntries(alice)).toEqual([]);
  });

  it("an unreachable server keeps the change queued and still replaceable by a newer save", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, sheet("J-1", "A", 2));
    expect(await tab.outbox.replayOutbox(alice, async () => ({ status: "network" }))).toMatchObject({ remaining: 1 });
    await tab.outbox.enqueue(alice, sheet("J-1", "B", 2));
    const queue = await tab.outbox.pendingEntries(alice);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ op: { worksheet: { drawing_no: "B" } } });
  });
});

describe("sign-out and company switch", () => {
  it("replay and queues stay per company", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, start(1));
    await tab.outbox.enqueue(aliceOtherCompany, start(2));
    const sent: string[] = [];
    await tab.outbox.replayOutbox(alice, async (op) => { sent.push(op.jobNo); return applied; });
    expect(sent).toEqual(["J-1"]);
    expect((await tab.outbox.pendingEntries(aliceOtherCompany)).map((e) => e.op.jobNo)).toEqual(["J-2"]);
  });

  it("before removing the queue it syncs; if work is still waiting it asks, and Cancel keeps everything", async () => {
    const tab = await openTab();
    tab.scope.setOfflineScope(alice);
    await tab.outbox.enqueue(alice, start(1));
    const ask = vi.fn<(message: string) => boolean>(() => false);
    expect(await tab.scope.confirmUnsyncedDiscard("Signing out", async () => {}, ask)).toBe(false);
    expect(ask.mock.calls[0][0]).toMatch(/1 change made offline hasn't synced yet\. Signing out removes it from this device/);
    expect(await tab.outbox.pendingEntries(alice)).toHaveLength(1);
    // Once the sync gets through there is nothing to lose and nothing to ask.
    const sync = () => tab.outbox.replayOutbox(alice, async () => applied);
    const notAsked = vi.fn(() => false);
    expect(await tab.scope.confirmUnsyncedDiscard("Switching company", sync, notAsked)).toBe(true);
    expect(notAsked).not.toHaveBeenCalled();
  });

  it("a wipe removes only that company's queue, says how many changes went, and a send in flight isn't filed back", async () => {
    const tab = await openTab();
    await tab.outbox.enqueue(alice, start(1));
    await tab.outbox.enqueue(alice, start(2));
    await tab.outbox.enqueue(aliceOtherCompany, start(3));
    const g = gate();
    const replay = tab.outbox.replayOutbox(alice, async () => { await g.opened; return { status: "rejected", reason: "Your session has ended" }; });
    await tick();
    expect(await tab.store.wipeScope(alice)).toBe(2); // company switch
    g.open();
    await replay;
    expect(await tab.outbox.pendingEntries(alice)).toEqual([]);
    expect(await tab.outbox.rejectedEntries(alice)).toEqual([]);
    expect(await tab.outbox.pendingEntries(aliceOtherCompany)).toHaveLength(1);
    expect(tab.store.takeDiscardedCount()).toBe(2);
    expect(tab.store.takeDiscardedCount()).toBe(0); // said once
    expect(await tab.store.wipeAllOffline()).toBe(1); // sign-out / ended session
    expect(tab.store.takeDiscardedCount()).toBe(1);
    expect(await tab.store.offlineBackend()!.keys()).toEqual([]);
  });
});
