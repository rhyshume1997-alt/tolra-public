import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enqueue, replayOutbox } from "@/lib/offline/outbox";
import { currentOfflineStatus, outboxState, refreshCounts, reportOffline, setOfflineScope, wipeOfflineData } from "@/lib/offline/scope";
import { memoryBackend, type OfflineBackend, setOfflineBackend } from "@/lib/offline/store";
import { connectionState } from "@/lib/shell-status";
import { describeChange, queuedAtLabel, retryOutcome, syncIndicator } from "@/lib/sync-status";

const online = { offline: false, browserOnline: true, pending: 0, held: 0 };

describe("sync indicator (top bar, every width)", () => {
  it("says online and synced when nothing is waiting", () => {
    expect(syncIndicator(online)).toEqual({ kind: "synced", short: "Synced", label: "Online and synced", tone: "good" });
  });
  it("counts the changes waiting to upload", () => {
    expect(syncIndicator({ ...online, pending: 1 })).toMatchObject({ kind: "pending", short: "1 to upload", label: "1 change waiting to upload", tone: "pending" });
    expect(syncIndicator({ ...online, pending: 3 }).label).toBe("3 changes waiting to upload");
  });
  it("is offline when the browser has no connection or a page fell back to the device copy", () => {
    expect(syncIndicator({ ...online, browserOnline: false })).toMatchObject({ kind: "offline", label: "Offline" });
    expect(syncIndicator({ ...online, offline: true, pending: 2 })).toMatchObject({ kind: "offline", label: "Offline – 2 changes kept on this device" });
  });
  it("puts a failed upload first: a person has to act", () => {
    const state = syncIndicator({ offline: true, browserOnline: false, pending: 4, held: 1 });
    expect(state).toMatchObject({ kind: "failed", short: "Needs attention", tone: "bad" });
    expect(state.label).toBe("Upload failed – needs attention (1 change not saved)");
  });
  it("never reuses the offline notice's sentences (other checks look for those by text)", () => {
    for (const input of [online, { ...online, pending: 1 }, { ...online, pending: 2, offline: true }, { ...online, held: 1 }, { ...online, held: 3 }]) {
      const { label, short } = syncIndicator(input);
      for (const text of [label, short]) expect(text).not.toMatch(/waiting to sync|last synced|offline changes? needs? attention|photos? waiting to upload/i);
    }
  });
  it("names each queued change by kind and job", () => {
    expect(describeChange({ kind: "worksheet", jobNo: "J-1001" })).toBe("Worksheet · J-1001");
    expect(describeChange({ kind: "signoff", jobNo: "J-7" })).toBe("Signature · J-7");
    // The Job Board's Play/Pause queue run_start / run_pause (049): they read as Start / Pause, not "Change".
    expect(describeChange({ kind: "run_start", jobNo: "J-8" })).toBe("Start · J-8");
    expect(describeChange({ kind: "run_pause", jobNo: "J-8" })).toBe("Pause · J-8");
    expect(describeChange({ kind: "photo", jobNo: "" })).toBe("Photo");
    expect(describeChange({ kind: "mystery" })).toBe("Change");
  });
  it("shows when a change was queued, or nothing for a bad time", () => {
    const at = new Date(2026, 9, 14, 9, 5);
    expect(queuedAtLabel(at.toISOString())).toBe("queued 09:05");
    expect(queuedAtLabel("not a date")).toBe("");
    expect(queuedAtLabel(null)).toBe("");
  });
});

describe("connection state in the drawer and chip", () => {
  it("says the upload failed when a change is held for a person", () => {
    expect(connectionState({ offline: false, pending: 0, conflicts: [{}], rejected: [] })).toEqual({ kind: "attention", label: "Upload failed", tone: "warn" });
    expect(connectionState({ offline: true, pending: 1, conflicts: [], rejected: [{}] }).kind).toBe("attention");
    expect(connectionState({ offline: false, pending: 0, conflicts: [], rejected: [] }).kind).toBe("online");
  });
});

