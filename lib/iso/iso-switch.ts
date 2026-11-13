/**
 * The ISO templates switch (admin only). The page (branded draft templates and a self-check list) is OFF by default. No database
 * change: the choice lives in the company's existing organization_settings.hidden_nav list, as a positive marker, the same way as
 * lib/sales-orders-switch.ts. The admin-only switch card on the ISO templates page (components/iso/iso-switch-card.tsx) saves the
 * list built by nextIsoHiddenNav through saveOrgSettings; nothing in this file writes settings itself.
 *
 * Inputs: the company's hidden_nav list and the signed-in role. Outputs: whether the page is on, who may see it, and the hidden_nav
 * change that switches it on or off.
 * Must not change: the marker text (stored in a company's settings once used) and the admin-only rule.
 *
 * Pure (no React, no browser, no I/O) so the page and the tests share one rule.
 */
import type { UserRole } from "@/types";

/** Stored in hidden_nav when an admin has switched the ISO templates on. Absent (the default) means off. */
export const ISO_TEMPLATES_ON_MARKER = "iso-templates:on";

export const ISO_OFF_NOTICE = "ISO templates are switched off for your company.";

/** On only when the marker is present. */
export function isoTemplatesEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(ISO_TEMPLATES_ON_MARKER));
}

/** Admin only: office, workshop, viewer and anything unknown are refused. */
export function canSeeIso(role: UserRole | string | null | undefined): boolean {
  return role === "admin";
}

/** The hidden_nav change that switches the templates on or off. */
export function isoSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [ISO_TEMPLATES_ON_MARKER], remove: [] } : { add: [], remove: [ISO_TEMPLATES_ON_MARKER] };
}

/** The full hidden_nav list after switching on or off: every other entry is kept in order, only the marker is added or removed. Never mutates `current`; repeating it changes nothing. */
export function nextIsoHiddenNav(current: readonly string[], on: boolean): string[] {
  const kept = current.filter((entry) => entry !== ISO_TEMPLATES_ON_MARKER);
  return on ? [...kept, ISO_TEMPLATES_ON_MARKER] : kept;
}
