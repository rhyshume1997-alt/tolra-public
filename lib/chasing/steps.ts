// THE CHASE STEP-SELECTION INTERFACE (migration 138). ChatGPT writes the real selection logic here (branch chatgpt/chase-steps, Rhys,
// 2 Nov); this file is a minimal STUB so the joining-up (the pass, the database, Settings, Approvals) can be built and tested.
//
// TODO-CHATGPT: replace dueChaseSteps with the agreed algorithm. Keep the names and types below, or change the callers with it:
//   lib/email/chase/run.ts (the scheduled pass and Chase All Overdue) drafts every step this returns for an invoice, in order.
// The database (public.chase_create_draft) refuses whatever must never happen, whatever this returns: a step before its day, a step
// already used on the invoice, an invoice that is paid / void / credited / written off / a draft / payment to confirm / no balance /
// paused. It does NOT decide which of the steps reached is drafted: that is this function's job.

export const CHASE_TONES = ["before_due", "friendly", "firm", "final"] as const;
export type ChaseTone = (typeof CHASE_TONES)[number];
/** A company's step (public.chase_steps): an offset in days from the due date (negative = before it) and a tone. */
export type ChaseStep = { id: string; offset_days: number; tone: ChaseTone };
/** What has already been drafted (or sent) for one invoice (public.chase_sends): the step ids and their offsets as they were then. */
export type ChaseHistory = { stepIds: string[]; offsets: number[] };

/**
 * The steps to draft today for one invoice. `daysFromDue`: today minus the invoice's due date in whole days (negative = not yet due).
 * TODO-CHATGPT. STUB ONLY: every step reached (offset <= daysFromDue) and not yet used on this invoice, earliest first. It does not
 * choose between several steps reached at once (a pass that starts late would draft each of them).
 */
export function dueChaseSteps(steps: readonly ChaseStep[], daysFromDue: number, history: ChaseHistory = { stepIds: [], offsets: [] }): ChaseStep[] {
  if (!Number.isInteger(daysFromDue)) return [];
  return steps.filter((s) => Number.isInteger(s.offset_days) && s.offset_days <= daysFromDue && !history.stepIds.includes(s.id)).sort((a, b) => a.offset_days - b.offset_days);
}
