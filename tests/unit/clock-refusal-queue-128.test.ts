/**
 * Migration 128: a clock action refused by the network lock (114) is reported for the admin's banner (record_clock_in_refusal). When
 * that report can't reach the server it is queued in the offline outbox (kind clock_refusal, the refused action's own client key) and
 * sent once on reconnect: no answer keeps it queued; any answer (recorded, replayed, not_refused, ...) finishes it, never held. The
 * same key queued twice stays one entry, and it has its own lane (it never holds up a clock action).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queued: unknown[] = [];
vi.mock("@/lib/offline/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/offline/scope")>()),
  queueOffline: vi.fn(async (op: unknown) => { queued.push(op); return true; }),
}));

import { CLOCK_IN_NETWORK_LOCKED } from "@/lib/clock-in-lock";
import { ATTENDANCE_LANE, CLOCK_REFUSAL_LANE, type ClockOp, type ClockRefusalOp, enqueue, jobOfOp, pendingEntries } from "@/lib/offline/outbox";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { executeClockOp, executeClockRefusalOp } from "@/lib/offline/sync";

const op: ClockOp = { kind: "clock", v: 1, action: "in", at: new Date().toISOString(), clientOpId: "00000000-0000-0000-0000-000000000128", device: "Phone", jobNo: "Daily job sheet" };
const locked = { code: "42501", hint: CLOCK_IN_NETWORK_LOCKED, message: "Clock in from the workshop Wi-Fi: this device isn't on it, so nothing was recorded." };
const offline = { message: "TypeError: Failed to fetch" };

beforeEach(() => { queued.length = 0; });

describe("a refusal report that can't reach the server is queued", () => {
  it("queues one clock_refusal entry with the refused action's key when the report gets no answer; the clock outcome is unchanged", async () => {
    const client = { rpc: async (fn: string) => ({ data: null, error: fn === "record_clock_in_refusal" ? offline : locked }) };
    expect(await executeClockOp(op, client as never, "o1")).toMatchObject({ status: "rejected", code: "refused" });
    expect(queued).toEqual([{ kind: "clock_refusal", v: 1, action: "in", clientOpId: op.clientOpId, jobRef: CLOCK_REFUSAL_LANE, jobNo: "Daily job sheet" }]);
  });
  it("queues nothing when the server answered the report (recorded or refused)", async () => {
    for (const answer of [{ data: { recorded: true }, error: null }, { data: null, error: { code: "22023", hint: "not_refused", message: "no" } }]) {
      const client = { rpc: async (fn: string) => (fn === "record_clock_in_refusal" ? answer : { data: null, error: locked }) };
      await executeClockOp(op, client as never, "o1");
    }
    expect(queued).toEqual([]);
  });
});

describe("the queued report on reconnect", () => {
  const report: ClockRefusalOp = { kind: "clock_refusal", v: 1, action: "in", clientOpId: op.clientOpId, jobRef: CLOCK_REFUSAL_LANE, jobNo: "Daily job sheet" };
  it("sends record_clock_in_refusal under the same key; any answer finishes it, no answer keeps it queued", async () => {
    const calls: [string, unknown][] = [];
    const answers = [{ data: { recorded: true, replayed: true }, error: null }, { data: null, error: { code: "22023", hint: "not_refused", message: "no" } }, { data: null, error: offline }];
    const outcomes = [];
    for (const a of answers) outcomes.push(await executeClockRefusalOp(report, { rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return a; } }));
    expect(outcomes).toEqual([{ status: "applied" }, { status: "applied" }, { status: "network" }]);
    expect(calls.every(([fn, args]) => fn === "record_clock_in_refusal" && JSON.stringify(args) === JSON.stringify({ p_client_op_id: op.clientOpId, p_action: "in" }))).toBe(true);
  });
  it("has its own lane and the same key queued twice stays one entry", async () => {
    expect(jobOfOp(report)).toBe(CLOCK_REFUSAL_LANE);
    expect(jobOfOp(op)).toBe(ATTENDANCE_LANE);
    setOfflineBackend(memoryBackend(new Map()));
    try {
      const scope = { userId: "u1", orgId: "o1" };
      await enqueue(scope as never, report);
      await enqueue(scope as never, { ...report });
      expect((await pendingEntries(scope as never)).filter((e) => e.op.kind === "clock_refusal")).toHaveLength(1);
    } finally {
      setOfflineBackend(null);
    }
  });
});
