/**
 * Downgrade (plan R3.6 D1b): the previous build (main 86bb660, frozen in tests/fixtures/offline/sync-86bb660.ts) must never send a 049
 * run_start / run_pause entry left on the device as a 6-argument call. Its dispatcher sends an unknown kind to its plain started_at update
 * with `.eq("id", op.jobId)`, undefined for these entries, which PostgREST refuses (22P02): held as REJECTED (not applied, not network),
 * with no start_machine_run or pause_machine_run call and no row changed, the op kept exactly (bench: true and the paused-machine check
 * included). Re-upgrade: requeueHeldRunOps puts those entries back, once per build, in their capture order per job, and the new build's
 * replay then opens the bench run and closes it with the Pause. (The same frozen dispatcher against the local database: the
 * downgrade block of tests/db/paused-machine-ack.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enqueue, pendingEntries, rejectedEntries, replayOutbox, requeueHeldRunOps, type OutboxOp, type RunPauseOp, type RunStartOp } from "@/lib/offline/outbox";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { executeRunPauseOp, executeRunStartOp } from "@/lib/offline/sync";
import { drain86bb660, executor86bb660 } from "../fixtures/offline/sync-86bb660";

const alice = { userId: "user-a", orgId: "org-1" };
const JOB = "33333333-3333-4333-8333-333333333333";
const start: RunStartOp = { kind: "run_start", v: 2, jobRef: JOB, jobNo: "J-7", at: "2026-10-14T09:00:00.000Z", clientOpId: "k-start", machines: [], bench: true, pausedAck: [{ machine_id: "m", paused_run_id: "r" }] };
const pause: RunPauseOp = { kind: "run_pause", v: 2, jobRef: JOB, jobNo: "J-7", at: "2026-10-14T10:00:00.000Z", clientOpId: "k-pause", machines: null, afterStart: "k-start" };

/** A recording stand-in for PostgREST: every RPC and table call is logged; `.eq("id", x)` with a value that isn't a UUID answers 22P02. */
function recordingServer() {
  const calls: string[] = [];
  const rows = new Map<string, { started_at: string | null }>([[JOB, { started_at: null }]]);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const query = (table: string) => {
    const state: { patch?: Record<string, unknown>; id?: string } = {};
    const chain = {
      update(patch: Record<string, unknown>) { state.patch = patch; calls.push(`${table}.update`); return chain; },
      select() { return chain; },
      eq(_col: string, value: unknown) { state.id = `${value}`; return chain; },
      is() { return chain; },
      maybeSingle() { return chain.then((r: unknown) => r); },
      then(resolve: (r: unknown) => unknown) {
        if (!uuid.test(state.id ?? "")) return Promise.resolve(resolve({ data: null, error: { code: "22P02", message: `invalid input syntax for type uuid: "${state.id}"`, details: null, hint: null } }));
        return Promise.resolve(resolve({ data: [], error: null }));
      },
    };
    return chain;
  };
  return { calls, rows, client: { from: (t: string) => query(t), rpc: (fn: string) => { calls.push(`rpc:${fn}`); return Promise.resolve({ data: null, error: null }); }, auth: { getSession: async () => ({ data: { session: null } }) } } };
}

beforeEach(() => setOfflineBackend(memoryBackend()));
afterEach(() => setOfflineBackend(null));

describe("the previous build meets 049 entries on the device (D1b)", () => {
  it("files them as rejected (not applied, not network): no Start or Pause call, no row changed, the op kept exactly", async () => {
    await enqueue(alice, start);
    await enqueue(alice, pause);
    const server = recordingServer();
    const before = structuredClone([...server.rows]);
    const result = await drain86bb660(alice, executor86bb660(server.client));
    expect(result).toMatchObject({ applied: 0, rejected: 2, remaining: 0 });
    expect(server.calls.filter((c) => c.startsWith("rpc:"))).toEqual([]);
    expect([...server.rows]).toEqual(before);
    const held = await rejectedEntries(alice);
    expect(held.map((h) => h.op)).toEqual([start, pause]);
    expect(held.every((h) => h.code === undefined)).toBe(true);
    expect((held[0].op as RunStartOp).bench).toBe(true);
    expect((held[0].op as RunStartOp).pausedAck).toEqual([{ machine_id: "m", paused_run_id: "r" }]);
  });
});

