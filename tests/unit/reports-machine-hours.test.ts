import { describe, expect, it } from "vitest";

import { OVER_PLAN_TOLERANCE, sumStepsByMachine, type MachineTotal, type PlannedVsActual, type Step } from "@/lib/jobs/planned-vs-actual";
import { jobsPerMachine, machineHoursVariance } from "@/lib/reports/machine-hours-variance";

const t = (label: string, planned: number, actual: number): MachineTotal => ({ machineId: label, label, planned, actual });
const noJobs = new Map<string, number>();
const row = (planned: number, actual: number) => machineHoursVariance([t("M", planned, actual)], noJobs).rows[0];
const step = (machineId: string | null, planned: number | null, actual: number): Step => ({
  key: machineId ?? "bench", label: machineId ?? "Bench", machineId, isBench: machineId === null, onPlan: planned !== null, plannedHours: planned, actualHours: actual,
  running: false, varianceHours: null, variancePct: null, status: "on_plan" as Step["status"],
});
const job = (...steps: Step[]) => ({ steps }) as unknown as PlannedVsActual;

describe("machine hours variance", () => {
  it("variance is actual minus planned, with a percentage of plan", () => {
    expect(row(2, 2.5)).toMatchObject({ varianceHours: 0.5, variancePercent: 25, status: "over" });
    expect(row(10, 6)).toMatchObject({ varianceHours: -4, variancePercent: -40, status: "under" });
  });
  it("uses the worksheet tolerance: exactly at the edge is on plan", () => {
    expect(OVER_PLAN_TOLERANCE).toBe(0.1);
    expect(row(10, 11).status).toBe("on_plan");
    expect(row(10, 11.01).status).toBe("over");
    expect(row(10, 9).status).toBe("on_plan");
    expect(row(10, 8.99).status).toBe("under");
  });
  it("planned 0 shows actual only, no percentage, and is left out of the overall percentage", () => {
    const r = machineHoursVariance([t("A", 10, 12), t("B", 0, 5)], noJobs);
    expect(r.rows[1]).toMatchObject({ status: "no_plan", varianceHours: null, variancePercent: null, actualHours: 5 });
    expect(r.plannedHours).toBe(10);
    expect(r.actualHours).toBe(17);
    expect(r.plannedMachinesPercent).toBe(20); // (12 - 10) / 10, machine B not in it
  });
  it("no planned machines: no overall percentage; no machines: zeros", () => {
    expect(machineHoursVariance([t("B", 0, 5)], noJobs).plannedMachinesPercent).toBeNull();
    expect(machineHoursVariance([], noJobs)).toMatchObject({ rows: [], plannedHours: 0, actualHours: 0, plannedMachinesPercent: null });
  });
  it("carries no cost fields", () => {
    expect(Object.keys(row(2, 3)).join()).not.toMatch(/cost|rate|price|£/i);
  });
  it("jobs per machine: a job counts once per machine, bench is excluded, an unplanned machine counts", () => {
    const results = [
      job(step("MILL", 2, 2.5), step("MILL", 1, 1), step(null, null, 4), step("LATHE", null, 1)), // two MILL steps still one job; LATHE not on plan
      job(step("MILL", 3, 0), step(null, null, 2)),
      job(step(null, null, 9)), // bench only: no machine
    ];
    const counts = jobsPerMachine(results);
    expect(counts.get("MILL")).toBe(2);
    expect(counts.get("LATHE")).toBe(1);
    expect(counts.has("")).toBe(false);
    expect(counts.size).toBe(2);
  });
  it("rows carry the job count by machine id; a machine with no count shows 0", () => {
    const results = [job(step("MILL", 2, 2.5), step("LATHE", null, 1)), job(step("MILL", 1, 1))];
    const r = machineHoursVariance(sumStepsByMachine(results), jobsPerMachine(results));
    expect(r.rows.map((x) => [x.label, x.jobs])).toEqual([["LATHE", 1], ["MILL", 2]]);
    expect(machineHoursVariance([t("X", 1, 1)], noJobs).rows[0].jobs).toBe(0);
  });
});
