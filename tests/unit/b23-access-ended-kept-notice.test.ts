/** B23 (b): when access ends with unsent offline work, the sign-in page tells the person how many changes were kept, not sent. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmOfflineAccess } from "@/lib/offline/access";
import { enqueue, pendingEntries, replayOutbox, type OutboxOp } from "@/lib/offline/outbox";
import { currentOfflineStatus, refreshCounts, setOfflineScope, suspendOfflineAccess } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { accessEndedKeptMessage } from "@/lib/session-policy";

const alice = { userId: "kept-notice-user", orgId: "kept-notice-co" };
const start = (jobNo: string): OutboxOp => ({ kind: "start", jobId: `id-${jobNo}`, jobNo, at: "2026-10-09T08:00:00Z" });
const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");

afterEach(() => { setOfflineScope(null); setOfflineBackend(null); confirmOfflineAccess(alice.userId); });

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
