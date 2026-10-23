import { afterEach, beforeEach, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { onSyncComplete, syncNow } from "@/lib/offline/sync";
import { ACCESS_RECHECK_KEY, OFFLINE_ACCESS_PREFIX, confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { enqueue, pendingEntries, rejectedEntries, replayOutbox, type OutboxEntry, type RunPauseOp } from "@/lib/offline/outbox";
import { offlineScope, setOfflineScope, suspendOfflineAccess } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";
const scope = { userId: "authority-user", orgId: "authority-company" };
const op: RunPauseOp = { kind: "run_pause", v: 2, jobRef: "job", jobNo: "J-1", at: "2026-10-15T10:00:00Z", clientOpId: "stable-client-key", machines: null, afterStart: null };
let session: Record<string, unknown>;
let queued: OutboxEntry;
let records: Map<string, unknown>;
beforeEach(async () => {
  vi.clearAllMocks(); confirmOfflineAccess(scope.userId); setSupportSession(false);
  records = new Map(); setOfflineBackend(memoryBackend(records)); setOfflineScope(scope);
  session = { user_id: scope.userId, organization_id: scope.orgId, role: "operator" };
  client.auth.getUser.mockResolvedValue({ data: { user: { id: scope.userId } }, error: null });
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : { time_conflicts: [] }, error: null }));
  queued = await enqueue(scope, op);
});
afterEach(() => { confirmOfflineAccess(scope.userId); setOfflineScope(null); setOfflineBackend(null); });
it.each(["user", "company", "support"])("does not replay under a different %s authority", async (kind) => {
  if (kind === "user") session.user_id = "someone-else";
  if (kind === "company") session.organization_id = "elsewhere";
  if (kind === "support") session.support = true;
  await syncNow();
  expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
  expect(await pendingEntries(scope)).toHaveLength(1);
});
it("does not requeue held-only work before confirming authority", async () => {
  await replayOutbox(scope, async () => ({ status: "rejected", reason: "old build", code: "refused" }));
  session.organization_id = "elsewhere";
  await syncNow();
  expect(await pendingEntries(scope)).toHaveLength(0);
  expect(await rejectedEntries(scope)).toHaveLength(1);
});
it("keeps an in-flight operation and retries with the same idempotency key after authority returns", async () => {
  client.rpc.mockImplementation(async (name: string) => {
    if (name !== "my_session") suspendOfflineAccess(scope.userId);
    return { data: name === "my_session" ? session : { time_conflicts: [] }, error: null };
  });
  await syncNow();
  expect((await pendingEntries(scope))[0].op).toEqual(op);
  // B23 e2e (access-recheck "two tabs lock"): the kept record is byte-for-byte what was queued, with no in-flight mark left on it.
  expect(await pendingEntries(scope)).toEqual([queued]);
  expect([...records.values()].flat().some((value) => typeof value === "object" && value !== null && "inFlight" in value)).toBe(false);
  confirmOfflineAccess(scope.userId); setOfflineScope(scope);
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : { time_conflicts: [] }, error: null }));
  await syncNow();
  expect(await pendingEntries(scope)).toHaveLength(0);
  const calls = client.rpc.mock.calls.filter(([name]) => name === "pause_machine_run");
  expect(calls).toHaveLength(2);
  expect(calls.map(([, args]) => args.p_client_op_id)).toEqual([op.clientOpId, op.clientOpId]);
});
it("a network failure releases the claim without leaving an in-flight mark on the kept record", async () => {
  await replayOutbox(scope, async () => ({ status: "network" }));
  expect(await pendingEntries(scope)).toEqual([queued]);
  expect(Object.keys((await pendingEntries(scope))[0])).not.toContain("inFlight");
});
it("removed from the company (no role): nothing is sent, access locks, and the queued change is kept as it was", async () => {
  // B23 e2e (session-ended "removed from the company while offline"): kept + locked + nothing sent, not wiped.
  session.role = null;
  await syncNow();
  expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
  expect(offlineAccessBlocked(scope.userId)).toBe(true);
  expect(await pendingEntries(scope)).toEqual([queued]);
  // Locked: a later pass does not even ask the server, so it cannot send the kept change.
  client.auth.getUser.mockClear(); client.rpc.mockClear();
  await syncNow();
  expect(client.auth.getUser).not.toHaveBeenCalled();
  expect(client.rpc).not.toHaveBeenCalled();
  expect(await pendingEntries(scope)).toEqual([queued]);
});
it("a session found gone runs the access recheck at once and sends nothing; the queue stays (B23)", async () => {
  const recheck = vi.fn();
  const stop = onSyncComplete(recheck);
  try {
    client.auth.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } });
    await syncNow();
    expect(recheck).toHaveBeenCalledOnce();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(await pendingEntries(scope)).toEqual([queued]);
    // Unreachable is not an answer: no recheck from here (the offline clock decides).
    recheck.mockClear();
    client.auth.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } });
    await syncNow();
    expect(recheck).not.toHaveBeenCalled();
  } finally { stop(); }
});
it("a 403 on a replayed change while the session is valid (getUser OK, my_session confirms) holds that change only: no lock, no marks, one normal recheck", async () => {
  const storage = new Map<string, string>();
  const cookies: string[] = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
    dispatchEvent: () => true,
  };
  (globalThis as { document?: unknown }).document = { get cookie() { return cookies.join("; "); }, set cookie(text: string) { cookies.push(text.split(";")[0]); } };
  const recheck = vi.fn();
  const stop = onSyncComplete(recheck);
  try {
    client.rpc.mockImplementation(async (name: string) => name === "my_session"
      ? { data: session, error: null }
      : { data: null, error: { code: "42501", message: "permission denied for function pause_machine_run", details: null, hint: null } });
    await syncNow();
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session", "pause_machine_run"]);
    expect(offlineAccessBlocked(scope.userId)).toBe(false);
    expect(offlineScope()).toEqual(scope);
    expect(storage.get(OFFLINE_ACCESS_PREFIX + scope.userId)).toBeUndefined();
    expect(storage.has(ACCESS_RECHECK_KEY)).toBe(false);
    expect(cookies.some((c) => c.startsWith("tolra_offline_blocked_"))).toBe(false);
    expect(recheck).toHaveBeenCalledOnce(); // the usual recheck after a pass, not a storm
    // Kept on the device: refused changes are held for the person to see, never dropped.
    const held = await rejectedEntries(scope);
    expect([...(await pendingEntries(scope)), ...held].map((entry) => entry.id)).toEqual([queued.id]);
  } finally {
    stop();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  }
});
