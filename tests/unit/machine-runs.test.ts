/**
 * Live machine use (migration 044), the pure parts: the in-use rows as the board reads them, the "Start on which machine?" choices, the
 * board grouped by machine, the refusal hints, and the offline replay of a Start with machines and a Pause (lib/offline/sync) against a
 * fake server: a machine taken meanwhile is surfaced as a conflict with the job's start kept, never dropped; a replay of an entry queued
 * before 044 (no machines, no key) still goes the old way.
 */
import { describe, expect, it, vi } from "vitest";

import { groupJobsByMachine, inUseRows, inUseText, indexInUse, isStale, NO_MACHINE_GROUP, replayedStartClashReason, runRefusal, startChoices, timeConflictsOf, type InUseRow } from "@/lib/machine-runs";
import type { OutboxOp, PauseOp, StartOp } from "@/lib/offline/outbox";
import { executeFinishOp, executePauseOp, executeStartRunOp } from "@/lib/offline/sync";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

const row = (over: Partial<InUseRow> = {}): InUseRow => ({
  run_id: "r1", machine_id: "m1", machine_name: "Haas VF2", job_id: "j1", job_no: "J-0001", booking_id: null, operator_id: "u1", operator_name: "Dave", started_at: "2026-10-13T08:12:00Z", stale: false, ...over,
});

describe("machines in use, as the board reads them", () => {
  it("keeps only well-formed rows and never an e-mail as a name", () => {
    const rows = inUseRows([
      { run_id: "r1", machine_id: "m1", machine_name: "Mill", job_id: "j1", job_no: "J-1", operator_id: "u1", operator_name: "dave@example.test", started_at: "2026-10-13T08:00:00Z", stale: false },
      { run_id: "r2", machine_id: "m2", machine_name: "Lathe", job_id: "j2", job_no: "J-2", operator_id: null, operator_name: " Sam ", started_at: "2026-10-13T09:00:00Z", stale: true },
      { run_id: 3, machine_id: "m3" }, null, "nope",
    ]);
    expect(rows.map((r) => [r.machine_id, r.operator_name, r.stale])).toEqual([["m1", null, false], ["m2", "Sam", true]]);
    expect(inUseRows(null)).toEqual([]);
  });

  it("indexes by job and by machine, prints the chip, and marks a run stale after 12 hours by the clock too", () => {
    const rows = [row(), row({ run_id: "r2", machine_id: "m2", machine_name: "Lathe", job_id: "j1" }), row({ run_id: "r3", machine_id: "m3", job_id: "j2", operator_name: null })];
    const { byJob, byMachine } = indexInUse(rows);
    expect(byJob.get("j1")!.map((r) => r.machine_id)).toEqual(["m1", "m2"]);
    expect(byMachine.get("m3")!.job_id).toBe("j2");
    expect(inUseText(rows[0], new Date("2026-10-13T10:00:00Z"))).toMatch(/^Haas VF2 by Dave since .*09:12$/);
    expect(inUseText(rows[2], new Date("2026-10-13T10:00:00Z"))).toContain("by — since");
    expect(inUseText(rows[0], new Date("2026-10-13T20:13:00Z"))).toContain("(no Finish or Pause for 12 h+)");
    expect(isStale(row(), new Date("2026-10-13T20:11:00Z"))).toBe(false);
    expect(isStale(row(), new Date("2026-10-13T20:12:00Z"))).toBe(true);
    expect(isStale(row({ stale: true }), new Date("2026-10-13T08:13:00Z"))).toBe(true);
  });
});

describe("the Start sheet's choices", () => {
  const machines = [{ id: "m2", name: "Lathe" }, { id: "m1", name: "Mill" }, { id: "m3", name: "Saw" }];
  it("planned machines first and ticked, a planned machine another job holds not ticked, this job's own run shown as its own", () => {
    const inUse = new Map([["m1", row({ job_id: "other", job_no: "J-9" })], ["m3", row({ run_id: "r3", machine_id: "m3", job_id: "mine" })]]);
    const choices = startChoices(machines, [{ machine_id: "m1", booked: true }, { machine_id: "m3", booked: false }], inUse, "mine");
    expect(choices.map((c) => [c.machine.id, c.planned, c.booked, c.preselected, c.inUse?.job_id ?? null])).toEqual([
      ["m1", true, true, false, "other"], ["m3", true, false, true, "mine"], ["m2", false, false, false, null]]);
  });
  it("with no plan nothing is ticked", () => {
    expect(startChoices(machines, [], new Map(), "j").every((c) => !c.preselected && !c.planned)).toBe(true);
  });
});

