import { describe, expect, it } from "vitest";

import { canSeeIso, ISO_OFF_NOTICE, ISO_TEMPLATES_ON_MARKER, isoSwitchChange, isoTemplatesEnabled } from "@/lib/iso/iso-switch";

describe("ISO templates switch", () => {
  it("is off by default", () => {
    for (const nav of [[], undefined, null, ["customers"], ["iso-templates"]] as (string[] | null | undefined)[]) expect(isoTemplatesEnabled(nav)).toBe(false);
  });
  it("is on with the marker", () => {
    expect(ISO_TEMPLATES_ON_MARKER).toBe("iso-templates:on");
    expect(isoTemplatesEnabled(["customers", ISO_TEMPLATES_ON_MARKER])).toBe(true);
  });
  it("says it is switched off", () => {
    expect(ISO_OFF_NOTICE).toBe("ISO templates are switched off for your company.");
  });
  it("role matrix: admin only", () => {
    expect(canSeeIso("admin")).toBe(true);
    for (const r of ["office", "workshop", "viewer", "", null, undefined, "owner"]) expect(canSeeIso(r)).toBe(false);
  });
  it("switch change adds or removes only the marker", () => {
    expect(isoSwitchChange(true)).toEqual({ add: [ISO_TEMPLATES_ON_MARKER], remove: [] });
    expect(isoSwitchChange(false)).toEqual({ add: [], remove: [ISO_TEMPLATES_ON_MARKER] });
  });
});
