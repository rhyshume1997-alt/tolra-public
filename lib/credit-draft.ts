/**
 * The New credit note form (components/credit-notes-panel.tsx): each line starts at the most that can still be credited, the user lowers
 * it, and the net, VAT and total shown follow every change. Saving is unchanged (create_credit_note); the database works out and checks
 * the real figures, so this is the preview only.
 */
import { documentTotals } from "@/lib/money";

export type CreditableLine = { quantity: number; unitPrice: number; credited: number; vatPct?: number; vatExempt?: boolean };

/** The invoice line's quantity less what earlier credit notes took, never below 0 and without floating point dust (4 places, as the database holds). */
export function creditableQuantity(line: Pick<CreditableLine, "quantity" | "credited">): number {
  return Math.max(0, Math.round((line.quantity - line.credited) * 10_000) / 10_000);
}

/** The form's starting text for a line: the full creditable quantity ("0" when nothing is left). */
export const startingQuantity = (line: Pick<CreditableLine, "quantity" | "credited">): string => String(creditableQuantity(line));

/** Net, VAT and total of what is typed (a blank or invalid quantity or price counts as nothing), VAT at each line's own rate when the invoice charges VAT. */
export function creditPreview(lines: CreditableLine[], quantities: string[], prices: string[], vatEnabled: boolean) {
  const typed = lines.map((line, index) => ({
    quantity: Number(quantities[index] || 0), unitPrice: Number(prices[index] || 0), vatPct: line.vatPct, vatExempt: line.vatExempt,
  })).filter((item) => Number.isFinite(item.quantity) && Number.isFinite(item.unitPrice) && item.quantity > 0);
  const totals = documentTotals(typed, 0, { vatEnabled });
  return { subtotal: totals.subtotal, vat: totals.vat, total: totals.total };
}
