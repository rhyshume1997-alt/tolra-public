/**
 * Module K (worksheet builder): the on/off switch. The builder is OFF by default. No database change: the choice lives in the company's
 * existing organization_settings.hidden_nav list as a positive marker, exactly like lib/reports/reports-switch.ts.
 *
 * Inputs: the company's hidden_nav list and the signed-in role. Outputs: booleans, and the {add, remove} change the Settings card applies.
 * Must not change: the marker text (it is stored in companies' settings), the default of off, or the admin-only rule for the builder.
 * With the switch off nothing about printing changes: Basic and JNR sheet print exactly as before and no custom layout is offered.
 * Pure (no React, no I/O).
 */

/** Stored in hidden_nav when an admin has switched the worksheet builder on. Absent (the default) means off. */
export const WORKSHEET_BUILDER_ON_MARKER = "worksheet-builder:on";

/** On only when the marker is present. */
export function worksheetBuilderEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(WORKSHEET_BUILDER_ON_MARKER));
}

/** Only an admin designs worksheets (Settings is admin only; the 006 trigger refuses anyone else saving the company profile). */
export function canDesignWorksheets(role?: string | null): boolean {
  return role === "admin";
}

/** The hidden_nav change that switches the builder on or off. */
export function worksheetBuilderSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [WORKSHEET_BUILDER_ON_MARKER], remove: [] } : { add: [], remove: [WORKSHEET_BUILDER_ON_MARKER] };
}

/** The hidden_nav list after a switch change: every other entry is kept in order. */
export function applyHiddenNavChange(current: readonly string[], change: { add: string[]; remove: string[] }): string[] {
  const kept = current.filter((entry) => !change.remove.includes(entry));
  return [...kept, ...change.add.filter((entry) => !kept.includes(entry))];
}
