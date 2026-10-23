/**
 * Audit (Grok round 1, MEDIUM): two tabs share one Supabase session, and switch_organization changes THAT session's company
 * (036 security_audit.session_company). The switch flag was module memory in the switching tab only, and the server check runs
 * once per sync pass, so another tab already replaying company A's queue kept sending it under the session now in company B.
 * Job actions are refused there (the job is not in B), but a clock action has no target row: record_attendance_event files it
 * in the session's company (050), so it landed in company B. The switching tab now announces itself in localStorage (every tab's
 * sync holds, the same as in the switching tab), and waits until no replay of the company it leaves is in flight.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { CLOCK_WRONG_COMPANY_REASON, executeClockOp, syncNow } from "@/lib/offline/sync";
import { OFFLINE_ACCESS_EVENT, confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { enqueue, pendingEntries, readAttachment, rejectedEntries, replayOutbox, waitForReplayIdle, type ClockOp, type OutboxEntry } from "@/lib/offline/outbox";
import { keptAfterSwitchMessage, queueGrewDuring, setOfflineScope, unsyncedIds, wipeOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, offlineBackend, scopeKey, setOfflineBackend, setSupportSession } from "@/lib/offline/store";
import { ORGANIZATION_SWITCH_HOLD_MS, ORGANIZATION_SWITCH_KEY, beginOrganizationSwitch, endOrganizationSwitch } from "@/lib/access-recheck";

const scope = { userId: "two-tab-user", orgId: "alpha-company" };
const clock = (action: ClockOp["action"], clientOpId: string): ClockOp => ({ kind: "clock", v: 1, action, at: "2026-10-15T07:00:00Z", clientOpId, device: "tablet", jobNo: "Daily job sheet" });
let session: Record<string, unknown>;
let storage: Map<string, string>;
let events: string[];
let first: OutboxEntry;
let second: OutboxEntry;

/** What another tab's beginOrganizationSwitch writes: this tab's module memory is not touched. */
function otherTabAnnounces(at = Date.now(), leaving: string | null = scope.orgId) {
  storage.set(ORGANIZATION_SWITCH_KEY ?? "tolra-organization-switch", JSON.stringify({ at, leaving }));
}
const sent = () => client.rpc.mock.calls.map(([name]) => name).filter((name) => name !== "my_session");

let device: Map<string, unknown>;
beforeEach(async () => {
  vi.clearAllMocks();
  storage = new Map();
  device = new Map();
  events = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  };
  endOrganizationSwitch(); confirmOfflineAccess(scope.userId); setSupportSession(false);
  setOfflineBackend(memoryBackend(device)); setOfflineScope(scope);
  session = { user_id: scope.userId, organization_id: scope.orgId, role: "workshop" };
  client.auth.getUser.mockResolvedValue({ data: { user: { id: scope.userId } }, error: null });
  client.rpc.mockImplementation(async (name: string) => ({ data: name === "my_session" ? session : null, error: null }));
  first = await enqueue(scope, clock("in", "clock-in-key"));
  second = await enqueue(scope, clock("out", "clock-out-key"));
});
afterEach(() => {
  endOrganizationSwitch(); confirmOfflineAccess(scope.userId); setOfflineScope(null); setOfflineBackend(null);
  delete (globalThis as { window?: unknown }).window;
});

