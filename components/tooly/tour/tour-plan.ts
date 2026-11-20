/**
 * BOUNDARY (Tooly, first-login admin tour): turns the 23 fixed steps into the list this person really sees.
 * Inputs: the active role, the person's hidden sections, the company's hidden_nav list, and whether the screen is a phone.
 * Outputs: PlannedStep[] (text, route, target to point at). Empty for anyone who is not an admin.
 * Reuses lib/destinations canOpenDestination, so a page that would not open for this person is never walked to.
 * Must not change: that this never adds a step, never makes up words (only the fixed text or closedText), and never grants access.
 * Pure (no React, no I/O).
 */
import { canOpenDestination } from "@/lib/destinations";
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

export function planAdminTour(input: PlanInput): PlannedStep[] {
  if (input.activeRole !== "admin") return [];
  const role = ROLES.find((r) => r === input.activeRole);
  if (!role) return [];
  const kept: Omit<PlannedStep, "number" | "of">[] = [];
  for (const step of ADMIN_TOUR_STEPS) {
    const open = !step.destination || canOpenDestination(step.destination, { activeRole: role, hiddenSections: input.hiddenSections, hiddenNav: input.hiddenNav ?? undefined });
    if (open) kept.push({ step, text: step.text, route: step.route, target: targetFor(step.target, input.phone), closed: false });
    else if (step.closedText) kept.push({ step, text: step.closedText, route: "/dashboard", target: { kind: "none" }, closed: true });
  }
  return kept.map((item, i) => ({ ...item, number: i + 1, of: kept.length }));
}
