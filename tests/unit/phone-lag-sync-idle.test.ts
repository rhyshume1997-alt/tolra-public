/**
 * Phone lag (fix 2a, 2c): the shell's minute sync loop asks the server nothing while this scope's queue is empty, and an unchanged
 * queue publishes no new status. Revocation keeps its paths: a queued or held change still makes the full pass (getUser and
 * my_session first), explicit syncNow() calls are unchanged, and an idle pass still asks for the access recheck when nothing has
 * confirmed the person for ACCESS_RECHECK_EVERY_MS (a page opened offline ends access at the first answer once the connection is back).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn(), getSession: vi.fn() }, rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { ACCESS_RECHECK_EVERY_MS, SYNC_RECHECK_SKIP_MS, syncPassNeedsRecheck } from "@/lib/access-recheck";
import { invalidateConfirmedUser } from "@/lib/confirmed-user";
import { confirmOfflineAccess } from "@/lib/offline/access";
import { enqueue, pendingEntries, replayOutbox, type RunPauseOp } from "@/lib/offline/outbox";
import { currentOfflineStatus, refreshCounts, setOfflineScope, useOfflineStatus } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";
import { onSyncComplete, syncNow, type SyncPassEvent } from "@/lib/offline/sync";

const scope = { userId: "idle-user", orgId: "idle-company" };
const op: RunPauseOp = { kind: "run_pause", v: 2, jobRef: "job", jobNo: "J-1", at: "2026-10-15T10:00:00Z", clientOpId: "idle-client-key", machines: null, afterStart: null };
const session = { user_id: scope.userId, organization_id: scope.orgId, role: "operator" };
const requests = () => client.auth.getUser.mock.calls.length + client.rpc.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks(); invalidateConfirmedUser(); confirmOfflineAccess(scope.userId); setSupportSession(false);
  setOfflineBackend(memoryBackend(new Map())); setOfflineScope(scope);
  client.auth.getUser.mockResolvedValue({ data: { user: { id: scope.userId } }, error: null });
  client.auth.getSession.mockResolvedValue({ data: { session: { user: { id: scope.userId } } }, error: null });
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : { time_conflicts: [] }, error: null }));
});
afterEach(() => { vi.useRealTimers(); confirmOfflineAccess(scope.userId); setOfflineScope(null); setOfflineBackend(null); });

describe("a background pass with an empty queue", () => {
  it("makes no request, returns null and tells its listeners it was idle", async () => {
    const events: SyncPassEvent[] = [];
    const stop = onSyncComplete((event) => events.push(event));
    try {
      expect(await syncNow({ background: true })).toBeNull();
      expect(requests()).toBe(0);
      expect(events).toEqual([{ sessionGone: false, quiet: true, idle: true }]);
    } finally { stop(); }
  });

  it("a queued change makes the full pass, authority first (getUser, my_session), and sends it", async () => {
    await enqueue(scope, op);
    await syncNow({ background: true });
    expect(client.auth.getUser).toHaveBeenCalledOnce();
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session", "pause_machine_run"]);
    expect(await pendingEntries(scope)).toHaveLength(0);
  });

  it("a held (refused) change also makes the full pass: the requeue and the held-time report still run", async () => {
    await enqueue(scope, op);
    await replayOutbox(scope, async () => ({ status: "rejected", reason: "refused", code: "refused" }));
    await syncNow({ background: true });
    expect(client.rpc.mock.calls.map(([name]) => name)).toContain("my_session");
  });

  it("an explicit syncNow() (Retry, sign-out, after queueing) is unchanged: it confirms the session even with an empty queue", async () => {
    const result = await syncNow();
    expect(client.auth.getUser).toHaveBeenCalledOnce();
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
    expect(result).toMatchObject({ applied: 0, remaining: 0 });
  });
});

describe("requests per 10 minutes from an open, idle shell (sync loop every minute + access recheck)", () => {
  /** One loop pass, then what the access recheck would ask (three reads: getUser, user_profiles, my_session) and when. */
  async function tenMinutes(pass: () => Promise<unknown>) {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    let fullyConfirmedAt: number | null = start; // the page load confirmed the person
    let recheckReads = 0;
    const stop = onSyncComplete((event) => {
      if (syncPassNeedsRecheck(event, fullyConfirmedAt)) { recheckReads += 3; fullyConfirmedAt = Date.now(); }
    });
    try {
      for (let minute = 1; minute <= 10; minute += 1) {
        vi.setSystemTime(start + minute * 60_000);
        // The 10-minute recheck timer (setInterval from the page load) runs whatever the loop does.
        if ((minute * 60_000) % ACCESS_RECHECK_EVERY_MS === 0) { recheckReads += 3; fullyConfirmedAt = Date.now(); }
        invalidateConfirmedUser();
        await pass();
      }
    } finally { stop(); }
    return { syncRequests: requests(), recheckReads, total: requests() + recheckReads };
  }

  it("before (every pass confirmed the session and was followed by a recheck): 50; after: 3, the 10-minute recheck only", async () => {
    const before = await tenMinutes(() => syncNow());
    vi.clearAllMocks();
    const after = await tenMinutes(() => syncNow({ background: true }));
    expect(before).toEqual({ syncRequests: 20, recheckReads: 30, total: 50 });
    expect(after).toEqual({ syncRequests: 0, recheckReads: 3, total: 3 });
  });
});

describe("syncPassNeedsRecheck for an idle pass", () => {
  const now = 1_000_000_000;
  const idle = { sessionGone: false, quiet: true, idle: true };
  it("confirmed within the 10-minute recheck: no extra recheck; older, never or opened offline: it asks", () => {
    expect(syncPassNeedsRecheck(idle, now - 5 * 60_000, now)).toBe(false);
    expect(syncPassNeedsRecheck(idle, now - ACCESS_RECHECK_EVERY_MS, now)).toBe(true);
    expect(syncPassNeedsRecheck(idle, null, now)).toBe(true);
    expect(syncPassNeedsRecheck(idle, now + 1, now)).toBe(true); // a clock moved back
  });
  it("a pass that sent something keeps the old rule (only a quiet pass straight after a confirmation skips)", () => {
    expect(syncPassNeedsRecheck({ sessionGone: false, quiet: true }, now - 5 * 60_000, now)).toBe(true);
    expect(syncPassNeedsRecheck({ sessionGone: false, quiet: true }, now - SYNC_RECHECK_SKIP_MS + 1, now)).toBe(false);
    expect(syncPassNeedsRecheck({ sessionGone: true, quiet: true, idle: true }, now, now)).toBe(true);
  });
});

describe("refreshCounts publishes only a changed queue", () => {
  it("the same queue read again gives the banner no new status; a new entry does", async () => {
    expect(typeof useOfflineStatus).toBe("function");
    await refreshCounts();
    const shown = currentOfflineStatus();
    await refreshCounts();
    expect(currentOfflineStatus()).toBe(shown);
    await enqueue(scope, op);
    await refreshCounts();
    expect(currentOfflineStatus()).not.toBe(shown);
    expect(currentOfflineStatus().pending).toBe(1);
    const queued = currentOfflineStatus();
    await refreshCounts();
    expect(currentOfflineStatus()).toBe(queued);
  });
});
