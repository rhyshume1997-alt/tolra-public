import { describe, expect, it } from "vitest";

import { REPORTS_OFF_NOTICE, REPORTS_ON_MARKER, canSeeReports, reportsEnabled, reportsSwitchChange } from "@/lib/reports/reports-switch";

describe("reports switch", () => {
  it("is off by default", () => {
    for (const list of [[], undefined, null, ["customers"], ["job-ncr-register:on"]]) expect(reportsEnabled(list)).toBe(false);
  });
  it("is on only with the marker", () => {
    expect(REPORTS_ON_MARKER).toBe("reports:on");
    expect(reportsEnabled(["customers", REPORTS_ON_MARKER])).toBe(true);
  });
  it("role matrix: only admin and office", () => {
    expect(canSeeReports("admin")).toBe(true);
    expect(canSeeReports("office")).toBe(true);
    for (const role of ["workshop", "viewer", "", null, undefined]) expect(canSeeReports(role)).toBe(false);
  });
  it("switch change adds or removes the marker; notice text", () => {
    expect(reportsSwitchChange(true)).toEqual({ add: [REPORTS_ON_MARKER], remove: [] });
    expect(reportsSwitchChange(false)).toEqual({ add: [], remove: [REPORTS_ON_MARKER] });
    expect(REPORTS_OFF_NOTICE).toBe("Reports are switched off for your company.");
  });
});
