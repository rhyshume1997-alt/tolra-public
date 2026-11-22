/**
 * BOUNDARY (Tooly, scripted tours): when the tour may show. DEFAULT: ON for every company (Rhys's decision): no env var and no company
 * marker is needed to see it. The tour card then opens by itself for admin, office and workshop until the person has seen it (the saved
 * flag in lib/auth/tour-flag.ts), and Skip tour and Replay still work. A viewer never gets one.
 * The one way to turn it OFF is the emergency server switch TOOLY_TOUR_DISABLED, exactly "true" (unset or anything else leaves it on).
 * Read on the server only; the dashboard layout hands the browser a plain boolean.
 * The older env flag TOOLY_ADMIN_TOUR_ENABLED and the per-company markers (tooly-admin-tour:on, tooly-office-tour:on,
 * tooly-workshop-tour:on) are no longer read by the tour card. Their exports below stay so nothing that imports them breaks; they decide nothing.
 *
 * Inputs: an env object, the active role. Outputs: booleans. Pure (no React, no I/O). It does not touch AI: the tour works with AI off.
 * Must not change: the TOOLY_TOUR_DISABLED name (set in Vercel), that "true" is the only value that turns the tour off, or that a viewer
 * gets no tour.
 */

export const TOOLY_TOUR_ENV_FLAG = "TOOLY_ADMIN_TOUR_ENABLED";
export const TOOLY_TOUR_ON_MARKER = "tooly-admin-tour:on";

/** The emergency off switch. Unset (or anything but exactly "true") leaves the tour on. */
export const TOOLY_TOUR_DISABLE_ENV_FLAG = "TOOLY_TOUR_DISABLED";

/** On unless TOOLY_TOUR_DISABLED is exactly "true". (Name kept: the dashboard layout calls it and hands the shell the boolean.) */
export function toolyTourEnvEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TOOLY_TOUR_DISABLE_ENV_FLAG] !== "true";
}

/** Legacy, no longer read by the tour card. True only when the company marker is present. */
export function toolyTourMarkerOn(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(TOOLY_TOUR_ON_MARKER));
}

/** Legacy (admin only, marker needed), no longer read by the tour card. */
export function toolyTourEnabled(input: { envOn: boolean; hiddenNav?: readonly string[] | null; role?: string | null }): boolean {
  return input.envOn === true && toolyTourMarkerOn(input.hiddenNav) && input.role === "admin";
}

/** The hidden_nav change that switches the tour on or off for a company. */
export function toolyTourSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [TOOLY_TOUR_ON_MARKER], remove: [] } : { add: [], remove: [TOOLY_TOUR_ON_MARKER] };
}

export const TOOLY_OFFICE_TOUR_ON_MARKER = "tooly-office-tour:on";
export const TOOLY_WORKSHOP_TOUR_ON_MARKER = "tooly-workshop-tour:on";

export type TourRole = "admin" | "office" | "workshop";

/** The company marker that switches this view's tour on, or null for a view that has no tour (a viewer, anything else). */
export function toolyTourMarkerFor(role: string | null | undefined): string | null {
  if (role === "admin") return TOOLY_TOUR_ON_MARKER;
  if (role === "office") return TOOLY_OFFICE_TOUR_ON_MARKER;
  if (role === "workshop") return TOOLY_WORKSHOP_TOUR_ON_MARKER;
  return null;
}

/** The tour for the person's view may show when the server switch has not turned it off. A viewer never gets one. Company markers are not read. */
export function toolyTourEnabledFor(input: { envOn: boolean; hiddenNav?: readonly string[] | null; role?: string | null }): boolean {
  return input.envOn === true && toolyTourMarkerFor(input.role) !== null;
}

/** The hidden_nav change that switches one view's tour on or off for a company. */
export function toolyTourSwitchChangeFor(role: TourRole, on: boolean): { add: string[]; remove: string[] } {
  const marker = toolyTourMarkerFor(role) as string;
  return on ? { add: [marker], remove: [] } : { add: [], remove: [marker] };
}
