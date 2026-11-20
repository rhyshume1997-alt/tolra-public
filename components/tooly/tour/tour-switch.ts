/**
 * BOUNDARY (Tooly, first-login admin tour): the two switches that must BOTH be on before the tour can show. Both are off by default.
 *  1. The server env flag TOOLY_ADMIN_TOUR_ENABLED, exactly "true" (unset or anything else is off). Read on the server only; the dashboard
 *     layout hands the browser a plain boolean (that wiring is the shell PR, not this file).
 *  2. A per-company marker in organization_settings.hidden_nav, "tooly-admin-tour:on". No database change: the same positive-marker
 *     pattern as lib/reports/reports-switch.ts. Absent means off.
 * Plus the role rule: admin only.
 *
 * Inputs: an env object, the company's hidden_nav list, the active role. Outputs: booleans and the {add, remove} change a later Settings
 * screen would apply (nothing is wired to it yet, so the marker is set by an admin only after Rhys's go for that company).
 * Must not change: the marker text and env name (stored in companies' settings / Vercel), the default of off, or the admin-only rule.
 * Pure (no React, no I/O). It does not touch AI: the tour works with AI off.
 */

export const TOOLY_TOUR_ENV_FLAG = "TOOLY_ADMIN_TOUR_ENABLED";
export const TOOLY_TOUR_ON_MARKER = "tooly-admin-tour:on";

/** On only when the env var is exactly "true". */
export function toolyTourEnvEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TOOLY_TOUR_ENV_FLAG] === "true";
}

/** On only when the company marker is present. */
export function toolyTourMarkerOn(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(TOOLY_TOUR_ON_MARKER));
}

/** The tour may show only when the server flag, the company marker and the admin role all agree. */
export function toolyTourEnabled(input: { envOn: boolean; hiddenNav?: readonly string[] | null; role?: string | null }): boolean {
  return input.envOn === true && toolyTourMarkerOn(input.hiddenNav) && input.role === "admin";
}

/** The hidden_nav change that switches the tour on or off for a company. */
export function toolyTourSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [TOOLY_TOUR_ON_MARKER], remove: [] } : { add: [], remove: [TOOLY_TOUR_ON_MARKER] };
}
