/**
 * The Revenue reports switch (Reporting, stage 1). OFF by default. No database change: the choice lives in the company's existing
 * organization_settings.hidden_nav list as a positive marker, exactly like lib/sales-orders-switch.ts.
 *
 * Inputs: the company's hidden_nav list, and the person's active role. Outputs: booleans, the off notice, and the {add, remove}
 * change a later Settings screen would apply (nothing is wired to it yet).
 * Must not change: the marker text (it is stored in companies' settings), the default of off, or the role list without a decision.
 * Pure (no React, no I/O).
 */

/** Stored in hidden_nav when an admin has switched Revenue reports on. Absent (the default) means off. */
export const REVENUE_ON_MARKER = "reports-revenue:on";

export const REVENUE_OFF_NOTICE = "Revenue reports are switched off for your company.";

/** On only when the marker is present. */
export function revenueEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(REVENUE_ON_MARKER));
}

/** Only admin and office see revenue (not workshop, not viewer, not a missing role). */
export function canSeeRevenue(role?: string | null): boolean {
  return role === "admin" || role === "office";
}

/** The hidden_nav change that switches Revenue reports on or off. */
export function revenueSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [REVENUE_ON_MARKER], remove: [] } : { add: [], remove: [REVENUE_ON_MARKER] };
}