describe("a company switch in ANOTHER tab", () => {
  it("(i) holds this tab's sync while it is in progress: nothing is asked or sent, nothing is locked, the queue is kept", async () => {
    otherTabAnnounces();
    expect(await syncNow()).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(await pendingEntries(scope)).toEqual([first, second]);
    expect(offlineAccessBlocked(scope.userId)).toBe(false);
    expect(events).not.toContain(OFFLINE_ACCESS_EVENT);
  });

  it("(ii) begun mid-pass: an entry queued under company A is not sent once the session is in company B; it waits, not lost", async () => {
    client.rpc.mockImplementation(async (name: string) => {
      if (name === "my_session") return { data: session, error: null };
      // The other tab switches while this tab's first clock action is being answered: the session's company is now B.
      otherTabAnnounces();
      session = { ...session, organization_id: "beta-company" };
      return { data: null, error: null };
    });
    await syncNow();
    // Before the fix the Clock out was sent too, and record_attendance_event would have filed it in company B.
    expect(sent()).toEqual(["record_attendance_event_in_company"]);
    // The Clock in answered after the announcement is kept under its key for an idempotent resend (as on an access change).
    expect(await pendingEntries(scope)).toEqual([first, second]);
    expect(await rejectedEntries(scope)).toEqual([]);
    expect(offlineAccessBlocked(scope.userId)).toBe(false);
  });

  it("a stale announcement, or one leaving another company, does not hold this company's sync", async () => {
    otherTabAnnounces(Date.now() - ORGANIZATION_SWITCH_HOLD_MS - 1);
    await syncNow();
    expect(sent()).toEqual(["record_attendance_event_in_company", "record_attendance_event_in_company"]);
    await enqueue(scope, clock("break_start", "break-key"));
    otherTabAnnounces(Date.now(), "some-other-company"); // e.g. this tab is the one that just arrived in alpha-company
    client.rpc.mockClear();
    await syncNow();
    expect(sent()).toEqual(["record_attendance_event_in_company"]);
    expect(await pendingEntries(scope)).toEqual([]);
  });

  it("a clock moved back (announcement in the future) does not hold sync for ever", async () => {
    otherTabAnnounces(Date.now() + 5 * 60_000);
    await syncNow();
    expect(sent()).toEqual(["record_attendance_event_in_company", "record_attendance_event_in_company"]);
  });
});

