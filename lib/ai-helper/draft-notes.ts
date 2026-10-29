/**
 * The AI flags a saved draft quote carries, in its EXISTING internal notes (quotes.internal_notes: team only, never on the customer's
 * PDF or email; shown in the quote view and the draft editor). No new column: the first line marks the draft "AI-suggested", and each
 * thing a person must still check is one "Needs human review:" line. The Approve route writes them (lib/ai-helper/approve.ts); the
 * quote view reads them back to show the flags (app/(dashboard)/quotes/page.tsx). Plain code, no I/O, safe in the browser.
 */
import type { ReviewField } from "@/lib/ai-helper/rfq";

export const AI_SUGGESTED_LINE = "AI-suggested: drafted by the AI helper from a pasted RFQ email, then checked and approved by a person.";
export const NEEDS_REVIEW_PREFIX = "Needs human review: ";

const FIELD_TEXT: Record<ReviewField, string> = {
  description: "description", part_number: "part number", material: "material", finish: "finish", quantity: "quantity", due_date: "due date", price: "price",
};
const ORDER: ReviewField[] = ["description", "part_number", "material", "finish", "quantity", "due_date", "price"];

export type DraftFlags = {
  customerKnown: boolean;
  suspicious: boolean;
  truncated: boolean;
  /** Per saved line (in the draft's own order), what still needs checking. */
  lines: { review: ReviewField[] }[];
};

/** The internal notes for an AI draft: the AI-suggested line, then one line per thing to check (2000 characters at most). */
export function aiDraftNotes(flags: DraftFlags): string {
  const review: string[] = [];
  if (flags.suspicious) review.push("the email held text that reads like instructions to the AI; it was treated as plain text. Check every field.");
  if (flags.truncated) review.push("only the first lines of the email were read; add the rest by hand.");
  if (!flags.customerKnown) review.push("customer (not found in your customers)");
  flags.lines.forEach((line, i) => {
    const fields = ORDER.filter((f) => line.review.includes(f));
    if (fields.length) review.push(`line ${i + 1}: ${fields.map((f) => FIELD_TEXT[f]).join(", ")}${fields.includes("price") ? " (saved at £0.00)" : ""}`);
  });
  const text = [AI_SUGGESTED_LINE, ...review.map((r) => `${NEEDS_REVIEW_PREFIX}${r}`)].join("\n");
  return text.length > 2000 ? `${text.slice(0, 1997).trimEnd()}...` : text;
}

/** Reads the flags back from a quote's internal notes: whether it is AI-suggested, and each "Needs human review" item. */
export function readAiDraftNotes(notes: string | null | undefined): { aiSuggested: boolean; review: string[] } {
  const lines = (notes ?? "").split(/\r?\n/);
  const aiSuggested = lines[0]?.startsWith("AI-suggested:") === true;
  return { aiSuggested, review: aiSuggested ? lines.filter((l) => l.startsWith(NEEDS_REVIEW_PREFIX)).map((l) => l.slice(NEEDS_REVIEW_PREFIX.length)) : [] };
}
