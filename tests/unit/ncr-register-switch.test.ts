import { describe, expect, it } from "vitest";

import { canSeeNcrRegister, NCR_REGISTER_ON_MARKER, ncrRegisterEnabled, ncrRegisterSwitchChange } from "@/lib/jobs/ncr-register-switch";

describe("NCR register switch", () => {
  it("is off by default", () => {
    for (const nav of [[], undefined, null, ["customers"], ["job-ncr-register"]] as (string[] | null | undefined)[]) expect(ncrRegisterEnabled(nav)).toBe(false);
  });
  it("is on with the marker", () => {
    expect(NCR_REGISTER_ON_MARKER).toBe("job-ncr-register:on");
    expect(ncrRegisterEnabled(["customers", NCR_REGISTER_ON_MARKER])).toBe(true);
  });
  it("role matrix: admin and office only", () => {
    expect(canSeeNcrRegister("admin")).toBe(true);
    expect(canSeeNcrRegister("office")).toBe(true);
    for (const r of ["workshop", "viewer", "", null, undefined, "owner"]) expect(canSeeNcrRegister(r)).toBe(false);
  });
  it("switch change adds or removes only the marker", () => {
    expect(ncrRegisterSwitchChange(true)).toEqual({ add: [NCR_REGISTER_ON_MARKER], remove: [] });
    expect(ncrRegisterSwitchChange(false)).toEqual({ add: [], remove: [NCR_REGISTER_ON_MARKER] });
  });
});
