import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { RFQ_MAX_LINES } from "@/lib/ai-helper/limits";
import { type ReviewField, type RfqField, RFQ_FIELDS, clean, lineDescription, realDate, wholeQuantity } from "@/lib/ai-helper/rfq";
import { documentTotals } from "@/lib/money";
import { partField } from "@/lib/quote-versions";
import { ValidationError, parseOrThrow, quoteSaveSchema } from "@/lib/validation/schemas";
import { fromVatChoice, toVatChoice } from "@/lib/vat";

/**
 * The Approve click, done on the SERVER (app/api/ai-helper/rfq/decision/route.ts). The draft is rebuilt from the suggestion the database
 * stored when the AI answered (ai_helper_requests.output), never from lines the browser sends:
 *   - The only browser input is the request id, the decision and, because the panel lets a person correct a line before approving, the
 *     edits below. Edits name a stored line by its index; they can change that line's description, part number, material, finish, due
 *     date and quantity, drop a line (by leaving it out) or correct the customer. They cannot add a line, and they carry NO price field:
 *     the schema is strict, so a body with a price, an extra key or an unknown line index is refused and nothing is saved.
 *   - Every edited value is cleaned by the same rules as the model's answer (lib/ai-helper/rfq.ts clean, wholeQuantity, realDate).
 *   - Prices come only from the costing calculation run here on the server for the caller's company (costingPrices with
 *     serverCostingDeps(org)). A line it can't price is saved at £0.00 and flagged "Needs human review: price"; the person types the
 *     price in the saved draft, in the normal draft editor.
 *   - The customer is checked again against this company's own customers.
 * The draft is created as the Quote Builder creates one: next_doc_number('QUO'), then create_with_lines with status 'draft', under the
 * person's own session (company scoping, role checks, row triggers and audit of that path unchanged). It is never sent or issued.
 */

const nullableText = (max: number) => z.string().max(max).nullable();

/** One kept line as the person left it: a stored line's index and the fields they may correct. No price. */
export const approveLineEditSchema = z.object({
  index: z.number().int().min(0).max(RFQ_MAX_LINES - 1),
  description: nullableText(300),
  partNumber: nullableText(60),
  material: nullableText(120),
  finish: nullableText(120),
  dueDate: nullableText(10),
  quantity: z.number().int().min(1).max(1_000_000).nullable(),
}).strict();

export const approveEditsSchema = z.object({
  customer: z.string().max(200),
  lines: z.array(approveLineEditSchema).min(1).max(RFQ_MAX_LINES),
}).strict();

export type ApproveEdits = z.infer<typeof approveEditsSchema>;

/** A line of the stored suggestion (the shape storedRfqOutput wrote). */
type StoredLine = {
  description: string | null; partNumber: string | null; material: string | null; finish: string | null;
  quantity: number | null; dueDate: string | null; review: ReviewField[];
};
export type StoredSuggestion = { customer: string | null; lines: StoredLine[] };

const REVIEW_FIELDS = new Set<string>([...RFQ_FIELDS, "price"]);

/** The stored output read back defensively (it was validated when saved; anything else is dropped). Null when it is not an RFQ. */
export function readStoredSuggestion(output: unknown): StoredSuggestion | null {
  const o = output && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : null;
  if (!o || o.kind !== "rfq" || !Array.isArray(o.lines)) return null;
  const lines = o.lines.slice(0, RFQ_MAX_LINES).map((item): StoredLine => {
    const l = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      description: clean(l.description, 300), partNumber: clean(l.partNumber, 60), material: clean(l.material, 120), finish: clean(l.finish, 120),
      quantity: wholeQuantity(l.quantity), dueDate: realDate(l.dueDate),
      review: Array.isArray(l.review) ? [...new Set(l.review.filter((f): f is ReviewField => typeof f === "string" && REVIEW_FIELDS.has(f)))] : ["price"],
    };
  });
  return { customer: clean(o.customer, 200), lines };
}

/** A draft line as it will be saved. */
export type DraftLine = {
  description: string; partNumber: string | null; quantity: number; unitPrice: number; pricedBy: "costing" | "none"; review: ReviewField[];
  /** Kept for the review notes: the stored line's own number (1-based). */
  sourceLine: number;
};
export type DraftPlan = { customer: string; customerKnown: boolean; lines: DraftLine[] };

const FIELD_KEYS: Record<RfqField, keyof Omit<StoredLine, "review">> = {
  description: "description", part_number: "partNumber", material: "material", finish: "finish", quantity: "quantity", due_date: "dueDate",
};

/**
 * The lines to save, from the stored suggestion plus the person's edits (if any), cleaned. Throws ValidationError (nothing saved) for
 * an edit naming a line the suggestion does not have, a line named twice, or a kept line with no description or quantity.
 */
