/*
 * BOUNDARY (module 7, shared UI, NEW v5). Inputs: the words that are DRAWN on a control (visible) and optional extra detail for assistive technology (detail).
 * Output: pure helpers for aria-labels that must contain the visible text (WCAG 2.5.3 label in name, axe "label-content-name-mismatch"): nameWithVisible builds "<visible>, <detail>" so the name always STARTS with the drawn words; nameContainsVisible checks it.
 * Use it for schedule bars, link tiles and any button whose aria-label is longer than its text. It has no React, no DOM and no data.
 * Must not change: the visible text is never rewritten (only whitespace is collapsed for the comparison); detail never replaces the drawn words.
 */

const squash = (t: string) => t.replace(/\s+/g, " ").trim();
const fold = (t: string) => squash(t).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();

/** An accessible name that starts with the visible words: "J-0437 Lathe 2" + "due Friday, running" gives "J-0437 Lathe 2, due Friday, running". Empty detail returns the visible words; a detail that already starts with them is not repeated. */
export function nameWithVisible(visible: string, detail?: string): string {
  const v = squash(visible);
  const d = squash(detail ?? "");
  if (!d) return v;
  if (fold(d).startsWith(fold(v)) && fold(v)) return d;
  return v ? `${v}, ${d}` : d;
}

/** True when the accessible name contains the visible text (case, punctuation and spacing ignored, as the checkers do). An empty visible text always passes. */
export function nameContainsVisible(name: string, visible: string): boolean {
  const v = fold(visible);
  return !v || fold(name).includes(v);
}
