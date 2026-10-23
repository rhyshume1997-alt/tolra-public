/**
 * Pause for bench jobs (migration 046), the client's pure parts: the bench rows the board reads (bench_runs_state), Running / Paused per job,
 * the board's own copy after an offline Start, Pause or Finish, how a bench Start came out, Start that resumes a Paused job
 * (lib/job-actions), the time-conflict wording for the bench, and the offline replay of a bench Start (lib/offline/sync) against a fake
 * server: applied when it started or resumed the job, held as a conflict when someone started the job another way at another time,
 * rejected (nothing changed) when the job was on a machine. Bench -> machine: the board reports the job on the machine, never Paused.
 */
import { describe, expect, it, vi } from "vitest";

import { benchStartCheck, startCheck } from "@/lib/job-actions";
import { benchAfter, benchRows, benchStartOutcome, benchState, runRefusal, runTimeConflictReason, type BenchRow } from "@/lib/machine-runs";
import type { StartOp } from "@/lib/offline/outbox";
import { executePauseOp, executeStartRunOp } from "@/lib/offline/sync";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

/** A row as bench_runs_state returns it; its state follows from the facts unless given. */
const row = (over: Partial<BenchRow> = {}): BenchRow => benchRows([{
  job_id: "j1", run_id: "r1", is_open: true, started_at: "2026-10-13T08:00:00Z", ended_at: null, end_reason: null, operator_id: "u1", operator_name: "Dave", ...over,
}])[0];

