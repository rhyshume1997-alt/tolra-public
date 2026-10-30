/**
 * Dashboard display drift guard (Rhys, Fri 23 Oct): DASHBOARD_TILES (lib/dashboard-tiles) is the single source for the Dashboard's
 * tiles and sections. The Columns picker (COLUMN_TABLES "dashboard") is built from it, and the page renders each tile behind
 * isVisible(<key>) for exactly the keys its role has, in the same order as the definition.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { DASHBOARD_TILES, dashboardTileKeysFor, kpiGridClass, statGridClass } from "@/lib/dashboard-tiles";
import { COLUMN_TABLES } from "@/lib/org-settings";

const page = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/dashboard/page.tsx"), "utf8");
const section = (from: string, to: string) => page.slice(page.indexOf(from), page.indexOf(to));

describe("dashboard display: one definition", () => {
  it("the picker's list is the definition, in order, with unique keys", () => {
    const def = COLUMN_TABLES.find((t) => t.key === "dashboard")!;
    expect(def.columns).toEqual(DASHBOARD_TILES.map(({ key, label }) => ({ key, label })));
    expect(new Set(DASHBOARD_TILES.map((t) => t.key)).size).toBe(DASHBOARD_TILES.length);
  });

  it("every tile is shown to at least one role and the page heading is not listed", () => {
    for (const tile of DASHBOARD_TILES) expect(tile.roles.length).toBeGreaterThan(0);
    expect(DASHBOARD_TILES.map((t) => t.key)).not.toContain("heading");
  });

  it("the page renders every key of the definition", () => {
    for (const tile of DASHBOARD_TILES) expect(page, `${tile.key} is rendered by the page`).toContain(`"${tile.key}"`);
  });

  it("the page lists each group of tiles in the definition's order, and renders sections in that order", () => {
    const order = DASHBOARD_TILES.map((t) => t.key);
    const group = (from: string, keys: string[]) => {
      const start = page.indexOf(from);
      const positions = keys.map((k) => page.indexOf(`"${k}"`, start));
      positions.forEach((p, i) => expect(p, `${keys[i]} found after ${from}`).toBeGreaterThan(-1));
      expect(positions, from).toEqual([...positions].sort((x, y) => x - y));
      expect(keys, "same relative order as the definition").toEqual(order.filter((k) => keys.includes(k)));
    };
    group("function AdminDashboard", ["open-jobs", "open-quotes"]);
    group("const stats = ", ["this-month-revenue", "quotes-sent", "jobs-late-on-time", "avg-days-to-pay"]);
    group("function WorkshopDashboard", ["jobs-running", "due-this-week", "delivery-notes", "my-jobs", "needs-attention", "whole-floor"]);
    const workshop = page.slice(page.indexOf("function WorkshopDashboard"), page.indexOf("function ApprovalLink"));
    expect(workshop.indexOf('isVisible("needs-attention")')).toBeLessThan(workshop.indexOf("showPriority ? <Card>"));
    expect(workshop.indexOf("showPriority ? <Card>")).toBeLessThan(workshop.indexOf("showSchedule ? <Card>"));
    // Whole floor comes last, after the Priority jobs and schedule cards.
    expect(workshop.indexOf("showSchedule ? <Card>")).toBeLessThan(workshop.indexOf('isVisible("whole-floor")'));
    expect(dashboardTileKeysFor("workshop").slice(-3)).toEqual(["priority-jobs", "workshop-schedule", "whole-floor"]);
    // Office render: KPIs, then the chart, then the stat row, then Needs attention and Quote pipeline.
    const render = page.slice(page.indexOf("{shownKpis.length ? <section", page.indexOf("function AdminDashboard")), page.indexOf("function MaybeLink"));
    const at = ["shownKpis.length", 'isVisible("revenue-trend")', "stats.length ?", "showAttention ? <AttentionList", "showPipeline ? pipelinePanel"].map((m) => render.indexOf(m));
    at.forEach((p) => expect(p).toBeGreaterThan(-1));
    expect(at).toEqual([...at].sort((x, y) => x - y));
  });

  it("the owner's Overview runs Today, Money, Work, Machines, People, and Today keeps the full Needs attention list", () => {
    const owner = page.slice(page.indexOf("if (!office) {", page.indexOf("function AdminDashboard")), page.indexOf("{shownKpis.length ? <section", page.indexOf("function AdminDashboard")));
    const at = ['id="today"', 'id="money"', 'id="work"', 'id="machines"', 'id="people"'].map((m) => owner.indexOf(m));
    at.forEach((p) => expect(p).toBeGreaterThan(-1));
    expect(at).toEqual([...at].sort((x, y) => x - y));
    expect(owner).toContain('<AttentionList role="admin" preloaded={attention}');
    expect(owner).toContain('isVisible("leaks")');
  });

  it("the page heading is never behind a visibility check", () => {
    expect(section("export default function DashboardPage", "</section>")).not.toMatch(/isVisible\([^)]*\)\s*\?[^:]*page-title/);
  });

  it("grids fill their width whatever is hidden", () => {
    expect(kpiGridClass(1)).toBe("grid-cols-1");
    expect(kpiGridClass(2)).toBe("sm:grid-cols-2");
    expect(kpiGridClass(3)).toContain("xl:grid-cols-3");
    expect([1, 2, 3, 4].map(statGridClass)).toEqual(["grid-cols-1", "md:grid-cols-2", "md:grid-cols-3", "md:grid-cols-4"]);
  });
});
