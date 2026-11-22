/**
 * The first-login admin tour (components/tooly/tour): both switches off by default, admin only, 23 fixed steps, plain words,
 * and a plan that never walks to a page the person cannot open.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { planAdminTour } from "@/components/tooly/tour/tour-plan";
import { ADMIN_TOUR_STEPS } from "@/components/tooly/tour/tour-steps";
import { TOOLY_TOUR_DISABLE_ENV_FLAG, TOOLY_TOUR_ENV_FLAG, TOOLY_TOUR_ON_MARKER, toolyTourEnabled, toolyTourEnvEnabled, toolyTourMarkerOn, toolyTourSwitchChange } from "@/components/tooly/tour/tour-switch";

const ROOT = path.resolve(__dirname, "../..");
const ALL_ON = ["sales-orders:on"];

describe("tour switches", () => {
  it("the tour is ON by default and off only for exactly TOOLY_TOUR_DISABLED=\"true\"", () => {
    expect(TOOLY_TOUR_DISABLE_ENV_FLAG).toBe("TOOLY_TOUR_DISABLED");
    expect(toolyTourEnvEnabled({})).toBe(true);
    expect(toolyTourEnvEnabled({ TOOLY_TOUR_DISABLED: "true" })).toBe(false);
    for (const v of [undefined, "", "TRUE", "1", "yes", "false", " true"]) expect(toolyTourEnvEnabled({ TOOLY_TOUR_DISABLED: v })).toBe(true);
    // The old env flag decides nothing any more.
    expect(TOOLY_TOUR_ENV_FLAG).toBe("TOOLY_ADMIN_TOUR_ENABLED");
    expect(toolyTourEnvEnabled({ TOOLY_ADMIN_TOUR_ENABLED: "false" })).toBe(true);
  });
  it("company marker is off unless present", () => {
    expect(TOOLY_TOUR_ON_MARKER).toBe("tooly-admin-tour:on");
    for (const nav of [[], undefined, null, ["tooly-admin-tour"], ["quotes"]] as (string[] | null | undefined)[]) expect(toolyTourMarkerOn(nav)).toBe(false);
    expect(toolyTourMarkerOn(["quotes", TOOLY_TOUR_ON_MARKER])).toBe(true);
  });
  it("shows only with env flag AND marker AND admin", () => {
    const nav = [TOOLY_TOUR_ON_MARKER];
    expect(toolyTourEnabled({ envOn: true, hiddenNav: nav, role: "admin" })).toBe(true);
    expect(toolyTourEnabled({ envOn: false, hiddenNav: nav, role: "admin" })).toBe(false);
    expect(toolyTourEnabled({ envOn: true, hiddenNav: [], role: "admin" })).toBe(false);
    for (const role of ["office", "workshop", "viewer", "", null, undefined]) expect(toolyTourEnabled({ envOn: true, hiddenNav: nav, role })).toBe(false);
  });
  it("switch change adds or removes only the marker", () => {
    expect(toolyTourSwitchChange(true)).toEqual({ add: [TOOLY_TOUR_ON_MARKER], remove: [] });
    expect(toolyTourSwitchChange(false)).toEqual({ add: [], remove: [TOOLY_TOUR_ON_MARKER] });
  });
});

describe("the 23 steps", () => {
  it("are numbered 1 to 23, in order, all mandatory, with unique ids", () => {
    expect(ADMIN_TOUR_STEPS).toHaveLength(23);
    expect(ADMIN_TOUR_STEPS.map((s) => s.n)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(new Set(ADMIN_TOUR_STEPS.map((s) => s.id)).size).toBe(23);
    expect(ADMIN_TOUR_STEPS.every((s) => s.mandatory === true)).toBe(true);
  });
  it("use plain words: no em or en dashes, no markup, short", () => {
    for (const s of ADMIN_TOUR_STEPS) {
      for (const text of [s.text, s.closedText ?? ""]) {
        expect(text, `step ${s.n}`).not.toMatch(/[–—]/);
        expect(text, `step ${s.n}`).not.toMatch(/[<>{}]/);
        expect(text.length, `step ${s.n}`).toBeLessThanOrEqual(400);
      }
      expect(s.text.length, `step ${s.n}`).toBeGreaterThan(20);
    }
  });
  it("never tell the person to press a button that sends, accepts or saves as part of the tour", () => {
    // The words describe the buttons; the tour itself must not click. The module has no click, submit or dispatch call.
    for (const file of ["admin-tour.tsx", "tour-plan.ts", "tour-steps.ts", "tour-switch.ts"]) {
      const code = readFileSync(path.join(ROOT, "components/tooly/tour", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, file).not.toMatch(/\.click\(|\.submit\(|dispatchEvent|requestSubmit|\.focus\(/);
      expect(code, file).not.toMatch(/\bfetch\(|\/api\//);
    }
  });
});

describe("planAdminTour", () => {
  const base = { hiddenSections: [] as string[], hiddenNav: ALL_ON, phone: false };
  it("is empty for anyone who is not an admin", () => {
    for (const activeRole of ["office", "workshop", "viewer", "", null, undefined]) expect(planAdminTour({ ...base, activeRole })).toEqual([]);
  });
  it("gives all 23 steps to an admin who can open every page", () => {
    const plan = planAdminTour({ ...base, activeRole: "admin" });
    expect(plan).toHaveLength(23);
    expect(plan.map((p) => p.number)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(plan.every((p) => p.of === 23 && !p.closed)).toBe(true);
  });
  it("says the page is off and skips the rest when quotes are hidden for the person", () => {
    const plan = planAdminTour({ ...base, activeRole: "admin", hiddenSections: ["quotes"] });
    expect(plan).toHaveLength(23 - 5 + 1);
    const closed = plan.filter((p) => p.closed);
    expect(closed.map((p) => p.step.id)).toEqual(["quotes"]);
    expect(closed[0].text).toMatch(/switched off/);
    expect(closed[0].route).toBe("/dashboard");
    expect(plan.some((p) => ["new-quote", "view-quote", "send-quote", "decide-quote"].includes(p.step.id))).toBe(false);
  });
  it("also respects the company menu (quotes hidden with the plain key)", () => {
    const plan = planAdminTour({ ...base, activeRole: "admin", hiddenNav: ["quotes"] });
    expect(plan.find((p) => p.step.id === "quotes")?.closed).toBe(true);
  });
  it("skips the job steps when jobs are hidden, and renumbers", () => {
    const plan = planAdminTour({ ...base, activeRole: "admin", hiddenSections: ["jobs"] });
    expect(plan.some((p) => ["new-job", "job-buttons", "job-filters"].includes(p.step.id))).toBe(false);
    expect(plan.find((p) => p.step.id === "jobs")?.closed).toBe(true);
    expect(plan.map((p) => p.number)).toEqual(plan.map((_, i) => i + 1));
  });
  it("points the menu step at the menu button on a phone", () => {
    const menu = (phone: boolean) => planAdminTour({ ...base, activeRole: "admin", phone }).find((p) => p.step.id === "menu")!.target;
    expect(menu(false)).toMatchObject({ kind: "css", selector: "aside" });
    expect(menu(true)).toMatchObject({ kind: "css", selector: '[aria-label="Open menu"]' });
  });
});

describe("the mount (shell only)", () => {
  const src = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  it("the layout hands the shell the server flag as a boolean, from the one switch file", () => {
    const layout = src("app/(dashboard)/layout.tsx");
    expect(layout).toMatch(/toolyTourEnvEnabled\(\)/);
    expect(layout).toMatch(/toolyTour=\{toolyTourEnvEnabled\(\)\}/);
  });
  it("the shell mounts the tour with that boolean, off unless passed on", () => {
    const shell = src("components/dashboard-shell.tsx");
    expect(shell).toMatch(/<AdminTour envOn=\{toolyTour\} \/>/);
    expect(shell).toMatch(/toolyTour = false/);
  });
  it("the float, the sidebar and the middleware do not reference the tour", () => {
    for (const file of ["components/tooly/tooly-float.tsx", "components/sidebar.tsx", "middleware.ts"]) {
      expect(src(file), file).not.toMatch(/AdminTour|admin-tour|tooly-admin-tour/);
    }
  });
  it("the tour card sits above dialogs and sheets (z-50) and above the float (z-40)", () => {
    expect(src("components/tooly/tour/admin-tour.tsx")).toMatch(/z-\[60\]/);
    expect(src("components/ui/dialog.tsx")).toMatch(/z-50/);
    expect(src("components/tooly/tooly-float.tsx")).toMatch(/z-40/);
  });
});