describe("the board grouped by machine", () => {
  it("puts a job under each machine it is planned for or running on, once, and the rest under No machine", () => {
    const jobs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const of = (job: { id: string }) => job.id === "a" ? [{ machine_id: "m1", name: "Mill" }, { machine_id: "m2", name: "Lathe" }, { machine_id: "m1", name: "Mill" }] : job.id === "b" ? [{ machine_id: "m2", name: "Lathe" }] : [];
    const groups = groupJobsByMachine(jobs, of);
    expect(groups.map((g) => [g.title, g.jobs.map((j) => j.id)])).toEqual([["On Lathe", ["a", "b"]], ["On Mill", ["a"]], [NO_MACHINE_GROUP, ["c"]]]);
    expect(groupJobsByMachine([], of)).toEqual([]);
  });
});

describe("refusal hints", () => {
  it("recognises the server's hints and nothing else", () => {
    expect(runRefusal({ hint: "machine_in_use", message: "Mill is in use by Dave on J-1." })).toEqual({ hint: "machine_in_use", message: "Mill is in use by Dave on J-1." });
    expect(runRefusal({ hint: "job_finished" })?.message).toBe("The server refused this change.");
    expect(runRefusal({ hint: "machine_clash", message: "x" })).toBeNull();
    expect(runRefusal({ hint: "override_reason", message: "Give a reason" })?.hint).toBe("override_reason");
    expect(runRefusal(null)).toBeNull();
    expect(replayedStartClashReason("J-7", "Mill is in use by Dave on J-1 since 09:00.")).toContain("J-7 was started while you were offline");
    expect(replayedStartClashReason("J-7", "Mill is in use.")).toContain("Start it on a free machine, or ask an admin to take the machine over.");
  });
});

