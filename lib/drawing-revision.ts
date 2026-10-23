/**
 * The drawing revision a job is made to (ISO 9001 8.2 / 8.5.1, migration 083), only where the job needs it. These mirror
 * set_job_drawing_revision's rules so the screen can say what's missing before it asks the database (which decides).
 */
export type DrawingRevisionState = { required: boolean; revision: string | null; complete: boolean };

export const DRAWING_REVISION_NEEDED = "Drawing revision required before this job can be Complete.";

/** The message shown on a job that needs its drawing revision and has none yet (null otherwise). */
export function drawingRevisionNotice(state: DrawingRevisionState): string | null {
  return state.required && !state.revision?.trim() && !state.complete ? DRAWING_REVISION_NEEDED : null;
}

/** What saving the typed values would change, whether it needs a reason, and what is wrong with them. */
export function drawingRevisionChange(state: DrawingRevisionState, typed: { required: boolean; revision: string }) {
  const revision = typed.revision.trim();
  const revisionChanged = revision !== "" && revision !== (state.revision ?? "");
  const requiredChanged = typed.required !== state.required;
  const changed = revisionChanged || requiredChanged;
  // A revision once entered is replaced (with a reason), never cleared; switching the requirement off also asks why.
  const needsReason = (revisionChanged && state.revision !== null) || (requiredChanged && !typed.required);
  const problem = revision.length > 20 ? "The drawing revision is up to 20 characters." : state.complete && changed ? "This job is Complete: reopen it first." : null;
  return { changed, needsReason, problem };
}
