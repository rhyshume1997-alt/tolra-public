import { documentTotals, gbp, toPence } from "@/lib/money";
import { fromVatChoice, toVatChoice, VAT_CHOICES, type VatChoice } from "@/lib/vat";

/** A quote line as stored (quote_line_items). declined: not on the customer's PO when the quote was accepted (migration 068). */
export type QuoteLineRow = { quantity: number | string | null; unit_price: number | string | null; vat_pct: number | string | null; vat_exempt: boolean | null; declined?: boolean | null };

const BY_HAND = "Choose \"No linked quote\" and enter the order by hand.";

export type OrderTerms =
  | { ok: true; value: number; vatOn: boolean; vat: VatChoice }
  | { ok: false; reason: string };

/**
 * What a sales order linked to an accepted quote carries over (audit R2). A sales order holds one value (net, ex VAT:
 * the job valuation) and one VAT setting, so the quote's VAT treatment is copied when it can be held exactly:
 * VAT off on the quote -> off on the order; VAT on with every line at the same rate (or every line exempt) -> that
 * rate. Lines at different rates can't be held by one order without blending them, so linking is refused and the
 * order is entered by hand. The quote rounds VAT per line and the order rounds it once on its single value, so the
 * order's VAT and gross are compared with the accepted quote's to the penny and linking is refused if they differ
 * (two 3p lines at 20%: quote 8p, order 7p). Nothing already saved is recalculated.
 */
export function orderTermsFromQuote(quote: { vat_enabled: boolean | null; total_value?: number | string | null }, allLines: QuoteLineRow[], vatRegistered: boolean): OrderTerms {
  // Only the lines the customer ordered (068). With some declined, the quote's stored total (the whole quote) is not what the order
  // must match: the ordered lines' own per-line totals are (create_sales_order_from_quote does the same).
  const lines = allLines.filter((row) => !row.declined);
  const partial = lines.length !== allLines.length;
  const terms = proposedTerms(quote, lines, vatRegistered);
  if (!terms.ok) return terms;
  const quoteTotals = documentTotals(
    lines.map((row) => ({ quantity: Number(row.quantity || 0), unitPrice: Number(row.unit_price || 0), vatPct: Number(row.vat_pct ?? 20), vatExempt: Boolean(row.vat_exempt) })),
    0,
    { vatEnabled: quote.vat_enabled !== false },
  );
  const quoteGross = partial || quote.total_value === null || quote.total_value === undefined ? quoteTotals.total : Number(quote.total_value);
  const order = documentTotals([{ quantity: 1, unitPrice: terms.value, ...fromVatChoice(terms.vat) }], 0, { vatEnabled: terms.vatOn });
  if (toPence(order.vat) !== toPence(quoteTotals.vat) || toPence(order.total) !== toPence(quoteGross)) {
    return {
      ok: false,
      reason: `As one sales order this quote would come to ${gbp(order.total)} (VAT ${gbp(order.vat)}), but the accepted quote is ${gbp(quoteGross)} (VAT ${gbp(quoteTotals.vat)}), because the quote rounds VAT on each line. ${BY_HAND}`,
    };
  }
  return terms;
}

function proposedTerms(quote: { vat_enabled: boolean | null }, lines: QuoteLineRow[], vatRegistered: boolean): OrderTerms {
  if (!lines.length) return { ok: false, reason: `That quote has no lines to copy. ${BY_HAND}` };
  const value = documentTotals(lines.map((row) => ({ quantity: Number(row.quantity || 0), unitPrice: Number(row.unit_price || 0), vatPct: 0 }))).subtotal;
  const vatOn = vatRegistered && quote.vat_enabled !== false;
  if (!vatOn) return { ok: true, value, vatOn: false, vat: toVatChoice(Number(lines[0].vat_pct ?? 20), lines[0].vat_exempt) };
  // Each line's treatment exactly as stored: "exempt", or its rate ("20", "5", "0", or another figure).
  const treatments = new Set(lines.map((row) => (row.vat_exempt ? "exempt" : String(Number(row.vat_pct ?? 20)))));
  if (treatments.size !== 1) return { ok: false, reason: `That quote has lines at different VAT rates. A sales order holds one VAT rate, so it can't be linked without changing the VAT. ${BY_HAND}` };
  const [only] = treatments;
  if (!(VAT_CHOICES as readonly string[]).includes(only)) return { ok: false, reason: `That quote uses a VAT rate (${only}%) a sales order can't hold. ${BY_HAND}` };
  return { ok: true, value, vatOn: true, vat: only as VatChoice };
}
