import { TIME_NEEDS_DATABASE_UPDATE } from "@/lib/time-features";

/** Shown instead of the job sheet, the week, the prints or the settings while the database doesn't have 050 to 052: no Clock in/out, no Save. */
export function NeedsDatabaseUpdate() {
  return <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="status" data-testid="time-needs-update">{TIME_NEEDS_DATABASE_UPDATE}</div>;
}
