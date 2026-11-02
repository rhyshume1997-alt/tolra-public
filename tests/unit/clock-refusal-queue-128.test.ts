/**
 * Migration 128: a clock action refused by the network lock (114) is reported for the admin's banner (record_clock_in_refusal). The
 * report never blocks or retries the refused clock action itself:
 *   - the clock action stays refused and its refusal is answered AT ONCE (the report runs in the background, never awaited), whether
 *     the report is recorded, refused, fails, never answers, or is queued (and even when queueing it fails);
 *   - a report that can't reach the server is queued in the offline outbox (kind clock_refusal, the refused action's own client key) and
 *     sent once on reconnect; that retry re-sends ONLY the report (record_clock_in_refusal), never the clock action
 *     (record_attendance_event_in_company), and a refused clock action held in the rejected list is never re-sent by a later pass;
 *   - no answer keeps the report queued; any answer (recorded, replayed, not_refused, ...) finishes it, never held;
 *   - the same key queued twice stays one entry, and it has its own lane (it never holds up a clock action).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queued: [] as unknown[],
  queueFails: false,
  rpc: (async () => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
}));
vi.mock("@/lib/offline/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/offline/scope")>()),
  queueOffline: vi.fn(async (op: unknown) => {
    if (h.queueFails) throw new Error("storage full");
    h.queued.push(op);
    return true;
  }),
}));
vi.mock("@/lib/supabase", async (orig) => ({
  ...(await orig<typeof import("@/lib/supabase")>()),
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => h.rpc(fn, args) },
}));

import { CLOCK_IN_NETWORK_LOCKED } from "@/lib/clock-in-lock";
import { ATTENDANCE_LANE, CLOCK_REFUSAL_LANE, type ClockOp, type ClockRefusalOp, enqueue, jobOfOp, pendingEntries, rejectedEntries, replayOutbox } from "@/lib/offline/outbox";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { executeClockOp, executeClockRefusalOp, executeOutboxOp, reportClockRefusalInBackground } from "@/lib/offline/sync";

const op: ClockOp = { kind: "clock", v: 1, action: "in", at: new Date().toISOString(), clientOpId: "00000000-0000-0000-0000-000000000128", device: "Phone", jobNo: "Daily job sheet" };
const locked = { code: "42501", hint: CLOCK_IN_NETWORK_LOCKED, message: "Clock in from the workshop Wi-Fi: this device isn't on it, so nothing was recorded." };
const offline = { message: "TypeError: Failed to fetch" };
const report: ClockRefusalOp = { kind: "clock_refusal", v: 1, action: "in", clientOpId: op.clientOpId, jobRef: CLOCK_REFUSAL_LANE, jobNo: "Daily job sheet" };
const refusedNow = { status: "rejected", code: "refused", reason: locked.message };
/** Resolves "late" after a real 50 ms: a clock outcome that waited for its report would lose this race. */
const late = () => new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 50));

beforeEach(() => { h.queued.length = 0; h.queueFails = false; });

describe("the refused clock action is answered at once, whatever the report does", () => {
  type Answer = () => Promise<{ data: unknown; error: unknown }>;
  const cases: [string, Answer][] = [
    ["recorded", async () => ({ data: { recorded: true }, error: null })],
    ["refused by the server (not_refused)", async () => ({ data: null, error: { code: "22023", hint: "not_refused", message: "no" } })],
    ["fails (no connection)", async () => ({ data: null, error: offline })],
    ["throws", async () => { throw new TypeError("Failed to fetch"); }],
    ["never answers", () => new Promise(() => {})],
  ];
  for (const [label, answer] of cases) {
    it(`report ${label}: the clock action stays refused with its message, without waiting`, async () => {
      const calls: string[] = [];
      const client = { rpc: (fn: string) => { calls.push(fn); return fn === "record_clock_in_refusal" ? answer() : Promise.resolve({ data: null, error: locked }); } };
      const outcome = await Promise.race([executeClockOp(op, client as never, "o1"), late()]);
      expect(outcome).toEqual(refusedNow);
      // The clock action was sent once; the report was started; nothing re-sent the clock action.
      expect(calls.filter((fn) => fn === "record_attendance_event_in_company")).toHaveLength(1);
      expect(calls.filter((fn) => fn === "record_clock_in_refusal")).toHaveLength(1);
    });
  }
  it("the report queued (no answer) and even queueing failing: still refused at once, nothing thrown", async () => {
    for (const fails of [false, true]) {
      h.queueFails = fails;
      const client = { rpc: async (fn: string) => ({ data: null, error: fn === "record_clock_in_refusal" ? offline : locked }) };
      expect(await Promise.race([executeClockOp(op, client as never, "o1"), late()])).toEqual(refusedNow);
      await expect(reportClockRefusalInBackground(client as never, op)).resolves.toBeUndefined();
    }
  });
});

