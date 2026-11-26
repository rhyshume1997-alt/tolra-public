/**
 * The Pricing and profit "Costing" switch (Settings, stage A1). OFF by default. No database change: the choice lives in the company's existing
 * organization_settings.hidden_nav list as a positive marker, the same way as lib/iso/iso-switch.ts. The admin-only switch card in Settings
 * (components/costing/pricing-costs-card.tsx) saves the list built by nextPricingCostsHiddenNav through saveOrgSettings; nothing here writes.
 *
 * Inputs: the company's hidden_nav list and the signed-in role. Outputs: whether the section is on, who may switch it, and the new list.
 * Must not change: the marker text (stored in a company's settings once used) and the admin-only rule. Off means no section, no database read.
 * Pure (no React, no browser, no I/O) so the card and the tests share one rule.
 */
import type { UserRole } from "@/types";

/** Stored in hidden_nav when an admin has switched Costing on. Absent (the default) means off. */
export const PRICING_COSTS_ON_MARKER = "pricing-costs:on";

/** On only when the marker is present. */
export function pricingCostsEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(PRICING_COSTS_ON_MARKER));
}

/** Admin only: office, workshop, viewer and anything unknown are refused (Settings itself is admin-only). */
export function canSwitchPricingCosts(role: UserRole | string | null | undefined): boolean {
  return role === "admin";
}

/** The full hidden_nav list after switching on or off: every other entry is kept in order, only the marker is added or removed. Never mutates `current`. */
export function nextPricingCostsHiddenNav(current: readonly string[], on: boolean): string[] {
  const kept = current.filter((entry) => entry !== PRICING_COSTS_ON_MARKER);
  return on ? [...kept, PRICING_COSTS_ON_MARKER] : kept;
}
