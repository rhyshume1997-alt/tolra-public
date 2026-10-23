/**
 * PR #108 e2e (two-level-access.spec.ts:75): switching company from the sidebar sometimes went to /login?disabled=1, not
 * /dashboard. switch_organization changes the SESSION's company; a sync pass (lib/offline/sync.ts) or an access recheck
 * (lib/use-user.ts) whose my_session answer arrived after that request saw a company other than the page's and locked the person
 * out ("moved" / suspendOfflineAccess), also marking the device copy blocked. While this page is switching on purpose, those
 * passes give no answer; a failed switch, or a genuine removal outside one, still locks.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { syncNow } from "@/lib/offline/sync";
import { OFFLINE_ACCESS_EVENT, confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { enqueue, pendingEntries, type OutboxEntry, type RunPauseOp } from "@/lib/offline/outbox";
import { offlineScope, setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";
import { ORGANIZATION_SWITCH_HOLD_MS, beginOrganizationSwitch, endOrganizationSwitch, organizationSwitchInProgress } from "@/lib/access-recheck";

const scope = { userId: "switching-user", orgId: "alpha-company" };
const op: RunPauseOp = { kind: "run_pause", v: 2, jobRef: "job", jobNo: "J-1", at: "2026-10-15T10:00:00Z", clientOpId: "switch-key", machines: null, afterStart: null };
let session: Record<string, unknown>;
let queued: OutboxEntry;
let events: string[];

beforeEach(async () => {
  vi.clearAllMocks(); endOrganizationSwitch(); confirmOfflineAccess(scope.userId); setSupportSession(false);
  setOfflineBackend(memoryBackend(new Map())); setOfflineScope(scope);
  session = { user_id: scope.userId, organization_id: scope.orgId, role: "admin" };
  client.auth.getUser.mockResolvedValue({ data: { user: { id: scope.userId } }, error: null });
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : { time_conflicts: [] }, error: null }));
  queued = await enqueue(scope, op);
  events = [];
  const storage = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  };
});
afterEach(() => {
  endOrganizationSwitch(); confirmOfflineAccess(scope.userId); setOfflineScope(null); setOfflineBackend(null);
  delete (globalThis as { window?: unknown }).window;
});

/** my_session is asked before the switch and answered after it: the server already names the new company. */
function switchWhileMySessionIsInFlight() {
  client.rpc.mockImplementation(async (name: string) => {
    if (name !== "my_session") return { data: { time_conflicts: [] }, error: null };
    beginOrganizationSwitch();
    session = { ...session, organization_id: "beta-company" };
    return { data: session, error: null };
  });
}

describe("a sync pass during this page's own company switch", () => {
  it("does not lock the person or mark the device copy blocked when its answer names the new company", async () => {
    switchWhileMySessionIsInFlight();
    expect(await syncNow()).toBeNull();
    expect(offlineAccessBlocked(scope.userId)).toBe(false);
    expect(events).not.toContain(OFFLINE_ACCESS_EVENT); // use-user's onAccessEnded -> endAccess -> /login?disabled=1
    expect(offlineScope()).toEqual(scope); // switchOrganization wipes and clears it itself
    // Nothing of the old company is sent under the new company's session; the entry is kept as it was.
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session"]);
    expect(await pendingEntries(scope)).toEqual([queued]);
  });

  it("sends nothing and asks nothing once the switch has begun", async () => {
    beginOrganizationSwitch();
    expect(await syncNow()).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(await pendingEntries(scope)).toEqual([queued]);
    expect(offlineAccessBlocked(scope.userId)).toBe(false);
  });

  it("the pre-switch sync (before the flag) still sends the old company's queue", async () => {
    await syncNow();
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["my_session", "pause_machine_run"]);
    expect(await pendingEntries(scope)).toHaveLength(0);
  });

  it("a failed switch ends the hold: a company mismatch then locks as before (a genuine move or removal is still locked)", async () => {
    beginOrganizationSwitch();
    endOrganizationSwitch();
    session.organization_id = "beta-company";
    await syncNow();
    expect(offlineAccessBlocked(scope.userId)).toBe(true);
    expect(events).toContain(OFFLINE_ACCESS_EVENT);
    expect(await pendingEntries(scope)).toEqual([queued]);
  });

  it("without a switch in progress a mismatch still locks (no change for a person moved by someone else)", async () => {
    session.role = null;
    await syncNow();
    expect(offlineAccessBlocked(scope.userId)).toBe(true);
  });
});

describe("organizationSwitchInProgress cannot stick", () => {
  it("is set by begin and cleared by end", () => {
    expect(organizationSwitchInProgress()).toBe(false);
    beginOrganizationSwitch(1_000);
    expect(organizationSwitchInProgress(1_000)).toBe(true);
    expect(organizationSwitchInProgress(1_000 + ORGANIZATION_SWITCH_HOLD_MS - 1)).toBe(true);
    endOrganizationSwitch();
    expect(organizationSwitchInProgress(1_001)).toBe(false);
  });

  it("expires after the hold (a reload that never happened) and when the clock moves back", () => {
    beginOrganizationSwitch(1_000);
    expect(organizationSwitchInProgress(1_000 + ORGANIZATION_SWITCH_HOLD_MS)).toBe(false);
    expect(organizationSwitchInProgress(999)).toBe(false);
    expect(ORGANIZATION_SWITCH_HOLD_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("lib/use-user.ts holds its access checks during its own switch", () => {
  const source = readFileSync(path.resolve(__dirname, "../../lib/use-user.ts"), "utf8");
  const switchBody = source.slice(source.indexOf("const switchOrganization = useCallback"), source.indexOf("useEffect(() => {"));

  it("begins the hold after the pre-switch sync and before switch_organization; a failure ends it", () => {
    const confirm = switchBody.indexOf('confirmUnsyncedDiscard("Switching company", syncNow)');
    const begin = switchBody.indexOf("beginOrganizationSwitch(Date.now(), leaving?.orgId ?? null);");
    // Other tabs share the session: the switch is announced, then waits until no replay of the old company is in flight.
    const idle = switchBody.indexOf("await waitForReplayIdle(leaving)");
    const rpc = switchBody.indexOf('supabase.rpc("switch_organization"');
    expect(confirm).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(confirm);
    expect(idle).toBeGreaterThan(begin);
    expect(rpc).toBeGreaterThan(idle);
    expect(switchBody).toMatch(/catch \(err\) \{\s*\n\s*endOrganizationSwitch\(\);\s*\n\s*throw err;/);
    // The old company's copy is still wiped and the scope cleared before the reload: nothing of it is reused.
    expect(switchBody).toMatch(/await wipeOfflineScope\(offlineScope\(\), confirmed\);\s*\n\s*setOfflineScope\(null\);/);
  });

  it("a recheck answered during the switch neither ends access nor applies anything", () => {
    const parse = source.indexOf("const now = parseSessionInfo(sessionResult.data);");
    const hold = source.indexOf("if (organizationSwitchInProgress()) return;", parse);
    const decide = source.indexOf("decideAccess(live,", parse);
    expect(parse).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(parse);
    expect(decide).toBeGreaterThan(hold);
  });
});