describe("a refusal report that can't reach the server is queued (the report only)", () => {
  it("queues one clock_refusal entry with the refused action's key when the report gets no answer; the clock outcome is unchanged", async () => {
    const client = { rpc: async (fn: string) => ({ data: null, error: fn === "record_clock_in_refusal" ? offline : locked }) };
    expect(await executeClockOp(op, client as never, "o1")).toEqual(refusedNow);
    await vi.waitFor(() => expect(h.queued).toHaveLength(1));
    expect(h.queued).toEqual([report]);
    expect(h.queued.some((q) => (q as { kind: string }).kind === "clock")).toBe(false);
  });
  it("queues nothing when the server answered the report (recorded or refused)", async () => {
    for (const answer of [{ data: { recorded: true }, error: null }, { data: null, error: { code: "22023", hint: "not_refused", message: "no" } }]) {
      const client = { rpc: async (fn: string) => (fn === "record_clock_in_refusal" ? answer : { data: null, error: locked }) };
      await executeClockOp(op, client as never, "o1");
      await reportClockRefusalInBackground(client as never, op);
    }
    expect(h.queued).toEqual([]);
  });
});

describe("the queued report on reconnect", () => {
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
  it("the outbox retry (executeOutboxOp through replayOutbox) re-sends ONLY the report, never the clock action", async () => {
    setOfflineBackend(memoryBackend(new Map()));
    try {
      const scope = { userId: "u1", orgId: "o1" };
      const calls: [string, Record<string, unknown>][] = [];
      let up = false;
      h.rpc = async (fn, args) => {
        calls.push([fn, args]);
        if (!up) return { data: null, error: offline };
        if (fn === "record_clock_in_refusal") return { data: { recorded: true, replayed: false }, error: null };
        return { data: null, error: locked };
      };
      await enqueue(scope as never, report);
      // Still offline: the report stays queued.
      expect(await replayOutbox(scope as never, (o) => executeOutboxOp(o, "o1"))).toMatchObject({ applied: 0, remaining: 1 });
      // Reconnected: the report is sent once and finished; a further pass sends nothing.
      up = true;
      expect(await replayOutbox(scope as never, (o) => executeOutboxOp(o, "o1"))).toMatchObject({ applied: 1, remaining: 0 });
      expect(await replayOutbox(scope as never, (o) => executeOutboxOp(o, "o1"))).toMatchObject({ applied: 0, remaining: 0 });
      expect(calls.map(([fn]) => fn)).toEqual(["record_clock_in_refusal", "record_clock_in_refusal"]);
      expect(calls.every(([, args]) => args.p_client_op_id === op.clientOpId && args.p_action === "in" && !("p_at" in args) && !("p_device" in args))).toBe(true);
      expect(await rejectedEntries(scope as never)).toEqual([]);
    } finally {
      setOfflineBackend(null);
    }
  });
  it("a clock action the lock refused is held as rejected, and a later pass never re-submits it", async () => {
    setOfflineBackend(memoryBackend(new Map()));
    try {
      const scope = { userId: "u1", orgId: "o1" };
      const calls: string[] = [];
      h.rpc = async (fn) => { calls.push(fn); return fn === "record_clock_in_refusal" ? { data: { recorded: true }, error: null } : { data: null, error: locked }; };
      await enqueue(scope as never, op);
      expect(await replayOutbox(scope as never, (o) => executeOutboxOp(o, "o1"))).toMatchObject({ rejected: 1, remaining: 0 });
      expect((await rejectedEntries(scope as never)).map((e) => [e.op.kind, e.reason])).toEqual([["clock", locked.message]]);
      await vi.waitFor(() => expect(calls).toContain("record_clock_in_refusal"));
      for (let i = 0; i < 2; i += 1) await replayOutbox(scope as never, (o) => executeOutboxOp(o, "o1"));
      expect(calls.filter((fn) => fn === "record_attendance_event_in_company")).toHaveLength(1);
      expect(calls.filter((fn) => fn === "record_clock_in_refusal")).toHaveLength(1);
    } finally {
      setOfflineBackend(null);
    }
  });
});