describe("the outbox drives the indicator's list", () => {
  const scope = { userId: "u-1", orgId: "o-1" };
  beforeEach(() => { setOfflineBackend(memoryBackend()); });
  afterEach(() => { setOfflineScope(null); setOfflineBackend(null); });

  it("lists every waiting change, oldest first", async () => {
    setOfflineScope(scope);
    await enqueue(scope, { kind: "start", jobId: "j1", jobNo: "J-1", at: "2026-10-14T08:00:00Z" }, new Date("2026-10-14T08:00:00Z"));
    await enqueue(scope, { kind: "finish", jobId: "j2", jobNo: "J-2", at: "2026-10-14T09:00:00Z" }, new Date("2026-10-14T09:00:00Z"));
    await refreshCounts();
    const status = currentOfflineStatus();
    expect(status.pending).toBe(2);
    expect(status.pendingItems.map((item) => describeChange(item.op))).toEqual(["Start · J-1", "Finish · J-2"]);
    setOfflineScope(null);
    await refreshCounts();
    expect(currentOfflineStatus().pendingItems).toEqual([]);
  });
});

describe("Retry says what the whole outbox holds, not only what the last pass found", () => {
  const scope = { userId: "u-1", orgId: "o-1" };
  beforeEach(() => { setOfflineBackend(memoryBackend()); });
  afterEach(() => { setOfflineScope(null); setOfflineBackend(null); });

  it("is 'Everything is uploaded' only when nothing waits and nothing is held", () => {
    expect(retryOutcome({ ran: true, threw: false, outbox: { pending: 0, conflicts: 0, rejected: 0 } })).toMatchObject({ tone: "success", message: "Everything is uploaded.", showDetails: false });
    expect(retryOutcome({ ran: false, threw: false, outbox: { pending: 0, conflicts: 0, rejected: 0 } })).toMatchObject({ tone: "info" });
    expect(retryOutcome({ ran: true, threw: false, outbox: null })).toMatchObject({ tone: "warning", showDetails: false });
    expect(retryOutcome({ ran: true, threw: true, outbox: { pending: 1, conflicts: 0, rejected: 0 } }).message).toMatch(/Still can't reach the server/);
  });

  it("held-only: a later pass that finds nothing to send must not claim everything is uploaded", async () => {
    setOfflineScope(scope);
    await enqueue(scope, { kind: "finish", jobId: "j1", jobNo: "J-1", at: "2026-10-14T08:00:00Z" });
    const first = await replayOutbox(scope, async () => ({ status: "rejected", reason: "Job is closed." }));
    expect(first).toMatchObject({ rejected: 1, remaining: 0 });
    // The Retry pass: nothing left in the queue, so ITS result is all zeros...
    const second = await replayOutbox(scope, async () => ({ status: "applied" }));
    expect(second).toEqual({ applied: 0, conflicts: 0, rejected: 0, blocked: 0, remaining: 0 });
    // ...but the outbox still holds the refused change.
    const outbox = await outboxState();
    expect(outbox).toEqual({ pending: 0, conflicts: 0, rejected: 1 });
    const outcome = retryOutcome({ ran: true, threw: false, outbox });
    expect(outcome.tone).toBe("warning");
    expect(outcome.showDetails).toBe(true);
    expect(outcome.message).toContain("1 change not saved and needs you");
    expect(outcome.message).not.toMatch(/Everything is uploaded/);
  });

  it("held and still waiting are both named; conflicts count as held", () => {
    const outcome = retryOutcome({ ran: true, threw: true, outbox: { pending: 2, conflicts: 1, rejected: 1 } });
    expect(outcome.message).toContain("2 changes not saved and need you");
    expect(outcome.message).toContain("2 changes also still waiting to upload");
    expect(outcome.showDetails).toBe(true);
  });
});

/** A backend whose reads wait until released, so a test controls which refresh finishes first. */
function gatedBackend() {
  const base = memoryBackend();
  const waiting: Array<() => void> = [];
  let hold = false;
  const backend: OfflineBackend = {
    ...base,
    get: async <T,>(key: string) => {
      const value = await base.get<T>(key);
      if (hold) await new Promise<void>((resolve) => { waiting.push(resolve); });
      return value;
    },
  };
  return { backend, holdReads: (on: boolean) => { hold = on; }, release: (from: number, to?: number) => waiting.slice(from, to).forEach((resolve) => resolve()), count: () => waiting.length };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a refresh that finishes after the scope changed never publishes", () => {
  const a = { userId: "u-1", orgId: "company-a" };
  const b = { userId: "u-1", orgId: "company-b" };
  afterEach(() => { setOfflineScope(null); setOfflineBackend(null); });

  async function seed() {
    const gate = gatedBackend();
    setOfflineBackend(gate.backend);
    await enqueue(a, { kind: "start", jobId: "ja", jobNo: "A-1", at: "2026-10-14T08:00:00Z" });
    await enqueue(b, { kind: "start", jobId: "jb1", jobNo: "B-1", at: "2026-10-14T08:00:00Z" });
    await enqueue(b, { kind: "start", jobId: "jb2", jobNo: "B-2", at: "2026-10-14T08:00:00Z" });
    setOfflineScope(a);
    await tick();
    expect(currentOfflineStatus().pending).toBe(1);
    return gate;
  }

  it("company switch: the status is cleared at once and the old company's late result is dropped", async () => {
    const gate = await seed();
    gate.holdReads(true);
    const stale = refreshCounts(); // company A, reads pending
    await tick();
    const staleReads = gate.count();
    setOfflineScope(b); // switch: visible status goes immediately
    expect(currentOfflineStatus()).toMatchObject({ pending: 0, pendingItems: [] });
    await tick();
    gate.release(0, staleReads); // A's read finishes after the switch
    await stale;
    await tick();
    expect(currentOfflineStatus().pending).toBe(0); // not A's item, and B's own read is still waiting
    gate.holdReads(false);
    gate.release(staleReads);
    await tick();
    expect(currentOfflineStatus().pendingItems.map((item) => describeChange(item.op))).toEqual(["Start · B-1", "Start · B-2"]);
  });

  it("company switch: the new company's result is kept even if the old one finishes last", async () => {
    const gate = await seed();
    gate.holdReads(true);
    const stale = refreshCounts();
    await tick();
    const staleReads = gate.count();
    setOfflineScope(b);
    await tick();
    gate.release(staleReads); // B's reads first
    await tick();
    expect(currentOfflineStatus().pending).toBe(2);
    gate.release(0, staleReads); // then A's, late
    await stale;
    await tick();
    expect(currentOfflineStatus().pendingItems.map((item) => item.op.kind === "start" && item.op.jobNo)).toEqual(["B-1", "B-2"]);
  });

  it("sign-out: the status is cleared at once and an in-flight read cannot bring the queue back", async () => {
    const gate = await seed();
    gate.holdReads(true);
    const stale = refreshCounts();
    await tick();
    setOfflineScope(null);
    expect(currentOfflineStatus()).toMatchObject({ pending: 0, pendingItems: [], conflicts: [], rejected: [] });
    gate.release(0);
    await stale;
    await tick();
    expect(currentOfflineStatus().pending).toBe(0);
  });

  it("wipe on sign-out clears immediately, before the device is emptied", async () => {
    const gate = await seed();
    gate.holdReads(true);
    const stale = refreshCounts();
    await tick();
    const wiping = wipeOfflineData();
    expect(currentOfflineStatus().pending).toBe(0);
    gate.holdReads(false);
    gate.release(0);
    await Promise.all([stale, wiping]);
    expect(currentOfflineStatus().pending).toBe(0);
  });

  it("two refreshes in the same company: the newest wins, an older one finishing last cannot overwrite it", async () => {
    const gate = await seed();
    gate.holdReads(true);
    const older = refreshCounts();
    await tick();
    const olderReads = gate.count();
    await enqueue(a, { kind: "start", jobId: "ja2", jobNo: "A-2", at: "2026-10-14T09:00:00Z" });
    const newer = refreshCounts();
    await tick();
    gate.release(olderReads);
    await newer;
    gate.release(0, olderReads);
    await older;
    expect(currentOfflineStatus().pending).toBe(2);
  });
});

