import { describe, expect, it } from "vitest";

import { type JobBooking, type PlanLink, jobMachineEntries } from "@/lib/job-machine-plan";
import { type RunRow, plannedVsActual } from "@/lib/jobs/planned-vs-actual";

const NOW = new Date("2026-01-01T12:00:00Z");
const names = new Map([["m1", "Mill"], ["m2", "Lathe"], ["m3", "Saw"]]);
const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
const run = (machine_id: string | null, start: number, end: number | null): RunRow => ({ machine_id, started_at: at(start), ended_at: end == null ? null : at(end) });
const entries = (...pairs: [string, number][]) => pairs.map(([machineId, hours]) => ({ machineId, hours }));
const calc = (e: ReturnType<typeof entries>, runs: RunRow[], extra: { labour?: { started_at: string; ended_at: string | null; voided_at?: string | null }[]; jobFinished?: boolean } = {}) =>
  plannedVsActual({ entries: e, runs, labour: extra.labour ?? [], machineNames: names, jobFinished: extra.jobFinished ?? false, now: NOW });

describe("plannedVsActual", () => {
  it("keeps plan order and computes variance", () => {
    const r = calc(entries(["m2", 4], ["m1", 2]), [run("m1", 0, 3), run("m2", 0, 4)]);
    expect(r.steps.map((s) => s.label)).toEqual(["Lathe", "Mill"]);
    const mill = r.steps[1];
    expect(mill).toMatchObject({ plannedHours: 2, actualHours: 3, varianceHours: 1, variancePct: 0.5, status: "over" });
    expect(r.machinePlannedHours).toBe(6);
    expect(r.machineActualHours).toBe(7);
    expect(r.machineVarianceHours).toBe(1);
  });

  it("uses a schedule-adopted booking's hours (via jobMachineEntries)", () => {
    const links: PlanLink[] = [{ machine_id: "m1", estimated_hours: 0, booking_id: null, position: 0 }];
    const bookings: JobBooking[] = [{ id: "b1", machineId: "m1", jobId: "j1", estimatedHours: 6.5, status: "booked", startAt: at(1) }];
    const r = calc(jobMachineEntries("j1", links, bookings), []);
    expect(r.steps[0]).toMatchObject({ plannedHours: 6.5, status: "not_started" });
  });

  it("sums a machine on the plan twice into one step", () => {
    const r = calc(entries(["m1", 2], ["m1", 3]), [run("m1", 0, 5)]);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ plannedHours: 5, actualHours: 5, status: "on_plan" });
  });

  it("a run on a machine not on the plan is a no_plan step", () => {
    const r = calc(entries(["m1", 2]), [run("m3", 0, 1)]);
    const extra = r.steps[1];
    expect(extra).toMatchObject({ label: "Saw (Not on plan)", plannedHours: null, varianceHours: null, variancePct: null, status: "no_plan", onPlan: false });
    expect(r.machineActualHours).toBe(1);
    expect(r.machinePlannedHours).toBe(2);
  });

  it("unplanned machine time is in the total, on its own, and never in a planned machine's actual or variance (PM ruling 12 Nov)", () => {
    const r = calc(entries(["m1", 2], ["m2", 4]), [run("m1", 0, 2), run("m2", 0, 4), run("m3", 0, 3), run(null, 0, 1)]);
    const [mill, lathe, saw] = r.steps;
    // Planned machines carry only their own runs: no unplanned hours in actual, variance or status.
    expect(mill).toMatchObject({ label: "Mill", onPlan: true, plannedHours: 2, actualHours: 2, varianceHours: 0, status: "on_plan" });
    expect(lathe).toMatchObject({ label: "Lathe", onPlan: true, plannedHours: 4, actualHours: 4, varianceHours: 0, status: "on_plan" });
    // Its own line, with no plan, variance or over/under status.
    expect(saw).toMatchObject({ label: "Saw (Not on plan)", onPlan: false, isBench: false, actualHours: 3, plannedHours: null, varianceHours: null, status: "no_plan" });
    expect(r.unplannedActualHours).toBe(3);
    // In the total actual (planned 6 + unplanned 3); bench stays separate as before.
    expect(r.machineActualHours).toBe(9);
    expect(r.machinePlannedHours).toBe(6);
    expect(r.benchActualHours).toBe(1);
    expect(r.steps.filter((s) => s.onPlan).reduce((sum, s) => sum + s.actualHours, 0)).toBe(6);
  });

  it("no unplanned machine time when every run is on a planned machine", () => {
    expect(calc(entries(["m1", 2]), [run("m1", 0, 1), run(null, 0, 1)]).unplannedActualHours).toBe(0);
  });

  it("bench runs make a Bench step with no plan, excluded from machine totals", () => {
    const r = calc(entries(["m1", 2]), [run("m1", 0, 2), run(null, 0, 3)]);
    const bench = r.steps[r.steps.length - 1];
    expect(bench).toMatchObject({ label: "Bench", isBench: true, plannedHours: null, actualHours: 3, status: "no_plan" });
    expect(r.machineActualHours).toBe(2);
    expect(r.benchActualHours).toBe(3);
  });

  it("no Bench step without bench runs", () => {
    expect(calc(entries(["m1", 2]), []).steps.some((s) => s.isBench)).toBe(false);
  });

  it("counts an open run to the injected now and marks it running", () => {
    const r = calc(entries(["m1", 4]), [run("m1", 10, null)]);
    expect(r.steps[0]).toMatchObject({ actualHours: 2, running: true });
  });

  it("ignores zero, negative and invalid runs", () => {
    const r = calc(entries(["m1", 4]), [run("m1", 5, 5), run("m1", 6, 4), { machine_id: "m1", started_at: "nonsense", ended_at: null }, { machine_id: "m1", started_at: at(0), ended_at: "bad" }]);
    expect(r.steps[0]).toMatchObject({ actualHours: 0, running: false, status: "not_started" });
  });

  it("tolerance: exactly +10% is on_plan, just over is over", () => {
    expect(calc(entries(["m1", 10]), [run("m1", 0, 11)]).steps[0].status).toBe("on_plan");
    expect(calc(entries(["m1", 10]), [{ machine_id: "m1", started_at: at(0), ended_at: new Date(Date.UTC(2026, 0, 1, 11, 0, 1)).toISOString() }]).steps[0].status).toBe("over");
  });

  it("under only when the job is finished", () => {
    const runs = [run("m1", 0, 5)];
    expect(calc(entries(["m1", 10]), runs, { jobFinished: false }).steps[0].status).toBe("on_plan");
    expect(calc(entries(["m1", 10]), runs, { jobFinished: true }).steps[0].status).toBe("under");
    expect(calc(entries(["m1", 10]), [run("m1", 0, 9)], { jobFinished: true }).steps[0].status).toBe("on_plan");
  });

  it("labour excludes voided sessions and counts an open one to now", () => {
    const r = calc([], [], { labour: [
      { started_at: at(0), ended_at: at(2) },
      { started_at: at(0), ended_at: at(5), voided_at: at(6) },
      { started_at: at(10), ended_at: null },
    ] });
    expect(r.labourActualHours).toBe(4);
  });

  it("variancePct is null for a plan of 0", () => {
    const r = calc(entries(["m1", 0]), [run("m1", 0, 1)]);
    expect(r.steps[0]).toMatchObject({ plannedHours: 0, variancePct: null, status: "no_plan" });
  });
});

