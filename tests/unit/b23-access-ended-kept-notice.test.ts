/** B23 (b): when access ends with unsent offline work, the sign-in page tells the person how many changes were kept, not sent. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmOfflineAccess } from "@/lib/offline/access";
import { conflictEntries, enqueue, pendingEntries, rejectedEntries, replayOutbox, type OutboxOp } from "@/lib/offline/outbox";
import { currentOfflineStatus, refreshCounts, setOfflineScope, suspendOfflineAccess } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { accessEndedKeptMessage } from "@/lib/session-policy";

const alice = { userId: "kept-notice-user", orgId: "kept-notice-co" };
const bob = { userId: "kept-notice-other", orgId: "kept-notice-co" };
const start = (jobNo: string): OutboxOp => ({ kind: "start", jobId: `id-${jobNo}`, jobNo, at: "2026-10-09T08:00:00Z" });
const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");

afterEach(() => { setOfflineScope(null); setOfflineBackend(null); confirmOfflineAccess(alice.userId); confirmOfflineAccess(bob.userId); });

describe("accessEndedKeptMessage", () => {
  it("says nothing when no change was waiting", () => {
    expect(accessEndedKeptMessage(0)).toBe("");
    expect(accessEndedKeptMessage(-1)).toBe("");
  });
  it("one and several changes: not sent, still saved on this device, sent if access is restored", () => {
    expect(accessEndedKeptMessage(1)).toBe(" 1 change you made offline was not sent and is still saved on this device. It will be sent if your access is restored and you sign in again.");
    expect(accessEndedKeptMessage(3)).toBe(" 3 changes you made offline were not sent and are still saved on this device. They will be sent if your access is restored and you sign in again.");
  });
});

describe("the count endAccess records", () => {
  it("is the in-memory queue (waiting + held) read BEFORE the lock clears it; the queue itself is kept", async () => {
    setOfflineBackend(memoryBackend());
    setOfflineScope(alice);
    await enqueue(alice, start("J-1"));
    await enqueue(alice, start("J-2"));
    await replayOutbox(alice, async (op) => (op.kind === "start" && op.jobNo === "J-1" ? { status: "rejected", reason: "refused" } : { status: "network" }));
    await refreshCounts();
    const shown = currentOfflineStatus();
    expect(shown.pending + shown.conflicts.length + shown.rejected.length).toBe(2);
    suspendOfflineAccess(alice.userId);
    // After the lock the counts are gone (so the notice must be read first), but the work is still on the device.
    expect(currentOfflineStatus().pending + currentOfflineStatus().rejected.length).toBe(0);
    expect(await pendingEntries(alice)).toHaveLength(1);
  });

  // Every state a kept change can be in: waiting, blocked (still in the outbox, marked), conflict, rejected. All are counted.
  const counted = () => { const shown = currentOfflineStatus(); return shown.pending + shown.conflicts.length + shown.rejected.length; };
  it("counts a waiting change", async () => {
    setOfflineBackend(memoryBackend());
    setOfflineScope(alice);
    await enqueue(alice, start("W-1"));
    await replayOutbox(alice, async () => ({ status: "network" }));
    await refreshCounts();
    expect(currentOfflineStatus().pending).toBe(1);
    expect(counted()).toBe(1);
  });
  it("counts a blocked change (it stays in the outbox, marked)", async () => {
    setOfflineBackend(memoryBackend());
    setOfflineScope(alice);
    await enqueue(alice, start("B-1"));
    await replayOutbox(alice, async () => ({ status: "blocked", code: "locked", reason: "waiting for the job" }));
    await refreshCounts();
    expect((await pendingEntries(alice))[0]?.blocked?.code).toBe("locked");
    expect(currentOfflineStatus().pending).toBe(1);
    expect(counted()).toBe(1);
  });
  it("counts a conflicted change (held in the conflicts list)", async () => {
    setOfflineBackend(memoryBackend());
    setOfflineScope(alice);
    await enqueue(alice, start("C-1"));
    await replayOutbox(alice, async () => ({ status: "conflict", reason: "changed on the server" }));
    await refreshCounts();
    expect(await conflictEntries(alice)).toHaveLength(1);
    expect(currentOfflineStatus().pending).toBe(0);
    expect(currentOfflineStatus().conflicts).toHaveLength(1);
    expect(counted()).toBe(1);
  });
  it("counts a rejected change (held in the rejected list)", async () => {
    setOfflineBackend(memoryBackend());
    setOfflineScope(alice);
    await enqueue(alice, start("R-1"));
    await replayOutbox(alice, async () => ({ status: "rejected", reason: "refused" }));
    await refreshCounts();
    expect(await rejectedEntries(alice)).toHaveLength(1);
    expect(currentOfflineStatus().pending).toBe(0);
    expect(currentOfflineStatus().rejected).toHaveLength(1);
    expect(counted()).toBe(1);
  });
  it("counts all four states together", async () => {
    setOfflineBackend(memoryBackend());
    setOfflineScope(alice);
    for (const jobNo of ["W-1", "B-1", "C-1", "R-1"]) await enqueue(alice, start(jobNo));
    await replayOutbox(alice, async (op) => {
      if (op.kind !== "start") return { status: "network" };
      if (op.jobNo === "R-1") return { status: "rejected", reason: "refused" };
      if (op.jobNo === "C-1") return { status: "conflict", reason: "changed" };
      if (op.jobNo === "B-1") return { status: "blocked", code: "locked", reason: "waiting" };
      return { status: "network" };
    });
    await refreshCounts();
    expect(counted()).toBe(4);
  });

  it("use-user endAccess writes the notice before clearing the scope and before going to /login?disabled=1", () => {
    const source = read("lib/use-user.ts");
    const flow = source.slice(source.indexOf("async function endAccess"), source.indexOf("function installRecheck"));
    const write = flow.indexOf('JSON.stringify({ reason: "disabled", pending: shown.pending + shown.conflicts.length + shown.rejected.length })');
    expect(write).toBeGreaterThan(flow.indexOf("currentOfflineStatus()"));
    expect(write).toBeLessThan(flow.indexOf("setOfflineScope(null);"));
    expect(write).toBeLessThan(flow.indexOf('window.location.assign("/login?disabled=1")'));
    expect(write).toBeGreaterThan(flow.indexOf('if (reason === "signed-out")'));
  });

  it("the sign-in page reads only a 'disabled' notice on /login?disabled=1, once, and adds the kept message", () => {
    const source = read("app/login/login-form.tsx");
    const effect = source.slice(source.indexOf("if (!disabled) return;"), source.indexOf("}, [disabled]);"));
    expect(effect).toContain('notice?.reason !== "disabled"');
    expect(effect).toContain("window.localStorage.removeItem(LOCK_NOTICE_KEY)");
    expect(effect).toContain("accessEndedKeptMessage(kept)");
  });
});

describe("a second person on the same device after the first is revoked", () => {
  it("cannot see the first person's count or items, and cannot replay them; the first person's work stays", async () => {
    setOfflineBackend(memoryBackend());
    setOfflineScope(alice);
    await enqueue(alice, start("A-1"));
    await enqueue(alice, start("A-2"));
    await refreshCounts();
    expect(currentOfflineStatus().pending).toBe(2);
    suspendOfflineAccess(alice.userId);

    setOfflineScope(bob);
    await refreshCounts();
    const shown = currentOfflineStatus();
    expect(shown.pending + shown.conflicts.length + shown.rejected.length).toBe(0);
    expect(shown.pendingItems).toHaveLength(0);
    expect(await pendingEntries(bob)).toHaveLength(0);

    const sent: string[] = [];
    await replayOutbox(bob, async (op) => { sent.push(op.kind === "start" ? op.jobNo : op.kind); return { status: "applied" }; });
    expect(sent).toEqual([]);

    // The first person's queue is untouched and still locked for them.
    expect(await pendingEntries(alice)).toHaveLength(2);
    expect((await pendingEntries(alice)).map((e) => e.op.kind === "start" && e.op.jobNo)).toEqual(["A-1", "A-2"]);
  });
});