export function rebuildLines(stored: StoredSuggestion, edits: ApproveEdits | undefined): { customer: string | null; lines: (StoredLine & { sourceLine: number })[] } {
  if (!edits) return { customer: stored.customer, lines: stored.lines.map((line, i) => ({ ...line, sourceLine: i + 1 })) };
  const seen = new Set<number>();
  const lines = edits.lines.map((edit) => {
    const base = stored.lines[edit.index];
    if (!base || seen.has(edit.index)) throw new ValidationError("This suggestion has changed. Read the email again.");
    seen.add(edit.index);
    const next: Omit<StoredLine, "review"> = {
      description: clean(edit.description, 300), partNumber: clean(edit.partNumber, 60), material: clean(edit.material, 120),
      finish: clean(edit.finish, 120), dueDate: realDate(edit.dueDate), quantity: wholeQuantity(edit.quantity),
    };
    // A field the person changed to a value is theirs (checked); one they left as stored keeps its flag; an empty field is flagged.
    const review = RFQ_FIELDS.filter((field) => {
      const key = FIELD_KEYS[field];
      if (next[key] === null) return field !== "part_number" || base.review.includes("part_number");
      return next[key] === base[key] && base.review.includes(field);
    }) as ReviewField[];
    return { ...next, review: [...review, "price" as const], sourceLine: edit.index + 1 };
  });
  return { customer: clean(edits.customer, 200), lines };
}

/**
 * The whole draft: rebuilt lines, priced on the server, customer re-checked. `price` is costingPrices bound to the caller's company;
 * `customerKnown` checks this company's customers.
 */
export async function planDraft(
  stored: StoredSuggestion, edits: ApproveEdits | undefined,
  deps: { price: (lines: { partNumber: string | null; quantity: number | null }[]) => Promise<(number | null)[]>; customerKnown: (name: string) => Promise<boolean> },
): Promise<DraftPlan> {
  const rebuilt = rebuildLines(stored, edits);
  if (!rebuilt.customer) throw new ValidationError("Enter the customer before approving.");
  if (!rebuilt.lines.length) throw new ValidationError("There are no lines to quote.");
  const missing = rebuilt.lines.findIndex((l) => !l.description || !l.quantity);
  if (missing >= 0) throw new ValidationError(`Line ${missing + 1}: fill in the description and quantity (or remove the line) before approving.`);
  const prices = await deps.price(rebuilt.lines.map((l) => ({ partNumber: l.partNumber, quantity: l.quantity })));
  const customerKnown = await deps.customerKnown(rebuilt.customer);
  return {
    customer: rebuilt.customer,
    customerKnown,
    lines: rebuilt.lines.map((l, i) => {
      const price = prices[i] ?? null;
      return {
        description: lineDescription(l),
        partNumber: partField(l.partNumber),
        quantity: l.quantity!,
        unitPrice: price ?? 0,
        pricedBy: price === null ? "none" : "costing",
        review: price === null ? l.review : l.review.filter((f) => f !== "price"),
        sourceLine: l.sourceLine,
      };
    }),
  };
}

export type CompanyVat = { registered: boolean; standardRate: number };

/** The company's VAT setup from its own stored profile (organization_settings.company_profile), as lib/company.ts parses it. */
export function companyVatFromProfile(profile: unknown): CompanyVat {
  const v = profile && typeof profile === "object" ? (profile as Record<string, unknown>) : {};
  const rate = typeof v.defaultVatRate === "number" && Number.isFinite(v.defaultVatRate) && v.defaultVatRate >= 0 && v.defaultVatRate <= 100 ? v.defaultVatRate : 20;
  return { registered: v.vatRegistered !== false, standardRate: rate };
}

export const AI_DRAFT_NOTE = "Drafted from a pasted RFQ email with the AI helper, then checked and approved by a person.";

/** Creates the DRAFT quote from the plan under the person's own session. Returns its id and number. */
export async function createDraftQuote(db: SupabaseClient, plan: DraftPlan, vatSetup: CompanyVat): Promise<{ id: string; ref: string }> {
  const parsed = parseOrThrow(quoteSaveSchema, {
    customer: plan.customer,
    description: `RFQ from ${plan.customer}`,
    customerNotes: "",
    internalNotes: AI_DRAFT_NOTE,
    terms: "",
    validUntil: "",
    lines: plan.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice })),
  });
  const vat = fromVatChoice(toVatChoice(vatSetup.standardRate, false, "20"));
  const totals = documentTotals(parsed.lines.map((line) => ({ quantity: line.quantity, unitPrice: line.unitPrice, ...vat })), 0,
    { vatEnabled: vatSetup.registered, standardRate: vatSetup.standardRate });
  const { data: ref, error: refError } = await db.rpc("next_doc_number", { p_prefix: "QUO" });
  if (refError) throw refError;
  if (typeof ref !== "string" || !ref) throw new Error("next_doc_number returned no number.");
  const { data, error } = await db.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: {
      quote_ref: ref,
      customer: parsed.customer,
      description: parsed.description,
      customer_notes: null,
      internal_notes: parsed.internalNotes,
      total_value: totals.total,
      vat_enabled: vatSetup.registered,
      valid_until: null,
      terms: null,
      status: "draft",
    },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: parsed.lines.map((line, position) => {
      const part = plan.lines[position].partNumber;
      return {
        position,
        description: line.description,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        vat_pct: vat.vatPct,
        vat_exempt: vat.vatExempt,
        source: plan.lines[position].pricedBy === "costing" ? "costing_engine" : "manual",
        ...(part ? { part_number: part } : {}),
      };
    }),
  });
  if (error) throw error;
  if (typeof data !== "string") throw new Error("create_with_lines returned no id.");
  return { id: data, ref };
}
