/**
 * NCR register menu link (navigation). Reads the sidebar source (it is not rendered in unit tests).
 * Must not change: the link shows only for admin and office, and only while the NCR register switch (job-ncr-register:on) is on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { canSeeNcrRegister, ncrRegisterEnabled } from "@/lib/jobs/ncr-register-switch";

const sidebar = readFileSync(path.resolve(__dirname, "../../components/sidebar.tsx"), "utf8");

describe("NCR register menu link", () => {
  it("is one item, for admin and office only", () => {
    expect(sidebar.match(/href: "\/jobs\/ncr"/g)).toHaveLength(1);
    expect(sidebar).toContain('{ href: "/jobs/ncr", label: "NCR register", roles: ["admin", "office"] }');
  });

  it("is filtered by the active role and the NCR register switch", () => {
    expect(sidebar).toContain('item.href !== "/jobs/ncr" || (canSeeNcrRegister(activeRole) && ncrRegisterEnabled(orgSettings.hiddenNav))');
  });

  it("Job Board is not highlighted on the NCR page", () => {
    expect(sidebar).toContain('!(item.href === "/jobs" && pathname.startsWith("/jobs/ncr"))');
  });

  it("the switch is off by default and on only with the marker", () => {
    expect(ncrRegisterEnabled([])).toBe(false);
    expect(ncrRegisterEnabled(undefined)).toBe(false);
    expect(ncrRegisterEnabled(["job-ncr-register:on"])).toBe(true);
    expect(canSeeNcrRegister("office")).toBe(true);
    expect(canSeeNcrRegister("workshop")).toBe(false);
  });
});
