/**
 * The "Planned vs actual time" switch for a job's worksheet. OFF by default. No database change: the choice lives in the company's
 * existing organization_settings.hidden_nav list as a positive marker, exactly like lib/sales-orders-switch.ts.
 *
 * Inputs: the company's hidden_nav list, and the person's active role. Outputs: booleans, and the {add, remove} change a later
 * Settings screen would apply (nothing is wired to it yet).
 * Must not change: the marker text (it is stored in companies' settings), the default of off, or the role list without a decision.
 * Pure (no React, no I/O).
 */

/** Stored in hidden_nav when an admin has switched planned vs actual on. Absent (the default) means off. */
export const JOB_TIME_VARIANCE_ON_MARKER = "job-time-variance:on";

/** On only when the marker is present. */
export function plannedVsActualEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(JOB_TIME_VARIANCE_ON_MARKER));
}

/** Only admin and office see it (not workshop, not viewer, not a missing role). */
export function canSeePlannedVsActual(role?: string | null): boolean {
  return role === "admin" || role === "office";
}

/** The hidden_nav change that switches it on or off. */
export function plannedVsActualSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [JOB_TIME_VARIANCE_ON_MARKER], remove: [] } : { add: [], remove: [JOB_TIME_VARIANCE_ON_MARKER] };
}