describe("scope change resets every company-specific status field", () => {
  const a = { userId: "u-1", orgId: "company-a" };
  const b = { userId: "u-1", orgId: "company-b" };
  beforeEach(() => { setOfflineBackend(memoryBackend()); });
  afterEach(() => { setOfflineScope(null); setOfflineBackend(null); });

  it("company B does not inherit company A's offline state or last-sync time", async () => {
    setOfflineScope(a);
    reportOffline(true, "2026-10-14T08:00:00Z");
    expect(currentOfflineStatus()).toMatchObject({ offline: true, syncedAt: "2026-10-14T08:00:00Z" });
    setOfflineScope(b);
    expect(currentOfflineStatus()).toMatchObject({ offline: false, syncedAt: null, pending: 0 });
    reportOffline(false);
    setOfflineScope(a);
    reportOffline(true, "2026-10-14T09:30:00Z");
    setOfflineScope(b);
    expect(currentOfflineStatus().syncedAt).toBeNull();
    expect(currentOfflineStatus().offline).toBe(false);
  });
});

describe("outboxState reads for itself", () => {
  const scope = { userId: "u-1", orgId: "o-1" };
  afterEach(() => { setOfflineScope(null); setOfflineBackend(null); });

  it("an older refresh finishing last cannot make Retry report a stale, empty outbox", async () => {
    const gate = gatedBackend();
    setOfflineBackend(gate.backend);
    setOfflineScope(scope);
    await tick();
    gate.holdReads(true);
    const stale = refreshCounts(); // reads while the outbox is empty, held
    await tick();
    await enqueue(scope, { kind: "start", jobId: "j1", jobNo: "J-1", at: "2026-10-14T08:00:00Z" });
    const pendingRead = outboxState();
    await tick();
    gate.holdReads(false);
    gate.release(0);
    await stale;
    expect(await pendingRead).toEqual({ pending: 1, conflicts: 0, rejected: 0 });
  });

  it("a change queued during Retry is counted", async () => {
    setOfflineBackend(memoryBackend());
    setOfflineScope(scope);
    await enqueue(scope, { kind: "finish", jobId: "j1", jobNo: "J-1", at: "2026-10-14T08:00:00Z" });
    await replayOutbox(scope, async () => ({ status: "applied" }));
    await enqueue(scope, { kind: "start", jobId: "j2", jobNo: "J-2", at: "2026-10-14T08:05:00Z" }); // queued while the pass ran
    const outbox = await outboxState();
    expect(outbox?.pending).toBe(1);
    expect(retryOutcome({ ran: true, threw: false, outbox }).message).not.toMatch(/Everything is uploaded/);
  });

  it("repeated scope refreshes for the same company keep the real counts (new object, same key)", async () => {
    const gate = gatedBackend();
    setOfflineBackend(gate.backend);
    setOfflineScope(scope);
    await enqueue(scope, { kind: "start", jobId: "j1", jobNo: "J-1", at: "2026-10-14T08:00:00Z" });
    await enqueue(scope, { kind: "start", jobId: "j2", jobNo: "J-2", at: "2026-10-14T08:05:00Z" });
    gate.holdReads(true);
    const read = outboxState();
    // Five refreshes of the profile while the read is in flight: each hands over a fresh object for the same company.
    for (let i = 0; i < 5; i += 1) {
      await tick();
      setOfflineScope({ ...scope });
    }
    gate.holdReads(false);
    gate.release(0);
    const outbox = await read;
    expect(outbox).toEqual({ pending: 2, conflicts: 0, rejected: 0 });
    expect(retryOutcome({ ran: true, threw: false, outbox }).tone).toBe("warning");
  });

  it("a company change on every attempt fails closed: unverified, never 'Everything is uploaded'", async () => {
    const gate = gatedBackend();
    setOfflineBackend(gate.backend);
    setOfflineScope(scope);
    await enqueue(scope, { kind: "start", jobId: "j1", jobNo: "J-1", at: "2026-10-14T08:00:00Z" });
    await tick();
    gate.holdReads(true);
    let settled = false;
    const read = outboxState().finally(() => { settled = true; });
    // Before every step of the read is allowed to finish, the profile has moved to another company.
    for (let i = 1; i <= 40 && !settled; i += 1) {
      await tick();
      setOfflineScope({ userId: "u-1", orgId: `company-${i}` });
      await tick();
      gate.release(0);
      await tick();
    }
    expect(settled).toBe(true);
    const outbox = await read;
    expect(outbox).toBeNull();
    const outcome = retryOutcome({ ran: true, threw: false, outbox });
    expect(outcome.tone).toBe("warning");
    expect(outcome.message).toMatch(/Couldn't check/);
    expect(outcome.message).not.toMatch(/Everything is uploaded/);
  });

  it("a read that throws fails closed too", async () => {
    const base = memoryBackend();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setOfflineBackend({ ...base, get: async () => { throw new Error("idb closed"); } });
    setOfflineScope(scope);
    expect(await outboxState()).toBeNull();
  });
});