describe("bench runs as the board reads them", () => {
  it("keeps only well-formed rows and never an e-mail as a name", () => {
    const rows = benchRows([
      { job_id: "j1", run_id: "r1", is_open: true, started_at: "2026-10-13T08:00:00Z", ended_at: null, end_reason: null, operator_id: "u1", operator_name: "dave@example.test" },
      { job_id: "j2", run_id: "r2", is_open: false, started_at: "2026-10-13T08:00:00Z", ended_at: "2026-10-13T09:00:00Z", end_reason: "paused", operator_id: null, operator_name: " Sam " },
      { job_id: 3, run_id: "r3" }, null, "nope",
    ]);
    expect(rows.map((r) => [r.job_id, r.is_open, r.end_reason, r.operator_name])).toEqual([["j1", true, null, null], ["j2", false, "paused", "Sam"]]);
    expect(benchRows(undefined)).toEqual([]);
  });

  it("Running while a bench run is open, Paused after a Pause, nothing for a finished job or a run ended otherwise", () => {
    expect(benchState(row(), {})).toBe("running");
    expect(benchState(row({ is_open: false, ended_at: "2026-10-13T09:00:00Z", end_reason: "paused" }), {})).toBe("paused");
    expect(benchState(row({ is_open: false, end_reason: "finished" }), {})).toBeNull();
    expect(benchState(row(), { finished_at: "2026-10-13T10:00:00Z" })).toBeNull();
    expect(benchState(undefined, {})).toBeNull();
  });

  it("the job's actual active work: on a machine (from the server's state or the live machine runs) is never Paused or on the bench; Paused after a move to a machine whose runs ended", () => {
    const moved = { is_open: false, ended_at: "2026-10-13T09:00:00Z", end_reason: "to_machine" };
    expect(row({ ...moved, on_machine: true }).state).toBe("on_machine");
    expect(benchState(row({ ...moved, on_machine: true }), {})).toBe("on_machine");
    expect(benchState(row({ ...moved, state: "on_machine" } as Partial<BenchRow>), {})).toBe("on_machine");
    // A stale row (still open, or paused) loses to the board's live machine runs.
    expect(benchState(row(), {}, true)).toBe("on_machine");
    expect(benchState(row({ is_open: false, end_reason: "paused" }), {}, true)).toBe("on_machine");
    // The machine runs ended (Pause): Paused, Start resumes on the bench.
    expect(row(moved).state).toBe("paused");
    expect(benchState(row(moved), {})).toBe("paused");
    // The server's state column wins over the facts; an unknown state falls back to them.
    expect(benchRows([{ job_id: "j1", run_id: "r1", is_open: false, started_at: "2026-10-13T08:00:00Z", end_reason: "paused", state: "on_machine", on_machine: true }])[0].state).toBe("on_machine");
    expect(benchRows([{ job_id: "j1", run_id: "r1", is_open: true, started_at: "2026-10-13T08:00:00Z", state: "bogus" }])[0].state).toBe("on_bench");
  });

  it("the board's copy after an offline Start on a machine: the open bench run ends 'to_machine', the job shows on the machine; a bench Start then changes nothing; a Pause makes it Paused", () => {
    const at = "2026-10-13T10:00:00Z";
    let rows = benchAfter([], "j1", "start", "2026-10-13T09:00:00Z", "u1");
    rows = benchAfter(rows, "j1", "machine", at);
    expect(rows).toEqual([expect.objectContaining({ is_open: false, ended_at: at, end_reason: "to_machine", on_machine: true, state: "on_machine" })]);
    expect(benchState(rows[0], {})).toBe("on_machine");
    expect(benchAfter(rows, "j1", "start", "2026-10-13T10:05:00Z")).toBe(rows);
    expect(benchAfter([], "j9", "machine", at)).toEqual([]);
    rows = benchAfter(rows, "j1", "pause", "2026-10-13T11:00:00Z");
    expect(rows).toEqual([expect.objectContaining({ end_reason: "to_machine", ended_at: at, on_machine: false, state: "paused" })]);
    expect(benchState(rows[0], {})).toBe("paused");
  });

  it("the board's copy after an offline Start, Pause and Finish: one row per job, a Start on a running job changes nothing", () => {
    const at = "2026-10-13T10:00:00Z";
    let rows = benchAfter([], "j1", "start", at, "u1");
    expect(rows).toEqual([expect.objectContaining({ job_id: "j1", is_open: true, started_at: at, operator_id: "u1" })]);
    expect(benchAfter(rows, "j1", "start", "2026-10-13T10:05:00Z")).toBe(rows);
    rows = benchAfter(rows, "j1", "pause", "2026-10-13T11:00:00Z");
    expect(rows).toEqual([expect.objectContaining({ job_id: "j1", is_open: false, end_reason: "paused", ended_at: "2026-10-13T11:00:00Z" })]);
    expect(benchState(rows[0], {})).toBe("paused");
    // A Pause with nothing on the bench changes nothing; a resume opens a new row; Finish removes it.
    expect(benchAfter(rows, "j1", "pause", "2026-10-13T11:30:00Z")).toBe(rows);
    rows = benchAfter(rows, "j1", "start", "2026-10-13T12:00:00Z");
    expect(rows.map((r) => [r.job_id, r.is_open, r.started_at])).toEqual([["j1", true, "2026-10-13T12:00:00Z"]]);
    expect(benchAfter([...rows, row({ job_id: "j2" })], "j1", "finish", at).map((r) => r.job_id)).toEqual(["j2"]);
  });

  it("how a bench Start came out, from start_machine_run's answer", () => {
    expect(benchStartOutcome({ job_start_stamped: true, bench_run: { run_id: "r1", already: false } })).toBe("started");
    expect(benchStartOutcome({ job_start_stamped: false, bench_run: { run_id: "r2", already: false } })).toBe("resumed");
    expect(benchStartOutcome({ job_start_stamped: false, bench_run: { run_id: "r1", already: true } })).toBe("running");
    expect(benchStartOutcome({ job_start_stamped: false, bench_run: null, bench_skipped: "started_without_bench" })).toBe("already_started");
    expect(benchStartOutcome({ job_start_stamped: false, bench_run: null, bench_skipped: "on_machine" })).toBe("on_machine");
    // An answer from before 046 (no bench fields): stamped means started, else the recorded time was kept.
    expect(benchStartOutcome({ started_at: "2026-10-13T08:00:00Z" })).toBe("already_started");
    expect(benchStartOutcome(null)).toBe("already_started");
  });

  it("Start resumes a Paused bench job (never for a viewer, a finished or inspected job, or one in rework); otherwise Start is as before", () => {
    const started = { started_at: "2026-10-13T08:00:00Z", stage: "machining" };
    expect(benchStartCheck(started, { viewer: false }, true)).toEqual({ shown: true, enabled: true, reason: "" });
    expect(benchStartCheck(started, { viewer: false }, false)).toEqual(startCheck(started, { viewer: false }));
    expect(benchStartCheck(started, { viewer: true }, true).shown).toBe(false);
    expect(benchStartCheck({ ...started, finished_at: "2026-10-13T09:00:00Z" }, { viewer: false }, true).enabled).toBe(false);
    expect(benchStartCheck({ ...started, inspected_at: "2026-10-13T09:00:00Z" }, { viewer: false }, true).enabled).toBe(false);
    expect(benchStartCheck({ ...started, stage: "rework" }, { viewer: false }, true).shown).toBe(false);
    expect(benchStartCheck({ stage: "machining" }, { viewer: false }, true)).toEqual(startCheck({ stage: "machining" }, { viewer: false }));
  });

  it("the bench refusal hint is recognised, and a bench time conflict says 'the bench', not a machine", () => {
    expect(runRefusal({ hint: "bench_run_open", message: "This job is already running on the bench." })).toEqual({ hint: "bench_run_open", message: "This job is already running on the bench." });
    expect(runRefusal({ hint: "something_else", message: "x" })).toBeNull();
    const reason = runTimeConflictReason("J-0001", "Start", [{ machine_id: null, bench: true, what: "start", why: "before_last_run_end", device_at: "2026-10-13T07:00:00Z", used_at: "2026-10-13T10:00:00Z" }]);
    expect(reason).toContain("the bench: started at 13/10, 11:00 instead of 13/10, 08:00");
    expect(reason).toContain("the job already has bench time recorded after that time");
    expect(reason).toContain("Check the job's bench times.");
    const machine = runTimeConflictReason("J-0001", "Start", [{ machine_id: "m1", machine: "Mill", what: "start", why: "before_last_run_end", device_at: "2026-10-13T07:00:00Z", used_at: "2026-10-13T10:00:00Z" }]);
    expect(machine).toContain("Mill: started at");
    expect(machine).toContain("Check the machine's times.");
    // Bench -> machine with a device time before the bench run started: the bench run's end and the machine's start both say so.
    const moved = runTimeConflictReason("J-0001", "Start", [
      { machine_id: null, bench: true, what: "end", why: "before_run_start", device_at: "2026-10-13T07:00:00Z", used_at: "2026-10-13T10:00:00Z" },
      { machine_id: "m1", machine: "Mill", what: "start", why: "before_bench_run_start", device_at: "2026-10-13T07:00:00Z", used_at: "2026-10-13T10:00:00Z" },
    ]);
    expect(moved).toContain("because the job was on the bench after that time");
    expect(moved).toContain("the bench: ended at 13/10, 11:00 instead of 13/10, 08:00; Mill: started at 13/10, 11:00");
  });
});

