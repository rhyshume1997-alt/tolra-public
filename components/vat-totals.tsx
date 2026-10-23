import { type DocumentTotals, gbp, vatRowLabel } from "@/lib/money";

/**
 * Subtotal, carriage, one VAT row per rate charged and the grand total, as on the PDFs.
 * With VAT off there are no VAT rows and the total is the net amount.
 */
export function VatTotals({ totals, vatEnabled, showCarriage = false, totalLabel = "Grand total", className = "space-y-1 rounded-lg bg-slate-50 p-4 text-sm" }: {
  totals: DocumentTotals; vatEnabled: boolean; showCarriage?: boolean; totalLabel?: string; className?: string;
}) {
  const vatRows = totals.vatBreakdown.filter((row) => !row.exempt);
  const exempt = totals.vatBreakdown.find((row) => row.exempt);
  return (
    <div className={className}>
      <div className="flex justify-between gap-4"><span>Subtotal</span><span>{gbp(totals.subtotal)}</span></div>
      {showCarriage || totals.carriage ? <div className="flex justify-between gap-4"><span>Carriage</span><span>{gbp(totals.carriage)}</span></div> : null}
      {vatEnabled ? (
        vatRows.length ? vatRows.map((row) => (
          <div key={vatRowLabel(row)} className="flex justify-between gap-4"><span>{vatRowLabel(row)}</span><span>{gbp(row.vat)}</span></div>
        )) : <div className="flex justify-between gap-4"><span>VAT</span><span>{gbp(0)}</span></div>
      ) : <div className="flex justify-between gap-4 text-slate-500"><span>No VAT</span><span>-</span></div>}
      {vatEnabled && exempt ? <div className="flex justify-between gap-4 text-slate-500"><span>Exempt items</span><span>{gbp(exempt.net)}</span></div> : null}
      <div className="flex justify-between gap-4 border-t pt-2 font-bold"><span>{totalLabel}</span><span>{gbp(totals.total)}</span></div>
    </div>
  );
}