describe("calculatedAt", () => {
  it("equals the injected now as an ISO string", () => {
    expect(calc(entries(["m1", 2]), []).calculatedAt).toBe(NOW.toISOString());
    expect(calc([], []).calculatedAt).toBe("2026-01-01T12:00:00.000Z");
  });
});

// ---- Added for reports (3b): batch loader and per-machine totals --------------------------------------------------------------------
import { MAX_LIST_ROWS } from "@/lib/fetch-all";
import { loadPlannedVsActual, loadPlannedVsActualBatch } from "@/lib/jobs/load-planned-vs-actual";
import { type PlannedVsActual, sumStepsByMachine } from "@/lib/jobs/planned-vs-actual";

type Row = Record<string, unknown>;
type Log = { table: string; col?: string; ids?: unknown[]; from?: number };
/** A fake read client over in-memory tables, with a 1,000-row server cap like the API. Supports select/eq/in/order/range/maybeSingle. */
function fakeClient(tables: Record<string, Row[]>) {
  const log: Log[] = [];
  return {
    log,
    from(table: string) {
      let rows = tables[table] ?? [];
      const entry: Log = { table };
      log.push(entry);
      let range: [number, number] | null = null;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
        in: (c: string, v: unknown[]) => { entry.col = c; entry.ids = v; rows = rows.filter((r) => v.includes(r[c])); return q; },
        order: () => q,
        range: (a: number, b: number) => { range = [a, b]; entry.from = a; return q; },
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: range ? rows.slice(range[0], Math.min(range[1] + 1, range[0] + 1_000)) : rows, error: null }).then(ok, bad),
      };
      return q;
    },
  };
}