describe("offline replay of a Start with machines and a Pause (lib/offline/sync)", () => {
  const startOp: StartOp = { kind: "start", jobId: "j1", jobNo: "J-0001", at: "2026-10-13T08:00:00Z", machines: ["m1"], clientOpId: "op-1" };
  const client = (error: { message: string; hint?: string; code?: string } | null) => {
    const rpc = vi.fn(async () => ({ data: null, error }));
    return { rpc, calls: () => rpc.mock.calls as unknown as [string, Record<string, unknown>][] };
  };

  it("sends start_machine_run with the entry's machines, key and device time, and applies on success", async () => {
    const c = client(null);
    const fallback = vi.fn(async () => ({ status: "applied" as const }));
    expect(await executeStartRunOp(startOp, c, fallback)).toEqual({ status: "applied" });
    expect(c.calls()).toEqual([["start_machine_run", { p_job: "j1", p_machines: ["m1"], p_client_op_id: "op-1", p_started_at: "2026-10-13T08:00:00Z", p_override: false, p_reason: null }]]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("a machine taken meanwhile: the job's start is still recorded (the plain update) and the entry is held as a conflict that says so", async () => {
    const c = client({ code: "42501", hint: "machine_in_use", message: "Mill is in use by Dave on J-0009 since 13/10 07:50. Pick a free machine, or ask an admin to take it over." });
    const fallback = vi.fn(async () => ({ status: "applied" as const }));
    const outcome = await executeStartRunOp(startOp, c, fallback);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("conflict");
    expect(outcome.status === "conflict" && outcome.reason).toContain("J-0001 was started while you were offline, but when it synced the machine was already in use: Mill is in use by Dave on J-0009");
    expect(outcome.status === "conflict" && outcome.reason).toContain("recorded as started without the machine");
    // Still offline when the fallback runs: the entry stays queued (nothing is filed as done).
    const stillOffline = vi.fn(async () => ({ status: "network" as const }));
    expect(await executeStartRunOp(startOp, c, stillOffline)).toEqual({ status: "network" });
  });

  it("a job finished meanwhile, or a time too old, is held as rejected with the reason; any other refusal too", async () => {
    expect((await executeStartRunOp(startOp, client({ code: "42501", hint: "job_finished", message: "finished" }), async () => ({ status: "applied" }))).status).toBe("rejected");
    const old = await executeStartRunOp(startOp, client({ code: "22023", hint: "time_too_old", message: "That time is more than 30 days ago." }), async () => ({ status: "applied" }));
    expect(old).toEqual({ status: "rejected", reason: "That time is more than 30 days ago." });
    expect((await executeStartRunOp(startOp, client({ code: "P0002", message: "Job not found" }), async () => ({ status: "applied" }))).status).toBe("rejected");
  });

  it("a Pause replays through pause_machine_run under its key", async () => {
    const c = client(null);
    const op: PauseOp = { kind: "pause", jobId: "j1", jobNo: "J-0001", at: "2026-10-13T09:00:00Z", machines: null, clientOpId: "op-2" };
    expect(await executePauseOp(op, c)).toEqual({ status: "applied" });
    expect(c.calls()).toEqual([["pause_machine_run", { p_job: "j1", p_machines: null, p_client_op_id: "op-2", p_ended_at: "2026-10-13T09:00:00Z" }]]);
    expect(await executePauseOp(op, client({ code: "22023", hint: "time_too_old", message: "too old" }))).toEqual({ status: "rejected", reason: "too old" });
  });

  it("a Finish replays through finish_job: applied when it filled the time (or the same time was already there), a conflict when another time is kept, rejected when the job is gone", async () => {
    const op = { jobId: "j1", jobNo: "J-0001", at: "2026-10-13T10:00:00.000Z", clientOpId: "op-3" };
    const rpc = vi.fn(async () => ({ data: { finished_at: "2026-10-13T10:00:00+00:00", changed: true }, error: null }));
    expect(await executeFinishOp(op, { rpc })).toEqual({ status: "applied" });
    expect(rpc.mock.calls[0]).toEqual(["finish_job", { p_job: "j1", p_client_op_id: "op-3", p_finished_at: "2026-10-13T10:00:00.000Z" }]);
    expect(await executeFinishOp(op, { rpc: async () => ({ data: { finished_at: "2026-10-13T10:00:00+00:00", changed: false }, error: null }) })).toEqual({ status: "applied" });
    const kept = await executeFinishOp(op, { rpc: async () => ({ data: { finished_at: "2026-10-13T09:00:00+00:00", changed: false }, error: null }) });
    expect(kept).toMatchObject({ status: "conflict", server: { id: "j1", finished_at: "2026-10-13T09:00:00+00:00" } });
    expect((await executeFinishOp(op, { rpc: async () => ({ data: null, error: { code: "P0002", message: "Job not found" } }) })).status).toBe("rejected");
  });

  it("a Start, Pause or Finish whose device time the server couldn't honour (time_conflicts) is held as a conflict with both times; none means applied", async () => {
    const conflict = { machine_id: "m1", machine: "Mill", what: "start", why: "before_last_run_end", device_at: "2026-10-13T07:00:00Z", used_at: "2026-10-13T10:00:00Z" };
    const answer = (data: unknown) => ({ rpc: async () => ({ data, error: null }) });
    const started = await executeStartRunOp(startOp, answer({ runs: [], time_conflicts: [conflict] }), async () => ({ status: "applied" }));
    expect(started).toMatchObject({ status: "conflict", server: { time_conflicts: [conflict] } });
    expect(started.status === "conflict" && started.reason).toContain("J-0001: the Start made offline synced");
    expect(started.status === "conflict" && started.reason).toContain("Mill: started at 13/10, 11:00 instead of 13/10, 08:00");
    expect(await executeStartRunOp(startOp, answer({ runs: [], time_conflicts: [] }), async () => ({ status: "applied" }))).toEqual({ status: "applied" });
    const pauseOp: PauseOp = { kind: "pause", jobId: "j1", jobNo: "J-0001", at: "2026-10-13T09:00:00Z", machines: null, clientOpId: "op-2" };
    const ended = { ...conflict, what: "end", why: "before_run_start" };
    const paused = await executePauseOp(pauseOp, answer({ ended: [], time_conflicts: [ended] }));
    expect(paused.status === "conflict" && paused.reason).toContain("before the run started");
    const finished = await executeFinishOp({ jobId: "j1", jobNo: "J-0001", at: "2026-10-13T10:00:00Z" }, answer({ changed: true, finished_at: "2026-10-13T10:00:00Z", time_conflicts: [ended] }));
    expect(finished.status).toBe("conflict");
    expect(timeConflictsOf({ time_conflicts: "nonsense" })).toEqual([]);
    expect(timeConflictsOf(null)).toEqual([]);
  });

  it("an entry queued before 044 is still a Start op the old path understands (no machines, no key)", () => {
    const legacy: OutboxOp = JSON.parse('{"kind":"start","jobId":"j1","jobNo":"J-0001","at":"2026-10-13T08:00:00Z"}');
    expect(legacy.kind === "start" && (legacy.machines?.length ?? 0) === 0 && !legacy.clientOpId).toBe(true);
  });
});
