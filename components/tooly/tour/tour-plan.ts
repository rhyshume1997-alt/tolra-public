/**
 * BOUNDARY (Tooly, scripted tours): turns the fixed steps for the person's view into the list this person really sees: the 23 admin steps
 * (tour-steps.ts), the 17 office steps or the 13 workshop steps (role-tour-steps.ts).
 * Inputs: the active role, the person's hidden sections, the company's hidden_nav list, and whether the screen is a phone.
 * Outputs: PlannedStep[] (text, route, target to point at). planAdminTour is empty for anyone who is not an admin (unchanged);
 * planTour picks the steps by role and is empty for a viewer or anyone else.
 * Reuses lib/destinations canOpenDestination, so a page that would not open for this person is never walked to.
 * Must not change: that this never adds a step, never makes up words (only the fixed text or closedText), and never grants access.
 * Pure (no React, no I/O).
 */
import { canOpenDestination } from "@/lib/destinations";
import { OFFICE_TOUR_STEPS, WORKSHOP_TOUR_STEPS } from "@/components/tooly/tour/role-tour-steps";
import { ADMIN_TOUR_STEPS, type TourStep, type TourTarget } from "@/components/tooly/tour/tour-steps";

export type PlannedStep = { step: TourStep; text: string; route: string; target: TourTarget; closed: boolean; number: number; of: number };

export type PlanInput = {
  activeRole: string | null | undefined;
  hiddenSections: readonly string[];
  hiddenNav?: readonly string[] | null;
  phone: boolean;
};

const ROLES = ["admin", "office", "workshop", "viewer"] as const;

/** The target to look for: on a phone the phone selector (the menu is a drawer) when the step has one. */
export function targetFor(target: TourTarget, phone: boolean): TourTarget {
  return target.kind === "css" && phone && target.phoneSelector ? { kind: "css", selector: target.phoneSelector } : target;
}

function planSteps(steps: readonly TourStep[], input: PlanInput): PlannedStep[] {
  const role = ROLES.find((r) => r === input.activeRole);
  if (!role) return [];
  const kept: Omit<PlannedStep, "number" | "of">[] = [];
  for (const step of steps) {
    const open = !step.destination || canOpenDestination(step.destination, { activeRole: role, hiddenSections: input.hiddenSections, hiddenNav: input.hiddenNav ?? undefined });
    if (open) kept.push({ step, text: step.text, route: step.route, target: targetFor(step.target, input.phone), closed: false });
    else if (step.closedText) kept.push({ step, text: step.closedText, route: "/dashboard", target: { kind: "none" }, closed: true });
  }
  return kept.map((item, i) => ({ ...item, number: i + 1, of: kept.length }));
}

export function planAdminTour(input: PlanInput): PlannedStep[] {
  if (input.activeRole !== "admin") return [];
  return planSteps(ADMIN_TOUR_STEPS, input);
}

/** The tour for the view the person is working in: admin, office or workshop. A viewer (or anyone else) gets none. */
export function planTour(input: PlanInput): PlannedStep[] {
  if (input.activeRole === "admin") return planSteps(ADMIN_TOUR_STEPS, input);
  if (input.activeRole === "office") return planSteps(OFFICE_TOUR_STEPS, input);
  if (input.activeRole === "workshop") return planSteps(WORKSHOP_TOUR_STEPS, input);
  return [];
}
