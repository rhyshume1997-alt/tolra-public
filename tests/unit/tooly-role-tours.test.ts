/**
 * The office and workshop tours (components/tooly/tour/role-tour-steps.ts, tour-plan.ts planTour, tour-switch.ts per-role markers).
 * Proves: each view has its own company marker (the admin marker does not switch the other two on, and a viewer never gets a tour); the
 * fixed steps (17 office, 13 workshop) are numbered, unique, mandatory, plain words, short; every page a step walks to opens for that
 * role; the shared steps are the admin tour's own words; the plan skips or replaces a page that is switched off for the person; the admin
 * tour is unchanged (23 steps, admin only); the new file points and never clicks, saves or sends and calls no AI.
 * Must not change: this file proves; the admin tests stay in tooly-tour.test.ts and are not edited.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OFFICE_TOUR_STEPS, WORKSHOP_TOUR_STEPS } from "@/components/tooly/tour/role-tour-steps";
import { planAdminTour, planTour } from "@/components/tooly/tour/tour-plan";
import { ADMIN_TOUR_STEPS, type TourStep } from "@/components/tooly/tour/tour-steps";
import {
  TOOLY_OFFICE_TOUR_ON_MARKER,
  TOOLY_TOUR_ON_MARKER,
  TOOLY_WORKSHOP_TOUR_ON_MARKER,
  toolyTourEnabled,
  toolyTourEnabledFor,
  toolyTourMarkerFor,
  toolyTourSwitchChangeFor,
} from "@/components/tooly/tour/tour-switch";
import { canOpenDestination } from "@/lib/destinations";
import type { UserRole } from "@/types";

const ROOT = path.resolve(__dirname, "../..");
const ALL_ON = ["sales-orders:on"];
const open = (role: string) => ({ activeRole: role, hiddenSections: [] as string[], hiddenNav: ALL_ON, phone: false });

describe("one marker per view, all off by default", () => {
  it("the three markers are different texts and the admin one is unchanged", () => {
    expect(TOOLY_TOUR_ON_MARKER).toBe("tooly-admin-tour:on");
    expect(TOOLY_OFFICE_TOUR_ON_MARKER).toBe("tooly-office-tour:on");
    expect(TOOLY_WORKSHOP_TOUR_ON_MARKER).toBe("tooly-workshop-tour:on");
    expect(new Set([TOOLY_TOUR_ON_MARKER, TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_WORKSHOP_TOUR_ON_MARKER]).size).toBe(3);
  });
  it("a view shows its tour only with the server flag AND its own marker", () => {
    for (const [role, marker] of [["admin", TOOLY_TOUR_ON_MARKER], ["office", TOOLY_OFFICE_TOUR_ON_MARKER], ["workshop", TOOLY_WORKSHOP_TOUR_ON_MARKER]] as const) {
      expect(toolyTourEnabledFor({ envOn: true, hiddenNav: [marker], role })).toBe(true);
      expect(toolyTourEnabledFor({ envOn: false, hiddenNav: [marker], role })).toBe(false);
      expect(toolyTourEnabledFor({ envOn: true, hiddenNav: [], role })).toBe(false);
      expect(toolyTourEnabledFor({ envOn: true, hiddenNav: null, role })).toBe(false);
      expect(toolyTourEnabledFor({ envOn: true, role })).toBe(false);
    }
  });
  it("one view's marker never turns on another view's tour", () => {
    const only = (marker: string, role: string) => toolyTourEnabledFor({ envOn: true, hiddenNav: [marker], role });
    expect(only(TOOLY_TOUR_ON_MARKER, "office")).toBe(false);
    expect(only(TOOLY_TOUR_ON_MARKER, "workshop")).toBe(false);
    expect(only(TOOLY_OFFICE_TOUR_ON_MARKER, "admin")).toBe(false);
    expect(only(TOOLY_OFFICE_TOUR_ON_MARKER, "workshop")).toBe(false);
    expect(only(TOOLY_WORKSHOP_TOUR_ON_MARKER, "admin")).toBe(false);
    expect(only(TOOLY_WORKSHOP_TOUR_ON_MARKER, "office")).toBe(false);
  });
  it("a viewer, or anyone with no role, never gets a tour, whatever is switched on", () => {
    const everything = [TOOLY_TOUR_ON_MARKER, TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_WORKSHOP_TOUR_ON_MARKER];
    for (const role of ["viewer", "", null, undefined, "platform"]) {
      expect(toolyTourMarkerFor(role)).toBeNull();
      expect(toolyTourEnabledFor({ envOn: true, hiddenNav: everything, role })).toBe(false);
    }
  });
  it("the older admin-only function is unchanged", () => {
    expect(toolyTourEnabled({ envOn: true, hiddenNav: [TOOLY_TOUR_ON_MARKER], role: "admin" })).toBe(true);
    for (const role of ["office", "workshop", "viewer"]) expect(toolyTourEnabled({ envOn: true, hiddenNav: [TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_WORKSHOP_TOUR_ON_MARKER, TOOLY_TOUR_ON_MARKER], role })).toBe(false);
  });
  it("the switch change adds or removes only that view's marker", () => {
    expect(toolyTourSwitchChangeFor("office", true)).toEqual({ add: [TOOLY_OFFICE_TOUR_ON_MARKER], remove: [] });
    expect(toolyTourSwitchChangeFor("workshop", false)).toEqual({ add: [], remove: [TOOLY_WORKSHOP_TOUR_ON_MARKER] });
    expect(toolyTourSwitchChangeFor("admin", true)).toEqual({ add: [TOOLY_TOUR_ON_MARKER], remove: [] });
  });
});

describe.each([
  ["office", OFFICE_TOUR_STEPS, 17],
  ["workshop", WORKSHOP_TOUR_STEPS, 13],
] as const)("the %s steps", (role, steps, count) => {
  it(`are numbered 1 to ${count}, in order, all mandatory, with unique ids`, () => {
    expect(steps).toHaveLength(count);
    expect(steps.map((s) => s.n)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(new Set(steps.map((s) => s.id)).size).toBe(count);
    expect(steps.every((s) => s.mandatory === true)).toBe(true);
  });
  it("start with Tooly's hello and end with the done step", () => {
    expect(steps[0].id).toBe("hello");
    expect(steps[steps.length - 1].id).toBe("done");
  });
  it("use plain words: no em or en dashes, no markup, short", () => {
    for (const s of steps) {
      for (const text of [s.text, s.closedText ?? ""]) {
        expect(text, `${role} step ${s.n}`).not.toMatch(/[–—]/);
        expect(text, `${role} step ${s.n}`).not.toMatch(/[<>{}]/);
        expect(text.length, `${role} step ${s.n}`).toBeLessThanOrEqual(400);
      }
      expect(s.text.length, `${role} step ${s.n}`).toBeGreaterThan(20);
    }
  });
  it("only ever walk to a page this role can open", () => {
    for (const s of steps) {
      const access = { activeRole: role as UserRole, hiddenSections: [] as string[], hiddenNav: ALL_ON };
      expect(canOpenDestination(s.route, access), `${role} step ${s.n} route ${s.route}`).toBe(true);
      if (s.destination) expect(canOpenDestination(s.destination, access), `${role} step ${s.n} destination ${s.destination}`).toBe(true);
    }
  });
  it("say so once for a page that can be switched off, so a closed page is never skipped in silence", () => {
    for (const destination of new Set(steps.map((s) => s.destination).filter((d): d is string => Boolean(d)))) {
      expect(steps.some((s) => s.destination === destination && s.closedText), `${role} ${destination}`).toBeTruthy();
    }
  });
  it("gives every step to a person who can open every page", () => {
    const plan = planTour(open(role));
    expect(plan).toHaveLength(count);
    expect(plan.every((p) => p.closed === false)).toBe(true);
    expect(plan.map((p) => p.number)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(plan.every((p) => p.of === count)).toBe(true);
  });
});

describe("the shared steps are the admin tour's own words", () => {
  const admin = (id: string) => ADMIN_TOUR_STEPS.find((s) => s.id === id) as TourStep;
  it("office reuses the quotes, jobs and main button steps exactly", () => {
    for (const id of ["attention", "quotes", "new-quote", "send-quote", "decide-quote", "jobs", "job-buttons", "main-buttons", "done"]) {
      const step = OFFICE_TOUR_STEPS.find((s) => s.id === id) as TourStep;
      expect(step, id).toBeTruthy();
      expect({ ...step, n: 0 }).toEqual({ ...admin(id), n: 0 });
    }
  });
  it("workshop reuses the jobs, filters and done steps exactly", () => {
    for (const id of ["jobs", "job-filters", "done"]) {
      const step = WORKSHOP_TOUR_STEPS.find((s) => s.id === id) as TourStep;
      expect(step, id).toBeTruthy();
      expect({ ...step, n: 0 }).toEqual({ ...admin(id), n: 0 });
    }
  });
  it("the admin tour itself is still the 23 steps, admin only", () => {
    expect(ADMIN_TOUR_STEPS).toHaveLength(23);
    expect(planAdminTour(open("admin"))).toHaveLength(23);
    for (const role of ["office", "workshop", "viewer"]) expect(planAdminTour(open(role))).toEqual([]);
  });
});

describe("planTour", () => {
  it("is empty for a viewer and for no role", () => {
    for (const role of ["viewer", "", null, undefined]) expect(planTour(open(role as string))).toEqual([]);
  });
  it("gives the admin the 23 admin steps", () => {
    expect(planTour(open("admin"))).toHaveLength(23);
  });
  it("tells an office person a page is off once, and skips the rest of it, when the section is hidden for them", () => {
    const plan = planTour({ ...open("office"), hiddenSections: ["quotes"] });
    expect(plan.filter((p) => p.closed).map((p) => p.text)).toEqual(["Quotes are switched off for you, so I will skip the quotes part."]);
    expect(plan).toHaveLength(OFFICE_TOUR_STEPS.length - 3);
    expect(plan.some((p) => p.route === "/quotes")).toBe(false);
    expect(plan.every((p, i) => p.number === i + 1 && p.of === plan.length)).toBe(true);
  });
  it("never walks office to the pages of the sections an admin hid from them", () => {
    const plan = planTour({ ...open("office"), hiddenSections: ["invoices", "purchase-orders", "approval", "delivery-notes", "customers"] });
    const routes = plan.filter((p) => !p.closed).map((p) => p.route);
    for (const gone of ["/invoices", "/purchase-orders", "/approval", "/delivery-notes", "/customers"]) expect(routes).not.toContain(gone);
    for (const closedText of ["Invoicing is switched off for you, so I will skip it.", "Customers are switched off for you, so I will skip customers and suppliers."]) {
      expect(plan.some((p) => p.closed && p.text === closedText)).toBe(true);
    }
  });
  it("lets workshop see the job, schedule, delivery note and hours pages only, and nothing for quotes or invoices", () => {
    const routes = new Set(planTour(open("workshop")).map((p) => p.route));
    for (const page of routes) expect(["/dashboard", "/jobs", "/schedule", "/delivery-notes", "/time"], page).toContain(page);
  });
  it("skips the workshop job steps when the Job Board is hidden for the person, and renumbers", () => {
    const plan = planTour({ ...open("workshop"), hiddenSections: ["jobs"] });
    expect(plan.some((p) => p.route === "/jobs")).toBe(false);
    expect(plan.every((p, i) => p.number === i + 1 && p.of === plan.length)).toBe(true);
  });
  it("points the menu step at the menu button on a phone, for office and workshop too", () => {
    for (const role of ["office", "workshop"]) {
      const menu = (phone: boolean) => planTour({ ...open(role), phone }).find((p) => p.step.id === "menu")?.target;
      expect(menu(false)).toMatchObject({ kind: "css", selector: "aside" });
      expect(menu(true)).toMatchObject({ kind: "css", selector: '[aria-label="Open menu"]' });
    }
  });
});

describe("the new file points and never acts", () => {
  const src = readFileSync(path.join(ROOT, "components/tooly/tour/role-tour-steps.ts"), "utf8");
  it("has no click, submit, dispatch, fetch or AI call", () => {
    for (const bad of [/\.click\(/, /\.submit\(/, /dispatchEvent/, /fetch\(/, /\.rpc\(/, /ai-helper/i, /openai|anthropic|xai/i]) expect(src).not.toMatch(bad);
  });
  it("adds no database or settings code: it only imports the admin step types", () => {
    const imports = src.split("\n").filter((line) => line.startsWith("import "));
    expect(imports).toEqual(['import { ADMIN_TOUR_STEPS, type TourStep, type TourTarget } from "@/components/tooly/tour/tour-steps";']);
  });
  it("the shell, the layout, the float and the sidebar are not changed by this feature", () => {
    const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
    expect(read("components/dashboard-shell.tsx")).toMatch(/<AdminTour envOn=\{toolyTour\} \/>/);
    for (const file of ["components/tooly/tooly-float.tsx", "components/sidebar.tsx", "middleware.ts"]) expect(read(file), file).not.toMatch(/AdminTour|admin-tour|role-tour|tooly-office-tour|tooly-workshop-tour/);
  });
});
