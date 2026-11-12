import { describe, expect, it } from "vitest";

import { OVER_PLAN_TOLERANCE, type MachineTotal } from "@/lib/jobs/planned-vs-actual";
import { machineHoursVariance } from "@/lib/reports/machine-hours-variance";

const t = (label: string, planned: number, actual: number): MachineTotal => ({ machineId: label, label, planned, actual });
const row = (planned: number, actual: number) => machineHoursVariance([t("M", planned, actual)]).rows[0];

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
    const r = machineHoursVariance([t("A", 10, 12), t("B", 0, 5)]);
    expect(r.rows[1]).toMatchObject({ status: "no_plan", varianceHours: null, variancePercent: null, actualHours: 5 });
    expect(r.plannedHours).toBe(10);
    expect(r.actualHours).toBe(17);
    expect(r.plannedMachinesPercent).toBe(20); // (12 - 10) / 10, machine B not in it
  });
  it("no planned machines: no overall percentage; no machines: zeros", () => {
    expect(machineHoursVariance([t("B", 0, 5)]).plannedMachinesPercent).toBeNull();
    expect(machineHoursVariance([])).toMatchObject({ rows: [], plannedHours: 0, actualHours: 0, plannedMachinesPercent: null });
  });
  it("carries no cost fields", () => {
    expect(Object.keys(row(2, 3)).join()).not.toMatch(/cost|rate|price|£/i);
  });
});
