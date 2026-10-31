/**
 * Review condition (phone lag, fix 2): with changes queued on the device, every pass that could send them, the shell's background
 * minute loop and the pass that runs when the connection comes back included, asks the auth server (getUser) and the database
 * (my_session) BEFORE it replays anything. When either says the person no longer has access, nothing is replayed and the queued
 * change stays on the device exactly as it was queued (locked where the code locks). The real lib/offline/sync.ts and outbox run
 * against the in-memory offline store and a stubbed Supabase client, as in offline-sync-authority.test.ts.
 */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn(), getSession: vi.fn() }, rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { invalidateConfirmedUser } from "@/lib/confirmed-user";
import { confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { enqueue, pendingEntries, type OutboxEntry, type RunPauseOp } from "@/lib/offline/outbox";
import { setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";
import { onSyncComplete, syncNow, useOfflineSync, type SyncPassEvent } from "@/lib/offline/sync";

const scope = { userId: "revoked-user", orgId: "revoked-company" };
const op: RunPauseOp = { kind: "run_pause", v: 2, jobRef: "job", jobNo: "J-7", at: "2026-10-15T10:00:00Z", clientOpId: "revoked-client-key", machines: null, afterStart: null };
let session: Record<string, unknown> | null;
let queued: OutboxEntry;

/** The replay calls (anything but the my_session confirmation). */
const replays = () => client.rpc.mock.calls.filter(([name]) => name !== "my_session");
const answerAsServer = () => {
  client.auth.getUser.mockResolvedValue({ data: { user: { id: scope.userId } }, error: null });
  client.auth.getSession.mockResolvedValue({ data: { session: { user: { id: scope.userId } } }, error: null });
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : { time_conflicts: [] }, error: null }));
};

beforeEach(async () => {
  vi.clearAllMocks(); invalidateConfirmedUser(); confirmOfflineAccess(scope.userId); setSupportSession(false);
  setOfflineBackend(memoryBackend(new Map())); setOfflineScope(scope);
  session = { user_id: scope.userId, organization_id: scope.orgId, role: "operator" };
  answerAsServer();
  queued = await enqueue(scope, op);
});
afterEach(() => { vi.unstubAllGlobals(); confirmOfflineAccess(scope.userId); setOfflineScope(null); setOfflineBackend(null); });

describe.each([
  ["a background pass (the minute loop, focus, reconnect)", { background: true }],
  ["an explicit pass (Retry, after queueing)", {}],
])("%s with a change queued", (_label, options) => {
  it("asks getUser, then my_session, before the first replayed call; then sends the change", async () => {
    await syncNow(options);
    const getUserAt = client.auth.getUser.mock.invocationCallOrder[0];
    const order = client.rpc.mock.calls.map(([name], i) => ({ name, at: client.rpc.mock.invocationCallOrder[i] }));
    expect(order.map((c) => c.name)).toEqual(["my_session", "pause_machine_run"]);
    expect(getUserAt).toBeLessThan(order[0].at);
    expect(order[0].at).toBeLessThan(order[1].at);
    expect(await pendingEntries(scope)).toHaveLength(0);
  });

  it.each([
    ["the auth server says the session is gone (AuthSessionMissingError)", "session-gone"],
    ["the auth server answers for a different user", "other-user"],
    ["my_session says the session has ended (28000)", "session-ended"],
    ["my_session: removed from the company (no role)", "no-role"],
    ["my_session: the session now names another company", "other-company"],
  ])("revoked, %s: nothing is replayed and the queued change stays as queued", async (_case, kind) => {
    const events: SyncPassEvent[] = [];
    const stop = onSyncComplete((event) => events.push(event));
    try {
      if (kind === "session-gone") client.auth.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } });
      if (kind === "other-user") client.auth.getUser.mockResolvedValue({ data: { user: { id: "someone-else" } }, error: null });
      if (kind === "session-ended") client.rpc.mockImplementation(async () => ({ data: null, error: { code: "28000", message: "Your session has ended. Sign in again." } }));
      if (kind === "no-role") session = { ...session, role: null };
      if (kind === "other-company") session = { ...session, organization_id: "elsewhere" };

      expect(await syncNow(options)).toBeNull();

      expect(client.auth.getUser).toHaveBeenCalledOnce();
      expect(replays()).toEqual([]);
      expect(await pendingEntries(scope)).toEqual([queued]);
      // Where the session is answered as gone, the access recheck runs at once; a role or company mismatch locks the device copy.
      if (kind === "session-gone" || kind === "session-ended") expect(events).toEqual([{ sessionGone: true, quiet: true }]);
      expect(offlineAccessBlocked(scope.userId)).toBe(kind === "no-role" || kind === "other-company");
    } finally { stop(); }
  });
});

