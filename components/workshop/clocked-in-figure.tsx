/**
 * The Whole floor's "Clocked in" figure (an item in its summary list). The count is worked out by the one rule Weekly hours uses
 * (lib/floor-attendance), and it is read and shown to admin and office only, because the row rules let a workshop person read nobody
 * else's clock records (migration 050): anyone else is told so in words instead of being shown a count of themselves. A dash, never 0,
 * while it loads or when it couldn't be read in full.
 */
import { attendanceReadable, type ClockedIn } from "@/lib/floor-attendance";

const DASH = "—";

export function ClockedInFigure({ role, clocked }: { role: string | null | undefined; clocked: ClockedIn | null }) {
  if (!attendanceReadable(role)) {
    return (
      <li className="inline-flex items-center gap-2 text-base text-muted-foreground" data-testid="floor-clocked-in-note">
        Who is clocked in is shown to office and admin only.
      </li>
    );
  }
  return (
    <li className="inline-flex flex-wrap items-center gap-x-2 text-base" data-testid="floor-clocked-in-item">
      <span className="text-xl font-semibold tabular-nums text-ink" data-testid="floor-clocked-in">{clocked ? String(clocked.clockedIn) : DASH}</span>
      <span className="text-ink">Clocked in</span>
      <span className="text-muted-foreground" data-testid="floor-on-break">{clocked ? `${clocked.onBreak} on a break` : DASH}</span>
    </li>
  );
}