describe("re-upgrade: requeueHeldRunOps", () => {
  it("puts the old build's held run entries back once per build, in capture order per job; the new build then opens and closes the bench run", async () => {
    await enqueue(alice, start, new Date("2026-10-14T09:00:00Z"));
    await enqueue(alice, { kind: "worksheet", jobId: "other", jobNo: "J-8", worksheet: {}, baseVersion: 1 }, new Date("2026-10-14T09:30:00Z"));
    await enqueue(alice, pause, new Date("2026-10-14T10:00:00Z"));
    // The old build: the worksheet is a refusal of its own (kept), the two run entries are rejected without a code.
    await drain86bb660(alice, async (op: OutboxOp) => (op.kind === "worksheet" ? { status: "rejected", reason: "locked", code: "worksheet_locked" } : executor86bb660(recordingServer().client)(op)));
    expect((await rejectedEntries(alice)).map((h) => h.op.kind)).toEqual(["run_start", "worksheet", "run_pause"]);
    // A held entry of this build (with a code) is not requeued.
    expect(await requeueHeldRunOps(alice, "build-2")).toBe(2);
    expect(await requeueHeldRunOps(alice, "build-2")).toBe(0); // once per build
    expect((await pendingEntries(alice)).map((e) => e.op)).toEqual([start, pause]);
    expect((await rejectedEntries(alice)).map((h) => h.op.kind)).toEqual(["worksheet"]);
    // The new build's replay against a server at 049 (modelled): the bench Start opens a bench run, the Pause closes it.
    const runs: { open: boolean; started: string; ended?: string }[] = [];
    const server = {
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (fn === "start_machine_run") {
          expect(args).toMatchObject({ p_bench: true, p_paused_ack: start.pausedAck });
          runs.push({ open: true, started: String(args.p_started_at) });
          return Promise.resolve({ data: { runs: [], bench_run: { run_id: "b1", already: false }, bench_skipped: null, time_conflicts: [] }, error: null });
        }
        const open = runs.find((r) => r.open)!;
        open.open = false;
        open.ended = String(args.p_ended_at);
        return Promise.resolve({ data: { ended: [{ run_id: "b1" }], time_conflicts: [] }, error: null });
      },
    };
    const result = await replayOutbox(alice, (op) => (op.kind === "run_start" ? executeRunStartOp(op, server) : executeRunPauseOp(op as RunPauseOp, server)));
    expect(result).toMatchObject({ applied: 2, rejected: 0, remaining: 0 });
    expect(runs).toEqual([{ open: false, started: start.at, ended: pause.at }]);
  });

  const bench = (runs: { started?: string; ended?: string }[]) => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === "start_machine_run") {
        runs.push({ started: String(args.p_started_at) });
        return Promise.resolve({ data: { runs: [], bench_run: { run_id: "b1", already: false }, bench_skipped: null, time_conflicts: [] }, error: null });
      }
      runs[runs.length - 1].ended = String(args.p_ended_at);
      return Promise.resolve({ data: { ended: [{ run_id: "b1" }], time_conflicts: [] }, error: null });
    },
  });
  const run = (server: ReturnType<typeof bench>) => replayOutbox(alice, (op) => (op.kind === "run_start" ? executeRunStartOp(op, server) : executeRunPauseOp(op as RunPauseOp, server)));

  it("partial downgrade: the older build refused the Start but lost connectivity before the Pause; recovery puts the Start BEFORE the pending Pause", async () => {
    await enqueue(alice, start, new Date("2026-10-14T09:00:00Z"));
    await enqueue(alice, pause, new Date("2026-10-14T10:00:00Z"));
    // Older build: the Start is rejected (22P02), then the network drops: the Pause is still pending.
    await drain86bb660(alice, async (op: OutboxOp) => (op.kind === "run_start" ? executor86bb660(recordingServer().client)(op) : { status: "network" }));
    expect((await rejectedEntries(alice)).map((h) => h.op)).toEqual([start]);
    expect((await pendingEntries(alice)).map((e) => e.op)).toEqual([pause]);
    expect(await requeueHeldRunOps(alice, "build-2")).toBe(1);
    expect((await pendingEntries(alice)).map((e) => e.op)).toEqual([start, pause]);
    const runs: { started?: string; ended?: string }[] = [];
    expect(await run(bench(runs))).toMatchObject({ applied: 2, rejected: 0, remaining: 0 });
    expect(runs).toEqual([{ started: start.at, ended: pause.at }]); // the job ends paused, not running
  });

  it("upgrade, rollback, restore the same newer build: what the older build held is recovered and replayed once, in order", async () => {
    // Newer build loads first with nothing to recover (this used to record the build marker for good).
    expect(await requeueHeldRunOps(alice, "build-2")).toBe(0);
    await enqueue(alice, start, new Date("2026-10-14T09:00:00Z"));
    await enqueue(alice, pause, new Date("2026-10-14T10:00:00Z"));
    // Rollback: the older build rejects both.
    await drain86bb660(alice, executor86bb660(recordingServer().client));
    expect(await pendingEntries(alice)).toEqual([]);
    // The SAME newer build comes back.
    expect(await requeueHeldRunOps(alice, "build-2")).toBe(2);
    expect(await requeueHeldRunOps(alice, "build-2")).toBe(0);
    expect((await pendingEntries(alice)).map((e) => e.op)).toEqual([start, pause]);
    const runs: { started?: string; ended?: string }[] = [];
    expect(await run(bench(runs))).toMatchObject({ applied: 2, rejected: 0, remaining: 0 });
    expect(runs).toEqual([{ started: start.at, ended: pause.at }]);
    expect(await rejectedEntries(alice)).toEqual([]);
    expect(await requeueHeldRunOps(alice, "build-2")).toBe(0); // nothing duplicated
  });
});