describe("the switching tab", () => {
  it("announces its switch to other tabs and withdraws only its own announcement when the switch fails", () => {
    beginOrganizationSwitch(1_000, scope.orgId);
    expect(JSON.parse(storage.get(ORGANIZATION_SWITCH_KEY) ?? "null")).toEqual({ at: 1_000, leaving: scope.orgId });
    endOrganizationSwitch();
    expect(storage.has(ORGANIZATION_SWITCH_KEY)).toBe(false);
    beginOrganizationSwitch(1_000, scope.orgId);
    otherTabAnnounces(2_000); // a newer switch from another tab is not this tab's to withdraw
    endOrganizationSwitch();
    expect(JSON.parse(storage.get(ORGANIZATION_SWITCH_KEY) ?? "null")).toEqual({ at: 2_000, leaving: scope.orgId });
  });

  it("waits for an entry another replay has in flight to be answered before the session's company may change", async () => {
    let answer!: () => void;
    const inFlight = new Promise<void>((resolve) => { answer = resolve; });
    const executed: string[] = [];
    // Another tab's pass (same replay lock): its first entry is on the wire.
    const pass = replayOutbox(scope, async (op) => {
      executed.push(op.kind === "clock" ? op.clientOpId : op.kind);
      if (executed.length === 1) await inFlight;
      return { status: "applied" };
    });
    await vi.waitFor(() => expect(executed).toEqual(["clock-in-key"]));
    let idle = false;
    const waiting = waitForReplayIdle(scope, 2_000, 5).then((value) => { idle = value; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(idle).toBe(false); // switch_organization is not sent while that entry is unanswered
    answer();
    await Promise.all([pass, waiting]);
    expect(idle).toBe(true);
  });

  it("refuses the switch when another tab queued work during the wait (the queue is not removed unasked)", async () => {
    // lib/use-user.ts switchOrganization throws when this is true, before switch_organization is sent and before wipeOfflineScope.
    expect(await queueGrewDuring(scope, async () => { await enqueue(scope, clock("break_start", "queued-during-wait")); })).toBe(true);
    expect((await pendingEntries(scope)).map((entry) => entry.id)).toEqual([first.id, second.id, expect.any(String)]);
    expect(await queueGrewDuring(scope, async () => undefined)).toBe(false);
    const source = readFileSync(path.resolve(__dirname, "../../lib/use-user.ts"), "utf8");
    const flow = source.slice(source.indexOf("const switchOrganization"), source.indexOf("wipeOfflineScope(offlineScope(), confirmed)"));
    expect(flow.indexOf("queueGrewDuring")).toBeGreaterThan(-1);
    expect(flow.indexOf("queueGrewDuring")).toBeLessThan(flow.indexOf('rpc("switch_organization"'));
  });

  it("work queued in another tab while switch_organization is on the wire is kept, with its photo, under the company left", async () => {
    // lib/use-user.ts switchOrganization: ids read before the person is asked, then the request, then the wipe of only those ids.
    const confirmed = await unsyncedIds(scope);
    expect([...confirmed]).toEqual([first.id, second.id]);
    let answerSwitch!: () => void;
    const rpc = new Promise<void>((resolve) => { answerSwitch = resolve; });
    const thisTab = offlineBackend()!;
    const switching = (async () => { await rpc; setOfflineBackend(thisTab); return wipeOfflineScope(scope, confirmed); })();
    // Another tab (its own backend on the same device store) queues a clock action and a photo with its bytes meanwhile.
    setOfflineBackend(memoryBackend(device));
    const lateClock = await enqueue(scope, clock("break_start", "queued-during-rpc"));
    const blobKey = `${scopeKey(scope)}|photo|p-late`;
    const photo = { kind: "photo" as const, photoId: "p-late", jobId: "job-1", jobNo: "J-1", note: null, capturedAt: null, byteSize: 3, blobKey };
    const latePhoto = await enqueue(scope, photo, new Date(), { [blobKey]: "jpeg-bytes" });
    answerSwitch();
    const kept = await switching;
    expect(kept).toBe(2);
    // The two the person agreed to remove went; the two queued during the request stayed, the photo with its bytes.
    expect((await pendingEntries(scope)).map((entry) => entry.id)).toEqual([lateClock.id, latePhoto.id]);
    expect(await readAttachment<string>(blobKey)).toBe("jpeg-bytes");
    expect(keptAfterSwitchMessage(kept!)).toBe("2 changes saved offline while switching were kept for the company you left. They send when you switch back to that company.");
    // Nothing the person was asked about at all (an empty queue at the prompt): the wipe removes no change.
    expect(await wipeOfflineScope(scope, new Set())).toBe(2);
    expect(await readAttachment<string>(blobKey)).toBe("jpeg-bytes");
    // The wipe and the kept message follow the request in the switch itself.
    const source = readFileSync(path.resolve(__dirname, "../../lib/use-user.ts"), "utf8");
    const flow = source.slice(source.indexOf("const switchOrganization"), source.indexOf('window.location.assign("/dashboard")'));
    expect(flow.indexOf("unsyncedIds(offlineScope())")).toBeLessThan(flow.indexOf('confirmUnsyncedDiscard("Switching company"'));
    expect(flow.indexOf('rpc("switch_organization"')).toBeLessThan(flow.indexOf("wipeOfflineScope(offlineScope(), confirmed)"));
    expect(flow).toContain("if (kept) window.alert(keptAfterSwitchMessage(kept));");
  });

  it("gives up (the switch is refused, not sent) when a replay is still running at the deadline", async () => {
    let answer!: () => void;
    let calls = 0;
    const pass = replayOutbox(scope, () => (calls++ ? Promise.resolve({ status: "applied" }) : new Promise((resolve) => { answer = () => resolve({ status: "applied" }); })));
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    expect(await waitForReplayIdle(scope, 20, 5)).toBe(false);
    answer();
    await pass;
  });
});

describe("090: the server checks the company a clock action was made in", () => {
  it("each replayed clock action names its queue's company", async () => {
    await syncNow();
    const clockCalls = client.rpc.mock.calls.filter(([name]) => name === "record_attendance_event_in_company");
    expect(clockCalls.map(([, args]) => args.p_expected_org)).toEqual([scope.orgId, scope.orgId]);
  });

  it("refused as the wrong company (a switch the page could not see): kept unchanged and said why; sent once the server takes it", async () => {
    let refuse = true;
    client.rpc.mockImplementation(async (name: string) => {
      if (name === "my_session") return { data: session, error: null };
      if (refuse) return { data: null, error: { code: "42501", hint: "wrong_company", message: "This clock action was made in another company than the one you are working in now, so it was not recorded." } };
      return { data: null, error: null };
    });
    await syncNow();
    const kept = await pendingEntries(scope);
    expect(kept.map((entry) => entry.op)).toEqual([first.op, second.op]);
    expect(kept[0].blocked).toMatchObject({ code: "wrong_company", reason: CLOCK_WRONG_COMPANY_REASON });
    expect(await rejectedEntries(scope)).toEqual([]);
    refuse = false;
    await syncNow();
    expect(await pendingEntries(scope)).toEqual([]);
  });

  it("with no company known on the page nothing is sent", async () => {
    expect(await executeClockOp(first.op as ClockOp, client as never, null)).toMatchObject({ status: "blocked", code: "company_unknown" });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
