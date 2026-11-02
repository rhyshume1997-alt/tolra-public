// Late-payer chasing (migration 138): the Settings side of a company's chase steps (the suggested steps, labels, the form's rules) and
// when a pause is in force. Pure. WHICH step an invoice is due for is lib/chasing/steps.ts (dueChaseSteps, TODO-CHATGPT); which template
// a tone uses is lib/chasing/templates.ts. On or before the due date (offset <= 0) a step's tone is always "before_due"; after it,
// friendly, firm or final (the database holds the same rule: chase_steps_tone_fits).
import { CHASE_TONES, type ChaseStep, type ChaseTone } from "@/lib/chasing/steps";

export { CHASE_TONES, type ChaseStep, type ChaseTone };

export const MAX_STEPS = 10;
export const MIN_OFFSET = -60;
export const MAX_OFFSET = 365;

/** The suggested steps (Settings offers them when a company has none): 3 days before due, then 7, 14 and 30 days after. */
export const DEFAULT_CHASE_STEPS: ReadonlyArray<Omit<ChaseStep, "id">> = [
  { offset_days: -3, tone: "before_due" },
  { offset_days: 7, tone: "friendly" },
  { offset_days: 14, tone: "firm" },
  { offset_days: 30, tone: "final" },
];

export const TONE_LABEL: Record<ChaseTone, string> = { before_due: "Before due (nudge)", friendly: "Friendly", firm: "Firm", final: "Final" };

export const isChaseTone = (value: unknown): value is ChaseTone => typeof value === "string" && (CHASE_TONES as readonly string[]).includes(value);

/** "3 days before due" / "On the due date" / "1 day after due". */
export function offsetLabel(offset: number): string {
  if (offset === 0) return "On the due date";
  const n = Math.abs(offset);
  return `${n} day${n === 1 ? "" : "s"} ${offset < 0 ? "before" : "after"} due`;
}

/** The tone a step must have for its offset: before_due on or before the due date; otherwise the one chosen (friendly when it was before_due). */
export function toneFor(offset: number, tone: ChaseTone): ChaseTone {
  if (offset <= 0) return "before_due";
  return tone === "before_due" ? "friendly" : tone;
}

export type StepDraft = { id?: string; offset: string; tone: ChaseTone };

/** Checks the Settings form's steps before saving (the database's rules, in plain words). Null when fine. */
export function stepsProblem(rows: readonly StepDraft[]): string | null {
  if (rows.length > MAX_STEPS) return `At most ${MAX_STEPS} chase steps.`;
  const seen = new Set<number>();
  for (const row of rows) {
    const text = row.offset.trim();
    if (!/^-?\d{1,3}$/.test(text)) return "Each step needs a whole number of days (use a minus sign for days before the due date).";
    const offset = Number(text);
    if (offset < MIN_OFFSET || offset > MAX_OFFSET) return `Days must be between ${MIN_OFFSET} and ${MAX_OFFSET}.`;
    if (seen.has(offset)) return "Two steps can't have the same number of days.";
    seen.add(offset);
    if (!isChaseTone(row.tone)) return "Choose a tone for each step.";
    if ((offset <= 0) !== (row.tone === "before_due")) return offset <= 0 ? "A step on or before the due date is a before-due nudge." : "A step after the due date is friendly, firm or final.";
  }
  return null;
}

/** A pause is in force on `today` (YYYY-MM-DD) when it has no last day, or its last day is today or later (inclusive). */
export const pauseActive = (until: string | null | undefined, today: string) => !until || String(until).slice(0, 10) >= today;
