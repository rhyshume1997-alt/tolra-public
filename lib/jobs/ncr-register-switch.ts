/**
 * The NCR register switch. The register (a read-only report of the nonconformance records Tolra already keeps, for ISO 9001 clause 8.7)
 * is OFF by default. No database change: the choice lives in the company's existing organization_settings.hidden_nav list, as a
 * positive marker, the same way as lib/sales-orders-switch.ts.
 *
 * Inputs: the company's hidden_nav list and the signed-in role. Outputs: whether the register is on, who may see it, and the hidden_nav
 * change that switches it on or off. Not wired to any screen yet: nothing here writes settings.
 * Must not change: the marker text (it is stored in companies' settings once used) and the admin-and-office-only rule.
 *
 * Pure (no React, no browser, no I/O) so the page and the tests share one rule.
 */
import type { UserRole } from "@/types";

/** Stored in hidden_nav when an admin has switched the NCR register on. Absent (the default) means off. */
export const NCR_REGISTER_ON_MARKER = "job-ncr-register:on";

export const NCR_REGISTER_OFF_NOTICE = "The NCR register is switched off for your company.";

/** On only when the marker is present. */
export function ncrRegisterEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(NCR_REGISTER_ON_MARKER));
}

/** Admin and office only: workshop, viewer and anything unknown are refused. */
export function canSeeNcrRegister(role: UserRole | string | null | undefined): boolean {
  return role === "admin" || role === "office";
}

/** The hidden_nav change that switches the register on or off. */
export function ncrRegisterSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [NCR_REGISTER_ON_MARKER], remove: [] } : { add: [], remove: [NCR_REGISTER_ON_MARKER] };
}
