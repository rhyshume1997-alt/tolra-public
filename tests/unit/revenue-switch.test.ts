/**
 * BOUNDARY: the Revenue reports switch (lib/reports/revenue/revenue-switch). Input: hidden_nav lists and roles. Output: assertions.
 * Must not change: the marker text, off by default, admin and office only.
 */
import { describe, expect, it } from "vitest";

import { canSeeRevenue, REVENUE_OFF_NOTICE, REVENUE_ON_MARKER, revenueEnabled, revenueSwitchChange } from "@/lib/reports/revenue/revenue-switch";

describe("Revenue reports switch", () => {
  it("is off by default and on only with the marker", () => {
    expect(REVENUE_ON_MARKER).toBe("reports-revenue:on");
    for (const nav of [undefined, null, [], ["numbers"], ["reports-revenue"], ["sales-orders:on"]]) expect(revenueEnabled(nav)).toBe(false);
    expect(revenueEnabled(["sales-orders:on", "reports-revenue:on"])).toBe(true);
  });

  it("is for admin and office only", () => {
    expect(canSeeRevenue("admin")).toBe(true);
    expect(canSeeRevenue("office")).toBe(true);
    for (const role of ["workshop", "viewer", "", null, undefined, "Admin"]) expect(canSeeRevenue(role)).toBe(false);
  });

  it("switches on and off by the marker alone", () => {
    expect(revenueSwitchChange(true)).toEqual({ add: ["reports-revenue:on"], remove: [] });
    expect(revenueSwitchChange(false)).toEqual({ add: [], remove: ["reports-revenue:on"] });
  });

  it("has the off notice the page shows", () => {
    expect(REVENUE_OFF_NOTICE).toBe("Revenue reports are switched off for your company.");
  });
});
