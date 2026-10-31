import type { ViewMode } from "@/lib/view-mode";

/**
 * What the shell shows about who is working and whether the device is connected, in one place so the top bar chip, the
 * drawer and the tests say the same thing. Pure: no browser or Supabase here.
 */

/** Widest screen that still uses the drawer for navigation and cards / compact lists for records (CSS: the "desk" breakpoint starts one pixel above). */
export const DRAWER_MAX_WIDTH = 1024;
/** Media query that is true when the fixed sidebar and dense tables are in use. */
export const DESK_QUERY = `(min-width: ${DRAWER_MAX_WIDTH + 1}px)`;

export type ConnectionKind = "online" | "offline" | "pending" | "attention";
export type ConnectionState = { kind: ConnectionKind; /** Short word(s) for the chip. */ label: string; /** Colour of the dot. */ tone: "good" | "warn" };

/**
 * `offline`: pages are showing this device's copy. `pending`: offline changes waiting to be sent. `attention`: a change made
 * offline was refused or clashed and is held for a person (conflicts / rejected in the offline status).
 */
export function connectionState(status: { offline: boolean; pending: number; conflicts?: readonly unknown[]; rejected?: readonly unknown[] }): ConnectionState {
  const held = (status.conflicts?.length ?? 0) + (status.rejected?.length ?? 0);
  if (held) return { kind: "attention", label: "Upload failed", tone: "warn" };
  if (status.offline) return { kind: "offline", label: status.pending ? `Offline, ${status.pending} to sync` : "Offline", tone: "warn" };
  if (status.pending) return { kind: "pending", label: `${status.pending} to sync`, tone: "warn" };
  return { kind: "online", label: "Online", tone: "good" };
}

export function roleLabel(role?: string | null) {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : "Loading";
}

/** One sentence for assistive technology and tooltips: "Admin view, Acme Ltd, Online". */
export function shellStatusSummary(input: { role?: string | null; company?: string | null; connection: ConnectionState }) {
  return [`${roleLabel(input.role)} view`, input.company?.trim() || null, input.connection.label].filter(Boolean).join(", ");
}

/**
 * Dense tables only where the screen supports them (wider than 1024px). On a phone or tablet a chosen "table" is shown as
 * cards; "cards" and the compact "list" are shown as chosen, except on a page whose list is a wide table with sticky columns (the Job Board:
 * `listNeedsWide`), where "list" is shown as cards too. The choice itself is kept, so it returns on a wide screen.
 */
export function effectiveViewMode(mode: ViewMode, wide: boolean, listNeedsWide = false): ViewMode {
  return !wide && (mode === "table" || (listNeedsWide && mode === "list")) ? "cards" : mode;
}
