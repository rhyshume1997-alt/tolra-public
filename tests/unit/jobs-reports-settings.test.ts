// Boundary: tests only the pure hidden_nav delta used by the Job reports settings card. Must not be loosened.
import { describe, expect, it } from "vitest";

import { nextHiddenNav } from "@/components/jobs/jobs-reports-settings-card";
import { NCR_REGISTER_ON_MARKER, ncrRegisterEnabled, ncrRegisterSwitchChange } from "@/lib/jobs/ncr-register-switch";
import { JOB_TIME_VARIANCE_ON_MARKER, plannedVsActualEnabled, plannedVsActualSwitchChange } from "@/lib/jobs/planned-vs-actual-switch";

const others = ["sales-orders:on", "customers", "reports"];

describe("Job reports switches leave other hidden_nav entries unchanged", () => {
  it("both start off", () => {
    expect(plannedVsActualEnabled(others)).toBe(false);
    expect(ncrRegisterEnabled(others)).toBe(false);
  });

  it("planned vs actual on then off", () => {
    const on = nextHiddenNav(others, plannedVsActualSwitchChange(true));
    expect(on).toEqual([...others, JOB_TIME_VARIANCE_ON_MARKER]);
    expect(plannedVsActualEnabled(on)).toBe(true);
    expect(nextHiddenNav(on, plannedVsActualSwitchChange(false))).toEqual(others);
  });

  it("NCR register on then off", () => {
    const on = nextHiddenNav(others, ncrRegisterSwitchChange(true));
    expect(on).toEqual([...others, NCR_REGISTER_ON_MARKER]);
    expect(ncrRegisterEnabled(on)).toBe(true);
    expect(nextHiddenNav(on, ncrRegisterSwitchChange(false))).toEqual(others);
  });

  it("one switch does not touch the other", () => {
    const both = nextHiddenNav(nextHiddenNav(others, ncrRegisterSwitchChange(true)), plannedVsActualSwitchChange(true));
    expect(ncrRegisterEnabled(both)).toBe(true);
    expect(nextHiddenNav(both, plannedVsActualSwitchChange(false))).toEqual([...others, NCR_REGISTER_ON_MARKER]);
    expect(nextHiddenNav(both, ncrRegisterSwitchChange(false))).toEqual([...others, JOB_TIME_VARIANCE_ON_MARKER]);
  });

  it("is idempotent and does not mutate its input", () => {
    const input = [...others, NCR_REGISTER_ON_MARKER];
    expect(nextHiddenNav(input, ncrRegisterSwitchChange(true))).toEqual(input);
    expect(input).toEqual([...others, NCR_REGISTER_ON_MARKER]);
    expect(nextHiddenNav([], plannedVsActualSwitchChange(false))).toEqual([]);
  });
});