describe("offline replay of a bench Start and Pause (lib/offline/sync)", () => {
  const op: StartOp = { kind: "start", jobId: "j1", jobNo: "J-0001", at: "2026-10-13T08:00:00.000Z", machines: [], clientOpId: "op-b1" };
  const answer = (data: unknown, error: { message: string; hint?: string; code?: string } | null = null) => {
    const rpc = vi.fn(async () => ({ data, error }));
    return { rpc, calls: () => rpc.mock.calls as unknown as [string, Record<string, unknown>][] };
  };
  const never = vi.fn(async () => ({ status: "applied" as const }));

  it("sends start_machine_run with no machine, the key and the device time; applied when it started or resumed the job (or it was already running)", async () => {
    const c = answer({ started_at: op.at, job_start_stamped: true, bench_run: { run_id: "r1", already: false }, time_conflicts: [] });
    expect(await executeStartRunOp(op, c, never)).toEqual({ status: "applied" });
    expect(c.calls()).toEqual([["start_machine_run", { p_job: "j1", p_machines: [], p_client_op_id: "op-b1", p_started_at: op.at, p_override: false, p_reason: null }]]);
    expect(await executeStartRunOp(op, answer({ started_at: "2026-10-13T07:00:00Z", job_start_stamped: false, bench_run: { run_id: "r2", already: false }, time_conflicts: [] }), never)).toEqual({ status: "applied" });
    expect(await executeStartRunOp(op, answer({ started_at: "2026-10-13T07:00:00Z", job_start_stamped: false, bench_run: { run_id: "r2", already: true }, time_conflicts: [] }), never)).toEqual({ status: "applied" });
    expect(never).not.toHaveBeenCalled();
  });

  it("a resume whose device time overlapped the job's bench history is held as a conflict that names the bench", async () => {
    const conflict = { machine_id: null, bench: true, what: "start", why: "before_last_run_end", device_at: op.at, used_at: "2026-10-13T10:00:00Z" };
    const out = await executeStartRunOp(op, answer({ started_at: "2026-10-13T07:00:00Z", job_start_stamped: false, bench_run: { run_id: "r2", already: false }, time_conflicts: [conflict] }), never);
    expect(out).toMatchObject({ status: "conflict", server: { time_conflicts: [conflict] } });
    expect(out.status === "conflict" && out.reason).toContain("the bench: started at");
  });

  it("a job someone started meanwhile another way keeps their time: applied when the times agree, else a conflict; gone or finished is rejected", async () => {
    const elsewhere = { started_at: "2026-10-13T07:30:00Z", job_start_stamped: false, bench_run: null, bench_skipped: "started_without_bench", time_conflicts: [] };
    const kept = await executeStartRunOp(op, answer(elsewhere), never);
    expect(kept).toMatchObject({ status: "conflict", server: { id: "j1", started_at: "2026-10-13T07:30:00Z" } });
    expect(kept.status === "conflict" && kept.reason).toBe("This job was already started at a different time while you were offline. Their time is kept.");
    expect(await executeStartRunOp(op, answer({ ...elsewhere, started_at: "2026-10-13T08:00:00+00:00" }), never)).toEqual({ status: "applied" });
    expect(await executeStartRunOp(op, answer(null, { code: "P0002", message: "Job not found" }), never)).toEqual({ status: "rejected", reason: "This job no longer exists or you no longer have access to it." });
    const finished = await executeStartRunOp(op, answer(null, { code: "42501", hint: "job_finished", message: "finished" }), never);
    expect(finished).toEqual({ status: "rejected", reason: "J-0001 was finished before this Start synced, so it wasn't started again." });
    expect((await executeStartRunOp(op, answer(null, { code: "22023", hint: "client_op_reused", message: "reused" }), never))).toEqual({ status: "rejected", reason: "reused" });
    // On a machine when it synced (machine -> bench refused): rejected, nothing changed, never reported as started.
    const onMachine = await executeStartRunOp(op, answer({ started_at: "2026-10-13T07:30:00Z", job_start_stamped: false, bench_run: null, bench_skipped: "on_machine", time_conflicts: [] }), never);
    expect(onMachine).toEqual({ status: "rejected", reason: "J-0001 was running on a machine when this Start synced, so it wasn't started on the bench. Nothing changed." });
    expect(never).not.toHaveBeenCalled();
  });

  it("a bench Pause replays through pause_machine_run under its key (the same as a machine Pause)", async () => {
    const c = answer({ job_id: "j1", ended: [{ run_id: "r1", machine_id: null, end_reason: "paused", time_conflict: false }], time_conflicts: [], replayed: false });
    expect(await executePauseOp({ kind: "pause", jobId: "j1", jobNo: "J-0001", at: "2026-10-13T09:00:00Z", machines: null, clientOpId: "op-b2" }, c)).toEqual({ status: "applied" });
    expect(c.calls()).toEqual([["pause_machine_run", { p_job: "j1", p_machines: null, p_client_op_id: "op-b2", p_ended_at: "2026-10-13T09:00:00Z" }]]);
  });
});
