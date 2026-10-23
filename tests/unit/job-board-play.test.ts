/**
 * Job Board Play/Pause (plan docs/packets/job-board-ux-plan.md: 2.1, R2.3, R2.4, R3.3, R3.4): the pure state, the offline fold, the replay
 * of a Play Start against a server with and without 049, and the outbox's blocked / per-job skip / start_refused rules.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adminStopText, defaultPick, pendingRunView, playState, runViewLabel, type JobRunState } from "@/lib/job-actions";
import { missingRunsReason, pausedAckPayload, pausedFor, pausedWarningText, releaseFacts, requestedRunsPresent, runFactsByJob, withReleaseReasons, type PausedRow } from "@/lib/machine-runs";
import { conflictEntries, enqueue, pendingEntries, rejectedEntries, replayOutbox, START_REFUSED, type OutboxEntry, type OutboxOp, type ReplayOutcome, type RunPauseOp, type RunStartOp } from "@/lib/offline/outbox";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { executeRunPauseOp, executeRunStartOp, runStartArgs } from "@/lib/offline/sync";

const alice = { userId: "user-a", orgId: "org-1" };
const MILL = "11111111-1111-4111-8111-111111111111";
const LATHE = "22222222-2222-4222-8222-222222222222";
const names: Record<string, string> = { [MILL]: "Mill", [LATHE]: "Lathe" };
const name = (id: string) => names[id] ?? "?";
let seq = 0;
const runStart = (over: Partial<RunStartOp> = {}): RunStartOp => ({ kind: "run_start", v: 2, jobRef: "job-1", jobNo: "J-123", at: "2026-10-14T09:00:00.000Z", clientOpId: `start-${++seq}`, machines: [MILL], bench: false, pausedAck: [], ...over });
const runPause = (over: Partial<RunPauseOp> = {}): RunPauseOp => ({ kind: "run_pause", v: 2, jobRef: "job-1", jobNo: "J-123", at: "2026-10-14T10:00:00.000Z", clientOpId: `pause-${++seq}`, machines: null, afterStart: null, ...over });
const entry = (op: OutboxOp, blocked = false): OutboxEntry => ({ id: `${++seq}`, queuedAt: new Date(2026, 9, 14, 9, seq).toISOString(), op, ...(blocked ? { blocked: { code: "server_upgrade_needed", reason: "x", at: "now" } } : {}) });
const idle: JobRunState = { jobId: "job-1", machines: [], bench: false };
const job = { job_no: "J-123", started_at: "2026-10-14T08:00:00Z" };

beforeEach(() => setOfflineBackend(memoryBackend()));
afterEach(() => setOfflineBackend(null));

describe("playState: one Play/Pause per job (plan 2.1, R2.3)", () => {
  const ctx = { viewer: false };
  it("every row of the table", () => {
    const running = pendingRunView({ jobId: "job-1", machines: [MILL, LATHE], bench: false }, []);
    expect(playState({ job_no: "J-123" }, ctx, pendingRunView(idle, []))).toMatchObject({ kind: "not_started", button: "play", label: "Start", aria: "Start J-123" });
    expect(playState(job, ctx, pendingRunView(idle, []), { hasRuns: false })).toMatchObject({ kind: "started_untimed", label: "Start timer", aria: "Start timer J-123", status: "Started (not timed)" });
    expect(playState(job, ctx, running, { hasRuns: true }, name)).toMatchObject({ kind: "running_machine", button: "pause", label: "Pause", aria: "Pause J-123, stops the job and frees Mill, Lathe" });
    expect(playState(job, ctx, pendingRunView({ ...idle, bench: true }, []), { hasRuns: true })).toMatchObject({ kind: "running_bench", button: "pause", aria: "Pause J-123" });
    expect(playState(job, ctx, pendingRunView(idle, []), { hasRuns: true, lastEnd: "paused" })).toMatchObject({ kind: "paused", button: "play", label: "Resume", aria: "Resume J-123" });
    expect(playState(job, ctx, pendingRunView(idle, []), { hasRuns: true, lastEnd: "to_machine" })).toMatchObject({ kind: "paused", label: "Resume" });
    expect(playState(job, ctx, pendingRunView(idle, []), { hasRuns: true, lastEnd: "admin_released" })).toMatchObject({ kind: "stopped_admin", label: "Resume", status: "Stopped (machine released by admin)" });
    expect(playState(job, ctx, pendingRunView(idle, []), { hasRuns: true, lastEnd: "override" })).toMatchObject({ kind: "stopped_override", status: "Stopped (taken over)" });
    expect(playState({ ...job, finished_at: "2026-10-14T12:00:00Z" }, ctx, running)).toMatchObject({ kind: "finished", button: null });
    expect(playState({ ...job, finished_at: "x", inspected_at: "y" }, ctx, running)).toMatchObject({ kind: "inspected", button: null });
    expect(playState({ ...job, stage: "rework" }, ctx, running)).toMatchObject({ kind: "rework", button: null });
    expect(playState(job, { viewer: true }, running)).toMatchObject({ kind: "hidden", button: null });
  });

  it("never a false Pause: Pause only while the folded state is running", () => {
    expect(playState(job, ctx, pendingRunView(idle, [entry(runStart()), entry(runPause())]), { hasRuns: true }).button).toBe("play");
    expect(playState(job, ctx, pendingRunView(idle, [entry(runStart())]), { hasRuns: true }).button).toBe("pause");
  });
});

describe("pendingRunView: server state + pending ops, folded in capture order (R3.4)", () => {
  it("none; Start; Start then Pause; Pause then Start on a running job; Start, Pause, Start; Pause with nothing running", () => {
    expect(runViewLabel(pendingRunView(idle, []))).toBeNull();
    expect(runViewLabel(pendingRunView(idle, [entry(runStart())]), name)).toBe("Running on Mill, waiting to sync");
    expect(runViewLabel(pendingRunView(idle, [entry(runStart({ machines: [], bench: true }))]))).toBe("On the bench, waiting to sync");
    const startPause = pendingRunView(idle, [entry(runStart()), entry(runPause())]);
    expect(runViewLabel(startPause)).toBe("Paused, waiting to sync");
    expect(startPause).toMatchObject({ running: false, waiting: true, pending: 2 });
    const serverRunning: JobRunState = { jobId: "job-1", machines: [MILL], bench: false };
    expect(runViewLabel(pendingRunView(serverRunning, [entry(runPause()), entry(runStart())]), name)).toBe("Running on Mill, waiting to sync");
    expect(runViewLabel(pendingRunView(idle, [entry(runStart()), entry(runPause()), entry(runStart({ machines: [LATHE] }))]), name)).toBe("Running on Lathe, waiting to sync");
    expect(pendingRunView(idle, [entry(runPause())])).toMatchObject({ running: false, waiting: false, pending: 1 });
  });

  it("other jobs' entries don't count; a blocked entry adds the update suffix; a Pause naming one machine keeps the other", () => {
    expect(pendingRunView(idle, [entry(runStart({ jobRef: "job-2" }))])).toMatchObject({ running: false, waiting: false, pending: 0 });
    expect(runViewLabel(pendingRunView(idle, [entry(runStart({ machines: [], bench: true }), true), entry(runPause())]))).toBe("Paused, waiting to sync · needs an app/server update");
    const both = pendingRunView({ jobId: "job-1", machines: [MILL, LATHE], bench: false }, [entry(runPause({ machines: [MILL] }))]);
    expect(both).toMatchObject({ running: true, machines: [LATHE] });
  });

  it("legacy 044/046 entries on the device fold the same way", () => {
    const legacyStart: OutboxOp = { kind: "start", jobId: "job-1", jobNo: "J-123", at: "x", machines: [], clientOpId: "k" };
    const legacyPause: OutboxOp = { kind: "pause", jobId: "job-1", jobNo: "J-123", at: "y", machines: null, clientOpId: "p" };
    expect(runViewLabel(pendingRunView(idle, [entry(legacyStart)]))).toBe("On the bench, waiting to sync");
    expect(runViewLabel(pendingRunView(idle, [entry(legacyStart), entry(legacyPause)]))).toBe("Paused, waiting to sync");
  });

  it("held entries are excluded and the view is the same after a reload (rebuilt from a fresh store over the same data)", async () => {
    const data = new Map<string, unknown>();
    setOfflineBackend(memoryBackend(data));
    await enqueue(alice, runStart());
    await enqueue(alice, runPause());
    const before = pendingRunView(idle, await pendingEntries(alice));
    setOfflineBackend(memoryBackend(data)); // "reload": a new backend over what the device kept
    const after = pendingRunView(idle, await pendingEntries(alice));
    expect(after).toEqual(before);
    expect(runViewLabel(after)).toBe("Paused, waiting to sync");
    // Once held (rejected), an entry is out of the outbox and out of the fold.
    await replayOutbox(alice, async () => ({ status: "rejected", reason: "no", code: "refused" }));
    expect(pendingRunView(idle, await pendingEntries(alice))).toMatchObject({ waiting: false, pending: 0 });
  });
});

describe("the Machine column and the paused-machine check", () => {
  it("defaultPick (R2.4): free planned machines; nothing when all are busy; Resume prefilled with what it last ran on", () => {
    const busy = (id: string) => id === LATHE;
    expect(defaultPick({ planned: [MILL, LATHE], resuming: false, busy })).toEqual({ machines: [MILL], bench: false });
    expect(defaultPick({ planned: [LATHE], resuming: false, busy })).toEqual({ machines: [], bench: false });
    expect(defaultPick({ planned: [], resuming: false, busy })).toEqual({ machines: [], bench: false });
    expect(defaultPick({ planned: [MILL], lastBench: true, lastMachines: [], resuming: true, busy })).toEqual({ machines: [], bench: true });
    expect(defaultPick({ planned: [], lastMachines: [MILL], resuming: true, busy })).toEqual({ machines: [MILL], bench: false });
  });

  it("the warning lists other jobs' paused machines only; the ack carries exactly the run ids shown; the wording", () => {
    const rows: PausedRow[] = [
      { machine_id: MILL, paused_run_id: "run-1", job_id: "job-9", job_no: "J-118", operator_name: "Dave", paused_by_name: "Dave", paused_at: "2026-10-14T11:05:00Z" },
      { machine_id: LATHE, paused_run_id: "run-2", job_id: "job-1", job_no: "J-123", operator_name: "Ann", paused_by_name: "Ann", paused_at: "2026-10-14T11:05:00Z" },
    ];
    const shown = pausedFor(rows, "job-1", [MILL, LATHE]);
    expect(shown.map((r) => r.machine_id)).toEqual([MILL]);
    expect(pausedAckPayload(shown)).toEqual([{ machine_id: MILL, paused_run_id: "run-1" }]);
    expect(pausedWarningText(rows[0], "Mill", new Date("2026-10-14T15:00:00Z"))).toBe("Mill was paused on J-118 by Dave at 12:05 today and J-118 isn't finished. Check with Dave before using the Mill so the job isn't missed.");
  });

  it("runFactsByJob (R2.3): no runs, open runs, how the latest run ended and what it ran on", () => {
    const facts = runFactsByJob([
      { job_id: "a", machine_id: MILL, started_at: "1", ended_at: "2026-10-14T10:00:00Z", end_reason: "paused" },
      { job_id: "a", machine_id: LATHE, started_at: "1", ended_at: "2026-10-14T10:00:00Z", end_reason: "paused" },
      { job_id: "a", machine_id: null, started_at: "0", ended_at: "2026-10-14T09:00:00Z", end_reason: "to_machine" },
      { job_id: "b", machine_id: null, started_at: "1", ended_at: null, end_reason: null },
    ]);
    expect(facts.get("a")).toMatchObject({ hasRuns: true, openMachines: [], benchOpen: false, lastEnd: "paused", lastMachines: [MILL, LATHE], lastBench: false });
    expect(facts.get("b")).toMatchObject({ benchOpen: true, lastEnd: null });
    expect(facts.get("c")).toBeUndefined();
  });

  it("092: a job stopped by an admin's Release machine says who released it and why, on the board as on the job time rows", () => {
    const ADMIN = "admin-1";
    const runs = [
      { job_id: "a", machine_id: MILL, started_at: "1", ended_at: "2026-10-22T13:55:05.123+00:00", end_reason: "admin_released", ended_by: ADMIN },
      { job_id: "b", machine_id: LATHE, started_at: "1", ended_at: "2026-10-22T10:00:00+00:00", end_reason: "paused", ended_by: "op-1" },
    ];
    // The reason is on the job time the release ended (same instant, any timestamp spelling); other sessions are ignored.
    const sessions = [
      { job_id: "a", ended_at: "2026-10-22T13:55:05.123Z", end_reason: "Forgot to finish" },
      { job_id: "a", ended_at: "2026-10-22T09:00:00Z", end_reason: "An older release" },
      { job_id: "b", ended_at: "2026-10-22T10:00:00Z", end_reason: "Not a release" },
    ];
    const withReasons = withReleaseReasons(runs, sessions);
    expect(withReasons[0]).toMatchObject({ release_reason: "Forgot to finish" });
    expect(withReasons[1]).not.toHaveProperty("release_reason");
    expect(withReleaseReasons(runs, null)).toBe(runs); // before 092, or not readable
    const facts = runFactsByJob(withReasons);
    expect(facts.get("a")).toMatchObject({ lastEnd: "admin_released", lastEndedBy: ADMIN, lastReleaseReason: "Forgot to finish" });
    expect(facts.get("b")).toMatchObject({ lastEnd: "paused", lastEndedBy: "op-1", lastReleaseReason: null });
    const people = { [ADMIN]: "Sam Admin" };
    expect(releaseFacts(facts.get("a")!, people)).toEqual({ releasedBy: "Sam Admin", releaseReason: "Forgot to finish" });
    expect(releaseFacts(facts.get("b")!, people)).toEqual({ releasedBy: null, releaseReason: null });
    expect(releaseFacts({ lastEnd: "admin_released", lastEndedBy: "someone-else", lastReleaseReason: null }, people)).toEqual({ releasedBy: null, releaseReason: null });
    const idle = pendingRunView({ jobId: "a", machines: [], bench: false }, []);
    const job = { job_no: "J-0010", started_at: "2026-10-22T13:03:46Z" };
    expect(playState(job, { viewer: false }, idle, { hasRuns: true, lastEnd: "admin_released", ...releaseFacts(facts.get("a")!, people) }))
      .toMatchObject({ kind: "stopped_admin", label: "Resume", status: "Stopped by Sam Admin: Forgot to finish" });
    // As much as is known: the name only (another person's time, not readable), the reason only, or neither (the wording before 092).
    expect(adminStopText("Sam Admin", null)).toBe("Stopped by Sam Admin (machine released)");
    expect(adminStopText(null, "  Forgot to finish ")).toBe("Stopped (machine released by admin): Forgot to finish");
    expect(adminStopText(" ", "")).toBe("Stopped (machine released by admin)");
  });
});

describe("executeRunStartOp (R3.3): never strips the bench choice or the check", () => {
  const stub = (answer: { data?: unknown; error?: { message: string; code?: string; hint?: string } | null }) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return { calls, client: { rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }); } } };
  };

  it("PGRST202 and 42883: blocked, after exactly one call that carried p_bench: true", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const { calls, client } = stub({ error: { code, message: "Could not find the function" } });
      const op = runStart({ machines: [], bench: true });
      expect(await executeRunStartOp(op, client)).toEqual({ status: "blocked", code: "server_upgrade_needed", reason: "Waiting: Tolra needs updating before this Start can sync. Nothing was lost." });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ fn: "start_machine_run", args: expect.objectContaining({ p_job: "job-1", p_machines: [], p_bench: true }) });
    }
  });

  it("sends p_bench only for a bench Start and p_paused_ack only when there is one", () => {
    expect(Object.keys(runStartArgs(runStart()))).toEqual(["p_job", "p_machines", "p_client_op_id", "p_started_at", "p_override", "p_reason"]);
    expect(runStartArgs(runStart({ pausedAck: [{ machine_id: MILL, paused_run_id: "r" }] }))).toMatchObject({ p_paused_ack: [{ machine_id: MILL, paused_run_id: "r" }] });
  });

  it("an answer without the bench run, or without a machine, is never applied (a conflict that opened nothing)", async () => {
    const noBench = await executeRunStartOp(runStart({ machines: [], bench: true }), stub({ data: { runs: [], bench_run: null, bench_skipped: "on_machine" } }).client);
    expect(noBench).toMatchObject({ status: "conflict", code: "runs_missing", opened: false });
    const noMachine = await executeRunStartOp(runStart({ machines: [MILL, LATHE] }), stub({ data: { runs: [{ machine_id: MILL, run_id: "r" }] } }).client);
    expect(noMachine).toMatchObject({ status: "conflict", opened: false });
    expect(requestedRunsPresent({ machines: [MILL], bench: false }, { runs: [{ machine_id: MILL, run_id: "r" }] })).toBe(true);
    expect(missingRunsReason({ jobNo: "J-1", machines: [], bench: true }, { bench_skipped: "on_machine" })).toMatch(/running on a machine/);
    const ok = await executeRunStartOp(runStart({ machines: [], bench: true }), stub({ data: { runs: [], bench_run: { run_id: "b", already: false } } }).client);
    expect(ok).toEqual({ status: "applied" });
    const timed = await executeRunStartOp(runStart(), stub({ data: { runs: [{ machine_id: MILL, run_id: "r" }], time_conflicts: [{ machine_id: MILL, what: "start", why: "before_last_run_end", device_at: "a", used_at: "b" }] } }).client);
    expect(timed).toMatchObject({ status: "conflict", code: "time_conflict", opened: true });
  });

  it("refusals are held with their code; machine_in_use keeps the job's start and opened nothing; a network error stays queued", async () => {
    for (const hint of ["paused_ack_invalid", "bench_with_machines", "client_op_reused"]) {
      expect(await executeRunStartOp(runStart(), stub({ error: { code: "22023", hint, message: "m" } }).client)).toMatchObject({ status: "rejected", code: hint });
    }
    let kept = 0;
    const clash = await executeRunStartOp(runStart(), stub({ error: { code: "42501", hint: "machine_in_use", message: "Mill is in use" } }).client, async () => { kept += 1; return { status: "applied" }; });
    expect(clash).toMatchObject({ status: "conflict", code: "machine_in_use", opened: false });
    expect(kept).toBe(1);
    expect(await executeRunStartOp(runStart(), stub({ error: { code: "42501", hint: "job_finished", message: "m" } }).client)).toMatchObject({ status: "rejected", code: "job_finished" });
    expect(await executeRunStartOp(runStart(), stub({ error: { code: "", message: "TypeError: Failed to fetch" } }).client)).toEqual({ status: "network" });
    expect(await executeRunPauseOp(runPause(), stub({ data: { ended: [] } }).client)).toEqual({ status: "applied" });
  });
});

describe("drain (R3.3, R3.4)", () => {
  it("blocked: the entry stays (op unchanged, marked), the same job's later entries are skipped, other jobs carry on; the next pass retries it", async () => {
    const start = runStart({ machines: [], bench: true });
    await enqueue(alice, start);
    await enqueue(alice, runPause());
    await enqueue(alice, { kind: "worksheet", jobId: "job-2", jobNo: "J-200", worksheet: {}, baseVersion: 1 });
    const seen: string[] = [];
    const result = await replayOutbox(alice, async (op) => {
      seen.push(op.kind);
      return op.kind === "run_start" ? { status: "blocked", code: "server_upgrade_needed", reason: "Waiting" } : { status: "applied" };
    });
    expect(seen).toEqual(["run_start", "worksheet"]);
    expect(result).toMatchObject({ applied: 1, blocked: 1, remaining: 2 });
    const left = await pendingEntries(alice);
    expect(left.map((e) => e.op.kind)).toEqual(["run_start", "run_pause"]);
    expect(left[0].op).toEqual(start);
    expect(left[0].blocked).toMatchObject({ code: "server_upgrade_needed", reason: "Waiting" });
    expect(left[0].inFlight).toBeUndefined();
    // Updated server: both go, in order.
    const order: string[] = [];
    expect(await replayOutbox(alice, async (op) => { order.push(op.kind); return { status: "applied" }; })).toMatchObject({ applied: 2, blocked: 0, remaining: 0 });
    expect(order).toEqual(["run_start", "run_pause"]);
  });

  it("a Pause captured after a pending Start belongs to it: refused Start -> the Pause is held start_refused, never sent", async () => {
    const start = runStart();
    await enqueue(alice, start);
    await enqueue(alice, runPause());
    await enqueue(alice, runPause({ jobRef: "job-3", jobNo: "J-300" })); // another job's Pause: unaffected
    const pause = (await pendingEntries(alice))[1].op as RunPauseOp;
    expect(pause.afterStart).toBe(start.clientOpId);
    expect(((await pendingEntries(alice))[2].op as RunPauseOp).afterStart).toBeNull();
    const sent: string[] = [];
    const outcome: ReplayOutcome = { status: "conflict", code: "machine_in_use", opened: false, reason: "Mill taken" };
    await replayOutbox(alice, async (op) => { sent.push(`${op.kind}:${op.jobNo}`); return op.kind === "run_start" ? outcome : { status: "applied" }; });
    expect(sent).toEqual(["run_start:J-123", "run_pause:J-300"]);
    const rejected = await rejectedEntries(alice);
    expect(rejected).toEqual([expect.objectContaining({ code: START_REFUSED, reason: "Not sent: the Start before it (J-123 on the machine) was refused, so there was nothing of yours to pause.", op: pause })]);
    expect(await conflictEntries(alice)).toHaveLength(1);
    expect(await pendingEntries(alice)).toEqual([]);
  });

  it("a Start held only for its times (it opened its runs) lets its Pause through", async () => {
    await enqueue(alice, runStart());
    await enqueue(alice, runPause());
    const sent: string[] = [];
    await replayOutbox(alice, async (op) => { sent.push(op.kind); return op.kind === "run_start" ? { status: "conflict", code: "time_conflict", opened: true, reason: "times" } : { status: "applied" }; });
    expect(sent).toEqual(["run_start", "run_pause"]);
    expect(await rejectedEntries(alice)).toEqual([]);
  });

  it("a rejected Start takes its Pause out too; the same Start or Pause queued twice stays one entry", async () => {
    const start = runStart();
    await enqueue(alice, start);
    await enqueue(alice, start);
    await enqueue(alice, runPause());
    expect(await pendingEntries(alice)).toHaveLength(2);
    await replayOutbox(alice, async () => ({ status: "rejected", code: "paused_ack_invalid", reason: "stale" }));
    expect((await rejectedEntries(alice)).map((e) => e.code)).toEqual(["paused_ack_invalid", START_REFUSED]);
  });
});
