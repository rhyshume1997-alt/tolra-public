// THE CHASE STEP-SELECTION ADAPTER (migration 138). The selection rule is ChatGPT's (lib/chase/steps.ts dueSteps, branch
// chatgpt/chase-steps): at most ONE step per invoice per run, the latest one reached and not yet sent. This file only maps the app's
// shapes onto it. The database (public.chase_create_draft) still refuses whatever must never happen, whatever this returns: a step before
// its day, a step already used on the invoice, an invoice that is paid / void / credited / written off / a draft / payment to confirm /
// no balance / paused.
import { dueSteps } from "@/lib/chase/steps";

export const CHASE_TONES = ["before_due", "friendly", "firm", "final"] as const;
export type ChaseTone = (typeof CHASE_TONES)[number];
/** A company's step (public.chase_steps): an offset in days from the due date (negative = before it) and a tone. */
export type ChaseStep = { id: string; offset_days: number; tone: ChaseTone };
/** What has already been drafted (or sent) for one invoice (public.chase_sends): the step ids and their offsets as they were then. */
export type ChaseHistory = { stepIds: string[]; offsets: number[] };
/** The invoice facts the selection needs. `dueDate` and `today` are YYYY-MM-DD; `balancePence` is what is still owed. */
export type ChaseInvoiceFacts = { id: string; dueDate: string; balancePence: number; paused: boolean };

/**
 * The step to draft today for one invoice: none or exactly one. A step older than one already drafted or sent on the invoice is treated
 * as used (history.offsets), so once the final reminder is out the earlier steps are not drafted after it.
 */
export function dueChaseSteps(steps: readonly ChaseStep[], invoice: ChaseInvoiceFacts, today: string, history: ChaseHistory = { stepIds: [], offsets: [] }): ChaseStep[] {
  const latestSent = history.offsets.filter((o) => Number.isInteger(o)).reduce((max, o) => Math.max(max, o), -Infinity);
  const used = new Set(history.stepIds);
  for (const s of steps) if (s.offset_days <= latestSent) used.add(s.id);
  const picked = dueSteps(
    steps.map((s) => ({ id: s.id, offsetDays: s.offset_days, tone: s.tone })),
    { id: invoice.id, dueDate: invoice.dueDate, balancePence: invoice.balancePence, paused: invoice.paused, alreadySentStepIds: [...used] },
    today,
  );
  return picked.flatMap((p) => steps.filter((s) => s.id === p.id));
}
