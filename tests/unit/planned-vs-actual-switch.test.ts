import { describe, expect, it } from "vitest";

import { JOB_TIME_VARIANCE_ON_MARKER, canSeePlannedVsActual, plannedVsActualEnabled, plannedVsActualSwitchChange } from "@/lib/jobs/planned-vs-actual-switch";

describe("planned vs actual switch", () => {
  it("is off by default", () => {
    expect(plannedVsActualEnabled([])).toBe(false);
    expect(plannedVsActualEnabled(undefined)).toBe(false);
    expect(plannedVsActualEnabled(null)).toBe(false);
    expect(plannedVsActualEnabled(["customers"])).toBe(false);
  });
  it("is on with the marker", () => {
    expect(JOB_TIME_VARIANCE_ON_MARKER).toBe("job-time-variance:on");
    expect(plannedVsActualEnabled(["customers", JOB_TIME_VARIANCE_ON_MARKER])).toBe(true);
  });
  it("role matrix: only admin and office", () => {
    expect(canSeePlannedVsActual("admin")).toBe(true);
    expect(canSeePlannedVsActual("office")).toBe(true);
    for (const role of ["workshop", "viewer", null, undefined]) expect(canSeePlannedVsActual(role)).toBe(false);
  });
  it("switch change adds or removes the marker", () => {
    expect(plannedVsActualSwitchChange(true)).toEqual({ add: [JOB_TIME_VARIANCE_ON_MARKER], remove: [] });
    expect(plannedVsActualSwitchChange(false)).toEqual({ add: [], remove: [JOB_TIME_VARIANCE_ON_MARKER] });
  });
});
