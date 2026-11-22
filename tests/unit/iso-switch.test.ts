import { describe, expect, it } from "vitest";

import { canSeeIso, ISO_OFF_NOTICE, ISO_TEMPLATES_ON_MARKER, isoSwitchChange, isoTemplatesEnabled, nextIsoHiddenNav } from "@/lib/iso/iso-switch";

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
  it("nextIsoHiddenNav keeps other entries, on then off, idempotent, does not mutate input", () => {
    const start = Object.freeze(["customers", "sales-orders:on", "reports"]);
    const on = nextIsoHiddenNav(start, true);
    expect(on).toEqual(["customers", "sales-orders:on", "reports", ISO_TEMPLATES_ON_MARKER]);
    expect(nextIsoHiddenNav(on, true)).toEqual(on);
    const off = nextIsoHiddenNav(on, false);
    expect(off).toEqual([...start]);
    expect(nextIsoHiddenNav(off, false)).toEqual([...start]);
    expect(nextIsoHiddenNav([], false)).toEqual([]);
    expect(start).toEqual(["customers", "sales-orders:on", "reports"]);
    expect(on).not.toBe(start);
  });
});