describe("a locked device (removed from the company) does not replay on later passes", () => {
  it("the next background pass asks nothing and sends nothing; the change is still kept", async () => {
    session = { ...session, role: null };
    await syncNow({ background: true });
    expect(offlineAccessBlocked(scope.userId)).toBe(true);
    vi.clearAllMocks(); invalidateConfirmedUser(); answerAsServer();
    await syncNow({ background: true });
    expect(client.auth.getUser).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(await pendingEntries(scope)).toEqual([queued]);
  });
});

describe("the connection coming back (useOfflineSync's 'online' listener, the real hook mounted)", () => {
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

  async function mountSyncLoop() {
    const store = new Map<string, string>();
    const win = Object.assign(new EventTarget(), {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage,
      // The minute timer is not under test here: it never fires.
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    });
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible", cookie: "" });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    // A real React reconciler (exported by react-pdf's build, not by its type definitions), as phone-lag-recheck-renders.test.ts.
    type Reconciler = { createContainer: (root: object) => unknown; updateContainer: (element: unknown, root: unknown, parent: null, done: () => void) => void };
    const { createRenderer } = (await import("@react-pdf/renderer")) as unknown as { createRenderer: (options: object) => Reconciler };
    function Loop() { useOfflineSync(); return null; }
    const renderer = createRenderer({});
    const root = renderer.createContainer({ type: "ROOT", document: null });
    renderer.updateContainer(createElement(Loop), root, null, () => undefined);
    await settle();
    return { win, unmount: async () => { renderer.updateContainer(null, root, null, () => undefined); await settle(); } };
  }

  it("revoked while offline: reconnecting confirms first and replays nothing; once access is back, reconnecting confirms, then replays", async () => {
    // Offline: the mount's first pass cannot reach the server, so nothing is sent.
    client.auth.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } });
    const { win, unmount } = await mountSyncLoop();
    try {
      expect(replays()).toEqual([]);
      expect(await pendingEntries(scope)).toEqual([queued]);

      // Back online, but the person was removed from the company meanwhile.
      vi.clearAllMocks(); invalidateConfirmedUser();
      session = { ...session, role: null };
      answerAsServer();
      win.dispatchEvent(new Event("online"));
      await settle();
      expect(client.auth.getUser).toHaveBeenCalledOnce();
      expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
      expect(replays()).toEqual([]);
      expect(await pendingEntries(scope)).toEqual([queued]);
      expect(offlineAccessBlocked(scope.userId)).toBe(true);

      // Access restored (signed in again): the next reconnect confirms, then sends the same change with the same key.
      confirmOfflineAccess(scope.userId); setOfflineScope(scope);
      vi.clearAllMocks(); invalidateConfirmedUser();
      session = { user_id: scope.userId, organization_id: scope.orgId, role: "operator" };
      answerAsServer();
      win.dispatchEvent(new Event("online"));
      await settle();
      expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session", "pause_machine_run"]);
      expect(client.auth.getUser.mock.invocationCallOrder[0]).toBeLessThan(client.rpc.mock.invocationCallOrder[0]);
      expect(client.rpc.mock.calls[1][1]).toMatchObject({ p_client_op_id: op.clientOpId });
      expect(await pendingEntries(scope)).toHaveLength(0);
    } finally { await unmount(); }
  });
});
