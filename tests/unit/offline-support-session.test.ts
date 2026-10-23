import { afterEach, beforeEach, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { syncNow } from "@/lib/offline/sync";
import { OFFLINE_ACCESS_EVENT, confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { enqueue, pendingEntries, type RunPauseOp } from "@/lib/offline/outbox";
import { offlineScope, setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";

const scope = { userId: "support-owner", orgId: "support-company" };
const op: RunPauseOp = { kind: "run_pause", v: 2, jobRef: "job", jobNo: "J-1", at: "2026-10-15T10:00:00Z", clientOpId: "support-key", machines: null, afterStart: null };
let session: Record<string, unknown>;
let events: string[];

beforeEach(async () => {
  vi.clearAllMocks(); events = [];
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  });
  vi.stubGlobal("document", { cookie: "" });
  confirmOfflineAccess(scope.userId); setSupportSession(false);
  setOfflineBackend(memoryBackend(new Map())); setOfflineScope(scope);
  session = { user_id: scope.userId, organization_id: scope.orgId, role: "admin", support: true };
  client.auth.getUser.mockResolvedValue({ data: { user: { id: scope.userId } }, error: null });
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : { time_conflicts: [] }, error: null }));
  await enqueue(scope, op);
});
afterEach(() => { confirmOfflineAccess(scope.userId); setOfflineScope(null); setOfflineBackend(null); vi.unstubAllGlobals(); });

it("a support session for the same user and company is not a revocation", async () => {
  expect(await syncNow()).toBeNull();
  expect(offlineAccessBlocked(scope.userId)).toBe(false);
  expect(events).not.toContain(OFFLINE_ACCESS_EVENT);
  expect(offlineScope()).toEqual(scope);
  expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
  expect(await pendingEntries(scope)).toHaveLength(1);
});

it.each([
  ["a different company", { organization_id: "elsewhere" }],
  ["a different user", { user_id: "someone-else" }],
  ["no role", { role: null }],
])("a support session for %s still suspends offline access", async (_label, change) => {
  Object.assign(session, change);
  expect(await syncNow()).toBeNull();
  expect(offlineAccessBlocked(scope.userId)).toBe(true);
  expect(events).toContain(OFFLINE_ACCESS_EVENT);
  expect(offlineScope()).toBeNull();
  expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
});

// offlineCopyAllowed is !support, so a normal user's only revocation signal is a user, company or role mismatch.
it.each([
  ["a different company", { organization_id: "elsewhere" }],
  ["a different user", { user_id: "someone-else" }],
  ["no role", { role: null }],
])("a revoked normal user (%s) is suspended and nothing replays", async (_label, change) => {
  Object.assign(session, { support: false }, change);
  expect(await syncNow()).toBeNull();
  expect(offlineAccessBlocked(scope.userId)).toBe(true);
  expect(events).toContain(OFFLINE_ACCESS_EVENT);
  expect(offlineScope()).toBeNull();
  expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
  expect(await pendingEntries(scope)).toHaveLength(1);
});

it("a normal user still in the same company and role is not suspended", async () => {
  session.support = false;
  await syncNow();
  expect(offlineAccessBlocked(scope.userId)).toBe(false);
  expect(events).not.toContain(OFFLINE_ACCESS_EVENT);
  expect(offlineScope()).toEqual(scope);
  expect(client.rpc.mock.calls.map(([name]) => name)).toContain("pause_machine_run");
});
