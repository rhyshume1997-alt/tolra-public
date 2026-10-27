import type { SupabaseClient } from "@supabase/supabase-js";

import { documentTotals } from "@/lib/money";
import { partField } from "@/lib/quote-versions";
import { parseOrThrow, quoteSaveSchema } from "@/lib/validation/schemas";
import { type VatChoice, fromVatChoice } from "@/lib/vat";

/** A line as the person left it after review: every field theirs to change; the price from the costing calculation or typed. */
export type ReviewedLine = { description: string; partNumber: string; quantity: number; unitPrice: number; pricedBy: "costing" | "person" };

export type DraftInput = {
  customer: string;
  description: string;
  lines: ReviewedLine[];
  vat: { registered: boolean; standardRate: number; defaultChoice: VatChoice };
};

/**
 * The Approve click: creates a normal DRAFT quote exactly as the Quote Builder saves one (app/(dashboard)/quotes/page.tsx saveQuote):
 * the next number from next_doc_number('QUO'), then create_with_lines with status 'draft', in the browser under the person's own
 * session, so the company scoping, role checks, row triggers and audit of that path apply unchanged. The quote is not sent, issued or
 * changed afterwards. Validation is the builder's own (quoteSaveSchema), so the same input is refused the same way.
 */
export async function createDraftQuote(db: SupabaseClient, input: DraftInput, allocate: () => Promise<string>): Promise<{ id: string; ref: string }> {
  const parsed = parseOrThrow(quoteSaveSchema, {
    customer: input.customer,
    description: input.description,
    customerNotes: "",
    internalNotes: "",
    terms: "",
    validUntil: "",
    lines: input.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice })),
  });
  const vat = fromVatChoice(input.vat.defaultChoice);
  const totals = documentTotals(parsed.lines.map((line) => ({ quantity: line.quantity, unitPrice: line.unitPrice, ...vat })), 0,
    { vatEnabled: input.vat.registered, standardRate: input.vat.standardRate });
  const ref = await allocate();
  const { data, error } = await db.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: {
      quote_ref: ref,
      customer: parsed.customer,
      description: parsed.description,
      customer_notes: null,
      internal_notes: "Drafted from a pasted RFQ email with the AI helper, then checked and approved by a person.",
      total_value: totals.total,
      vat_enabled: input.vat.registered,
      valid_until: null,
      terms: null,
      status: "draft",
    },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: parsed.lines.map((line, position) => {
      const part = partField(input.lines[position]?.partNumber);
      return {
        position,
        description: line.description,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        vat_pct: vat.vatPct,
        vat_exempt: vat.vatExempt,
        source: input.lines[position]?.pricedBy === "costing" ? "costing_engine" : "manual",
        ...(part ? { part_number: part } : {}),
      };
    }),
  });
  if (error) throw error;
  if (typeof data !== "string") throw new Error("create_with_lines returned no id.");
  return { id: data, ref };
}
