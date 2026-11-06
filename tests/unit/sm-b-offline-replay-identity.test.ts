/**
 * sm-b (2): offline outbox replay vs identity and revoked permission. Queues are keyed by user AND company, so another person on the
 * same device cannot see or replay them, a different signed-in user sends nothing, and an entry carries no role or identity of its
 * own (the server decides from the live session). Also pins what code-less held entries do (requeueHeldRunOps) and one reproduced
 * gap: a run_start whose execution THROWS (non-network) is filed without a code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn(), getSession: vi.fn() }, rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { executeOutboxOp, syncNow } from "@/lib/offline/sync";
import { confirmOfflineAccess } from "@/lib/offline/access";
import { conflictEntries, enqueue, pendingEntries, rejectedEntries, replayOutbox, requeueHeldRunOps, type OutboxOp, type RunPauseOp, type RunStartOp } from "@/lib/offline/outbox";
import { setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";

const alice = { userId: "alice", orgId: "co" };
const bob = { userId: "bob", orgId: "co" };
const pause: RunPauseOp = { kind: "run_pause", v: 2, jobRef: "job", jobNo: "J-1", at: "2026-10-15T10:00:00Z", clientOpId: "k1", machines: null, afterStart: null };
const start: RunStartOp = { kind: "run_start", v: 2, jobRef: "job", jobNo: "J-1", at: "2026-10-15T09:00:00Z", clientOpId: "k0", machines: ["m1"], bench: false, pausedAck: [] } as RunStartOp;
let session: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks(); setSupportSession(false);
  setOfflineBackend(memoryBackend());
  confirmOfflineAccess("alice"); confirmOfflineAccess("bob");
  session = { user_id: "alice", organization_id: "co", role: "operator" };
  client.auth.getUser.mockResolvedValue({ data: { user: { id: "alice" } }, error: null });
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : { time_conflicts: [] }, error: null }));
});
afterEach(() => { setOfflineScope(null); setOfflineBackend(null); });

describe("sm-b: a different person on the same device", () => {
  it("never sees or replays the first person's queue", async () => {
    await enqueue(alice, pause);
    expect(await pendingEntries(bob)).toHaveLength(0);
    const sent = vi.fn(async () => ({ status: "applied" as const }));
    await replayOutbox(bob, sent);
    expect(sent).not.toHaveBeenCalled();
    expect(await pendingEntries(alice)).toHaveLength(1);
  });

  it("bob signed in while the page still holds alice's scope: getUser says bob, nothing is sent, alice's entry stays", async () => {
    setOfflineScope(alice);
    await enqueue(alice, pause);
    client.auth.getUser.mockResolvedValue({ data: { user: { id: "bob" } }, error: null });
    await syncNow();
    expect(client.rpc.mock.calls.filter(([n]) => n !== "my_session")).toEqual([]);
    expect(await pendingEntries(alice)).toHaveLength(1);
  });

  it("a queued entry carries no user, role or company of its own: the server decides from the live session", async () => {
    const entry = await enqueue(alice, pause);
    expect(Object.keys(entry).sort()).toEqual(["id", "op", "queuedAt"]);
    expect(JSON.stringify(entry.op)).not.toMatch(/role|userId|user_id|org/i);
  });
});

describe("sm-b: permission revoked or changed after queuing", () => {
  it("role removed (my_session role null): nothing is sent and the entry is kept", async () => {
    setOfflineScope(alice);
    await enqueue(alice, pause);
    session.role = null;
    await syncNow();
    expect(client.rpc.mock.calls.filter(([n]) => n !== "my_session")).toEqual([]);
    expect(await pendingEntries(alice)).toHaveLength(1);
  });

  it("role changed to another role that still exists: the replay goes out under the CURRENT session (server decides); a server refusal is held with a code, not applied", async () => {
    setOfflineScope(alice);
    await enqueue(alice, pause);
    session.role = "viewer";
    client.rpc.mockImplementation(async (name: string) => name === "my_session" ? { data: session, error: null } : { data: null, error: { message: "not allowed", code: "42501" } });
    await syncNow();
    expect(await pendingEntries(alice)).toHaveLength(0);
    const held = await rejectedEntries(alice);
    expect(held).toHaveLength(1);
    expect(held[0].code).toBe("refused");
  });
});

describe("sm-b: held entries without a code (outbox.ts requeueHeldRunOps)", () => {
  const worksheet = { kind: "worksheet", jobId: "job", baseVersion: 1, worksheet: {} } as unknown as OutboxOp;
  const seed = async () => {
    const reject = async () => ({ status: "rejected" as const, reason: "old build" });
    await enqueue(alice, start, new Date("2026-10-15T09:00:00Z"));
    await enqueue(alice, worksheet, new Date("2026-10-15T09:01:00Z"));
    await replayOutbox(alice, reject);
  };

  it("a code-less held run op goes back to the queue; a worksheet and a coded entry stay held", async () => {
    await seed();
    await enqueue(alice, pause, new Date("2026-10-15T09:02:00Z"));
    await replayOutbox(alice, async () => ({ status: "conflict", reason: "x", code: "machine_in_use", opened: false }));
    expect(await requeueHeldRunOps(alice, "b")).toBe(1);
    expect((await pendingEntries(alice)).map((e) => e.op.kind)).toEqual(["run_start"]);
    expect((await rejectedEntries(alice)).map((e) => e.op.kind)).toEqual(["worksheet"]);
    expect((await conflictEntries(alice)).map((e) => e.op.kind)).toEqual(["run_pause"]);
  });

  it("a code-less run op is requeued once per call, and on every load if it is refused code-less again", async () => {
    await enqueue(alice, start);
    const codeless = async () => ({ status: "rejected" as const, reason: "boom" });
    await replayOutbox(alice, codeless);
    expect(await requeueHeldRunOps(alice, "b")).toBe(1);
    await replayOutbox(alice, codeless);
    expect(await requeueHeldRunOps(alice, "b")).toBe(1); // the loop: nothing ever gives it a code
    expect(await requeueHeldRunOps(alice, "b")).toBe(0); // idle between loads
  });

  it("REPRODUCED GAP: a run_start whose execution throws (non-network) is filed rejected WITHOUT a code (sync.ts run_start catch uses refusal, run_pause uses runOpRefusal)", async () => {
    client.rpc.mockImplementation(async () => { throw new Error("boom"); });
    const outcome = await executeOutboxOp(start, "co");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { code?: string }).code).toBeUndefined();
    const pauseOutcome = await executeOutboxOp(pause, "co");
    expect((pauseOutcome as { code?: string }).code).toBe("refused");
  });
});
