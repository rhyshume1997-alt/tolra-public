import { documentTotals } from "@/lib/money";

/** A saved PO line as the New PO form writes it. */
type PoLine = { description?: string; qty?: number; unit_price?: number; vat_pct?: number; vat_exempt?: boolean };

/** Column heading for the PO list's total (the stored total_value is ex VAT; this is what the PO prints as its total). */
export const PO_TOTAL_LABEL = "Total (inc VAT)";

/**
 * The VAT-inclusive total of a purchase order, as the printed PO and the year-end export work it out (purchaseOrderExportTotals):
 * from the saved lines through documentTotals, VAT only when the PO has "Add VAT" on and the company is VAT registered, lines with
 * no rate at the company's standard rate. A PO with no saved lines is one line for its stored (ex VAT) value.
 */
export function purchaseOrderTotalIncVat(
  po: { value: number; vatEnabled?: boolean; items?: PoLine[] },
  vat: { registered: boolean; standardRate: number },
): number {
  const saved = (po.items ?? []).filter((item) => item.description);
  const lines = saved.length
    ? saved.map((item) => ({ quantity: Number(item.qty || 1), unitPrice: Number(item.unit_price || 0), vatPct: item.vat_pct === undefined ? undefined : Number(item.vat_pct), vatExempt: Boolean(item.vat_exempt) }))
    : [{ quantity: 1, unitPrice: po.value }];
  return documentTotals(lines, 0, { vatEnabled: po.vatEnabled === true && vat.registered, standardRate: vat.standardRate }).total;
}
