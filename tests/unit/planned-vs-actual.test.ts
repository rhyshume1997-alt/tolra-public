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
