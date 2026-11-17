/**
 * The Reports switch. The operations reports page is OFF by default. No database change: the choice lives in the company's existing
 * organization_settings.hidden_nav list as a positive marker, the same way as lib/jobs/planned-vs-actual-switch.ts.
 *
 * Inputs: the company's hidden_nav list and the signed-in role. Outputs: booleans and the {add, remove} change a later Settings screen
 * would apply (nothing is wired to it yet).
 * Must not change: the marker text (it is stored in companies' settings), the default of off, or the admin-and-office-only rule.
 * Pure (no React, no I/O).
 */

/** Stored in hidden_nav when an admin has switched Reports on. Absent (the default) means off. */
export const REPORTS_ON_MARKER = "reports:on";

export const REPORTS_OFF_NOTICE = "Reports are switched off for your company.";

/** On only when the marker is present. */
export function reportsEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(REPORTS_ON_MARKER));
}

/** Only admin and office (not workshop, not viewer, not a missing role). */
export function canSeeReports(role?: string | null): boolean {
  return role === "admin" || role === "office";
}

/** The hidden_nav change that switches Reports on or off. */
export function reportsSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [REPORTS_ON_MARKER], remove: [] } : { add: [], remove: [REPORTS_ON_MARKER] };
}
