/**
 * Reports menu link (navigation). Reads the sidebar source (it is not rendered in unit tests).
 * Must not change: the link shows only for admin and office, and only while the Reports switch (reports:on) is on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { canSeeReports, reportsEnabled } from "@/lib/reports/reports-switch";

const sidebar = readFileSync(path.resolve(__dirname, "../../components/sidebar.tsx"), "utf8");

describe("Reports menu link", () => {
  it("is one item, for admin and office only", () => {
    expect(sidebar.match(/href: "\/reports"/g)).toHaveLength(1);
    expect(sidebar).toContain('{ href: "/reports", label: "Reports", roles: ["admin", "office"] }');
  });

  it("is filtered by the active role and the Reports switch", () => {
    expect(sidebar).toContain('item.href !== "/reports" || (canSeeReports(activeRole) && reportsEnabled(orgSettings.hiddenNav))');
  });

  it("the switch is off by default and on only with the marker", () => {
    expect(reportsEnabled([])).toBe(false);
    expect(reportsEnabled(undefined)).toBe(false);
    expect(reportsEnabled(["reports:on"])).toBe(true);
    expect(canSeeReports("office")).toBe(true);
    expect(canSeeReports("workshop")).toBe(false);
  });
});
