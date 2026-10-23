/**
 * Clock actions through the offline outbox (migration 050): queued with a key, replayed through record_attendance_event; duplicate
 * delivery, a lost answer, reversed order across two devices, a reload, an older build that held them, and a server without 050.
 * The fake server keeps one record per key and answers a replay with the first record, as the database does
 * (tests/db/time-attendance.test.ts proves that side).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { type ClockOp, type HeldEntry, type OutboxEntry, ATTENDANCE_LANE, enqueue, jobOfOp, pendingEntries, rejectedEntries, replayOutbox, requeueHeldRunOps } from "@/lib/offline/outbox";
import { memoryBackend, scopeKey, setOfflineBackend } from "@/lib/offline/store";
import { executeClockOp } from "@/lib/offline/sync";
import { DEFAULT_TIME_SETTINGS, dayTotals, hm, type AttendanceEvent } from "@/lib/time-sheet";

type Row = AttendanceEvent & { client_op_id: string };
function fakeServer() {
  const rows: Row[] = [];
  let calls = 0;
  let failNextAnswer = false;
  let down = false;
  let tooOld = false;
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls += 1;
      if (down) throw new TypeError("Failed to fetch");
      if (tooOld) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.record_attendance_event_in_company" } };
      if (fn !== "record_attendance_event_in_company") throw new Error(fn);
      // 090: every clock action names the company it was made in (the queue's).
      if (args.p_expected_org !== "o1") throw new Error(`expected company ${String(args.p_expected_org)}`);
      const key = args.p_client_op_id as string;
      let row = rows.find((r) => r.client_op_id === key);
      if (row && row.action !== args.p_action) return { data: null, error: { code: "22023", hint: "client_op_reused", message: "This clock action's key was already used for something else. Try again." } };
      if (!row) {
        row = { id: `ev-${rows.length + 1}`, user_id: "u1", client_op_id: key, action: args.p_action as Row["action"], at: args.p_at as string, received_at: new Date(Date.UTC(2026, 9, 19, 17, 0, rows.length)).toISOString() };
        rows.push(row);
      }
      if (failNextAnswer) { failNextAnswer = false; throw new TypeError("Failed to fetch"); }
      return { data: { event_id: row.id, action: row.action, at: row.at }, error: null };
    },
  };
  return { rows, client, get calls() { return calls; }, loseNextAnswer() { failNextAnswer = true; }, setDown(v: boolean) { down = v; }, setTooOld(v: boolean) { tooOld = v; } };
}

const scope = { userId: "u1", orgId: "o1" };
let n = 0;
const op = (action: ClockOp["action"], at: string): ClockOp => ({ kind: "clock", v: 1, action, at, clientOpId: `key-${(n += 1)}`, device: "Tablet", jobNo: "Daily job sheet" });
const LATER = Date.parse("2026-10-20T12:00:00Z");

beforeEach(() => setOfflineBackend(memoryBackend()));

describe("clock actions in the outbox", () => {
  it("share one lane, are kept once per key, and replay in order", async () => {
    const a = op("in", "2026-10-19T07:00:00Z");
    expect(jobOfOp(a)).toBe(ATTENDANCE_LANE);
    await enqueue(scope, a);
    await enqueue(scope, a); // a double tap
    await enqueue(scope, op("out", "2026-10-19T15:30:00Z"));
    expect((await pendingEntries(scope)).map((e) => (e.op as ClockOp).action)).toEqual(["in", "out"]);
    const server = fakeServer();
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ applied: 2, remaining: 0 });
    expect(server.rows.map((r) => r.action)).toEqual(["in", "out"]);
  });

  it("a lost answer: the entry stays, the resend answers the first record, one row", async () => {
    const server = fakeServer();
    await enqueue(scope, op("in", "2026-10-19T07:00:00Z"));
    server.loseNextAnswer();
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ applied: 0, remaining: 1 });
    expect((await pendingEntries(scope))[0]).not.toHaveProperty("inFlight");
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ applied: 1, remaining: 0 });
    expect(server.rows).toHaveLength(1);
  });

  it("two devices, reversed order: the phone's clock-out reaches the server before the tablet's clock-in; the day is 8:30", async () => {
    const server = fakeServer();
    const tablet = memoryBackend();
    const phone = memoryBackend();
    setOfflineBackend(tablet);
    await enqueue(scope, op("in", "2026-10-19T06:30:00Z")); // 07:30 BST, tablet offline
    setOfflineBackend(phone);
    await enqueue(scope, op("out", "2026-10-19T15:00:00Z")); // 16:00 BST
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ applied: 1 });
    setOfflineBackend(tablet); // back online later
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ applied: 1 });
    expect(server.rows.map((r) => r.action)).toEqual(["out", "in"]);
    const day = dayTotals({ date: "2026-10-19", events: server.rows, labour: [], settings: DEFAULT_TIME_SETTINGS, bankHolidays: new Map(), now: LATER });
    expect([hm(day.attendance), hm(day.paid), day.flags]).toEqual(["8:30", "7:45", []]);
  });

  it("offline: nothing is sent, nothing is lost; a reload (the same store) sends it once", async () => {
    const store = memoryBackend();
    setOfflineBackend(store);
    const server = fakeServer();
    server.setDown(true);
    await enqueue(scope, op("in", "2026-10-19T07:00:00Z"));
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ applied: 0, remaining: 1 });
    server.setDown(false);
    setOfflineBackend(store); // the page reloads: same device store
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ applied: 1, remaining: 0 });
    expect(server.rows).toHaveLength(1);
  });

  it("a server without 050: blocked, kept unchanged, applied once the server is updated", async () => {
    const server = fakeServer();
    server.setTooOld(true);
    const queued = op("out", "2026-10-19T15:00:00Z");
    await enqueue(scope, queued);
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ blocked: 1, remaining: 1 });
    const left = await pendingEntries(scope);
    expect(left[0].op).toEqual(queued);
    expect(left[0].blocked).toMatchObject({ code: "server_upgrade_needed" });
    server.setTooOld(false);
    expect(await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, server.client, scope.orgId))).toMatchObject({ applied: 1, remaining: 0 });
  });

  it("refusals are held with a code; one an older build held without a code goes back in the queue", async () => {
    const client = { rpc: async () => ({ data: null, error: { code: "22023", hint: "time_too_old", message: "too old" } }) };
    await enqueue(scope, op("in", "2026-09-01T07:00:00Z"));
    await replayOutbox(scope, (o) => executeClockOp(o as ClockOp, client, scope.orgId));
    const held = await rejectedEntries(scope);
    expect(held[0]).toMatchObject({ code: "time_too_old" });
    expect(held[0].reason).toContain("more than 14 days old");
    // An older build (no "clock" kind) refused one without a code: this build requeues it, the op byte for byte.
    const store = memoryBackend();
    setOfflineBackend(store);
    const old: OutboxEntry = { id: "1-1-a", queuedAt: "2026-10-19T07:00:00Z", op: op("in", "2026-10-19T07:00:00Z") };
    await store.set(`${scopeKey(scope)}|rejected`, [{ ...old, reason: "invalid input syntax for type uuid", heldAt: "2026-10-19T07:01:00Z" } satisfies HeldEntry]);
    expect(await requeueHeldRunOps(scope, "build")).toBe(1);
    expect((await pendingEntries(scope)).map((e) => e.op)).toEqual([old.op]);
  });

  it("a direct send (nothing queued) with no offline scope goes to the active company the page names, not company_unknown", async () => {
    // lib/offline/scope has no scope here (localStorage blocked or offline access refused): the default company is null.
    const server = fakeServer();
    expect(await executeClockOp(op("in", "2026-10-19T07:00:00Z"), server.client)).toMatchObject({ status: "blocked", code: "company_unknown" });
    expect(server.calls).toBe(0);
    expect(await executeClockOp(op("in", "2026-10-19T07:00:00Z"), server.client, scope.orgId)).toEqual({ status: "applied" });
    expect(server.rows).toHaveLength(1);
    // components/time/day-sheet.tsx passes the profile's company on that path.
    const sheet = readFileSync(path.resolve(__dirname, "../../components/time/day-sheet.tsx"), "utf8");
    expect(sheet).toContain("executeClockOp(op, supabase, profile?.organization_id ?? undefined)");
  });
});
