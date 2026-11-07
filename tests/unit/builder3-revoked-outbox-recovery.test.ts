/** PM: real sync/outbox modules, deterministic server responses; this is unit evidence, not browser/DB proof. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { invalidateConfirmedUser } from "@/lib/confirmed-user";
import { confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { enqueue, pendingEntries, type OutboxEntry, type RunPauseOp } from "@/lib/offline/outbox";
import { setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";
import { syncNow } from "@/lib/offline/sync";
const scope = { userId: "fake-pm-worker", orgId: "fake-pm-company" };
let records: Map<string, unknown>, queued: OutboxEntry, session: Record<string, unknown>;
let op: RunPauseOp;
beforeEach(async () => {
  vi.resetAllMocks(); invalidateConfirmedUser(); confirmOfflineAccess(scope.userId); setSupportSession(false);
  records = new Map(); setOfflineBackend(memoryBackend(records)); setOfflineScope(scope);
  op = { kind: "run_pause", v: 2, jobRef: "FAKE-JOB", jobNo: "FAKE-J-01", at: new Date().toISOString(), clientOpId: "fake-stable-key", machines: null, afterStart: null };
  queued = await enqueue(scope, op);
  session = { user_id: scope.userId, organization_id: scope.orgId, role: "operator" };
  client.auth.getUser.mockResolvedValue({ data: { user: { id: scope.userId } }, error: null });
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : { time_conflicts: [] }, error: null }));
});
afterEach(() => { confirmOfflineAccess(scope.userId); setOfflineScope(null); setOfflineBackend(null); });
it("a lost acknowledgement, revoked access and explicit recovery retain the same key and apply once", async () => {
  const applied = new Set<string>(); let calls = 0;
  client.rpc.mockImplementation(async (name: string, args?: { p_client_op_id: string }) => {
    if (name === "my_session") return { data: session, error: null };
    applied.add(args!.p_client_op_id); calls += 1;
    if (calls === 1) return { data: null, error: { message: "TypeError: Failed to fetch", details: "TypeError: Failed to fetch", code: "", hint: "" } };
    return { data: { time_conflicts: [] }, error: null };
  });
  await syncNow(); expect(await pendingEntries(scope)).toEqual([queued]); expect(applied.size).toBe(1);
  session = { ...session, role: null }; invalidateConfirmedUser();
  await syncNow({ background: true });
  expect(offlineAccessBlocked(scope.userId)).toBe(true); expect(calls).toBe(1); expect(await pendingEntries(scope)).toEqual([queued]);
  await syncNow(); expect(calls).toBe(1);
  session = { ...session, role: "operator" }; confirmOfflineAccess(scope.userId); setOfflineScope(scope); invalidateConfirmedUser();
  await syncNow();
  expect(await pendingEntries(scope)).toEqual([]); expect(calls).toBe(2); expect([...applied]).toEqual([op.clientOpId]);
});
it("an abandoned in-flight entry survives a reopened store, cannot replay while revoked, then recovers", async () => {
  for (const [key, value] of records) if (Array.isArray(value) && value.some(v => v.id === queued.id)) records.set(key, [{ ...queued, inFlight: true }]);
  setOfflineBackend(memoryBackend(records)); session = { ...session, role: null };
  await syncNow();
  expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
  expect(await pendingEntries(scope)).toEqual([{ ...queued, inFlight: true }]);
  confirmOfflineAccess(scope.userId); setOfflineScope(scope); invalidateConfirmedUser(); session = { ...session, role: "operator" };
  await syncNow();
  expect(await pendingEntries(scope)).toEqual([]);
  expect(client.rpc.mock.calls.filter(([name]) => name === "pause_machine_run").map(([, args]) => args.p_client_op_id)).toEqual([op.clientOpId]);
});
it("recovery under another company sends nothing and preserves the original company's operation", async () => {
  session = { ...session, organization_id: "fake-other-company" };
  await syncNow();
  expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
  expect(await pendingEntries(scope)).toEqual([queued]);
  expect(await pendingEntries({ ...scope, orgId: "fake-other-company" })).toEqual([]);
});