describe("loadPlannedVsActualBatch", () => {
  const tables = (): Record<string, Row[]> => ({
    machines: [{ id: "m1", name: "Mill" }, { id: "m2", name: "Lathe" }, { id: "m3", name: "Saw" }],
    jobs: [{ id: "j1", finished_at: "2026-01-01T10:00:00Z" }, { id: "j2", finished_at: null }],
    job_machines: [
      { id: "p1", job_id: "j1", machine_id: "m1", estimated_hours: 2, booking_id: null, position: 0 },
      { id: "p2", job_id: "j2", machine_id: "m2", estimated_hours: 4, booking_id: null, position: 0 },
    ],
    machine_bookings: [],
    machine_runs: [
      { id: "r1", job_id: "j1", machine_id: "m1", started_at: at(0), ended_at: at(3) },
      { id: "r2", job_id: "j1", machine_id: "m1", started_at: at(5), ended_at: at(8) },
      { id: "r3", job_id: "j1", machine_id: "m3", started_at: at(0), ended_at: at(1) }, // unplanned
      { id: "r4", job_id: "j1", machine_id: null, started_at: at(0), ended_at: at(2) }, // bench
      { id: "r5", job_id: "j2", machine_id: "m2", started_at: at(0), ended_at: null },
    ],
    operator_sessions: [{ id: "s1", job_id: "j1", started_at: at(0), ended_at: at(2), voided_at: null }],
  });

  it("gives each job exactly the single-job loader's figures (unplanned line, bench, open run, finished flag)", async () => {
    const client = fakeClient(tables());
    const results = await loadPlannedVsActualBatch(client, ["j1", "j2"], NOW);
    for (const id of ["j1", "j2"]) expect(results.get(id)).toEqual(await loadPlannedVsActual(client, id, NOW));
    const j1 = results.get("j1")!;
    expect(j1.steps[0]).toMatchObject({ actualHours: 6, status: "over" });
    expect(j1.unplannedActualHours).toBe(1);
    expect(j1.machineActualHours).toBe(7); // unplanned counted in the total
    expect(j1.benchActualHours).toBe(2); // bench kept out of it
    expect(j1.truncated).toBe(false);
  });

  it("reads in chunks of 100 job ids and the machines once; duplicate ids are read once", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `x${i}`);
    const client = fakeClient(tables());
    const results = await loadPlannedVsActualBatch(client, [...ids, "x0"], NOW);
    expect(results.size).toBe(250);
    expect(client.log.filter((l) => l.table === "machines" && l.from === 0)).toHaveLength(1);
    const runReads = client.log.filter((l) => l.table === "machine_runs" && l.from === 0);
    expect(runReads.map((l) => l.ids?.length)).toEqual([100, 100, 50]);
    expect(runReads.every((l) => l.col === "job_id")).toBe(true);
  });

  it("pages every list past the 1,000-row server limit", async () => {
    const many = Array.from({ length: 2_500 }, (_, i) => ({ id: `r${i}`, job_id: "j1", machine_id: "m1", started_at: new Date(Date.UTC(2025, 0, 1) + i * 360_000).toISOString(), ended_at: new Date(Date.UTC(2025, 0, 1) + (i + 1) * 360_000).toISOString() }));
    const results = await loadPlannedVsActualBatch(fakeClient({ ...tables(), machine_runs: many }), ["j1"], NOW);
    expect(results.get("j1")!.machineActualHours).toBe(250);
    expect(results.get("j1")!.truncated).toBe(false);
  });

  it("carries the safety-cap flag through to the jobs in the chunk", async () => {
    const many = Array.from({ length: MAX_LIST_ROWS + 5 }, (_, i) => ({ id: `r${i}`, job_id: "j1", machine_id: "m1", started_at: at(0), ended_at: at(1) }));
    const results = await loadPlannedVsActualBatch(fakeClient({ ...tables(), machine_runs: many }), ["j1", "j2"], NOW);
    expect(results.get("j1")!.truncated).toBe(true);
    expect(results.get("j2")!.truncated).toBe(true);
  });

  it("no ids reads nothing, and a read error throws", async () => {
    const client = fakeClient(tables());
    expect((await loadPlannedVsActualBatch(client, [], NOW)).size).toBe(0);
    expect(client.log).toHaveLength(0);
    const failing = { from: () => ({ select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: new Error("boom") }) }) }) }) };
    await expect(loadPlannedVsActualBatch(failing, ["j1"], NOW)).rejects.toThrow("boom");
  });
});

describe("sumStepsByMachine", () => {
  const job = (e: ReturnType<typeof entries>, runs: RunRow[]): PlannedVsActual => calc(e, runs);

  it("excludes bench, counts an unplanned machine with 0 planned, and sums across jobs", () => {
    const a = job(entries(["m1", 2]), [run("m1", 0, 3), run(null, 0, 5), run("m2", 0, 1)]);
    const b = job(entries(["m1", 1], ["m2", 3]), [run("m1", 0, 1)]);
    expect(sumStepsByMachine([a, b])).toEqual([
      { machineId: "m2", label: "Lathe", planned: 3, actual: 1 },
      { machineId: "m1", label: "Mill", planned: 3, actual: 4 },
    ]);
  });

  it("a machine only ever unplanned has 0 planned and the plain machine name (no 'Not on plan' suffix)", () => {
    expect(sumStepsByMachine([job(entries(), [run("m3", 0, 2)])])).toEqual([{ machineId: "m3", label: "Saw", planned: 0, actual: 2 }]);
  });

  it("rounds once at the end, and is empty for no results (any iterable)", () => {
    const [t] = sumStepsByMachine([job(entries(["m1", 0.1]), [run("m1", 0, 1)]), job(entries(["m1", 0.2]), [run("m1", 0, 1)])]);
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(t).toMatchObject({ planned: 0.3, actual: 2 });
    expect(sumStepsByMachine([])).toEqual([]);
    expect(sumStepsByMachine(new Map([["j", job(entries(["m1", 1]), [])]]).values())).toHaveLength(1);
  });
});
