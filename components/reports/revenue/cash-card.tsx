"use client";

/**
 * Revenue basis 2: CASH RECEIVED per London month (invoice payments by the date paid, reversals included). Shows what it is given
 * (lib/reports/revenue/cash); it works nothing out and reads nothing. Payments carry no customer, so the customer filter does not
 * apply here and the card says so. Export: CSV/XLSX through exportSpreadsheet with entityTable "invoice_payments" (the audited table
 * the payments export already uses).
 * Must not change: this card never shows or adds invoiced or pipeline figures.
 */
import { Panel } from "@/components/dashboard-charts";
import { exportSpreadsheet } from "@/lib/export-records";
import { gbp } from "@/lib/money";
import type { CashMonth, CashResult } from "@/lib/reports/revenue/cash";
import type { SheetColumn } from "@/lib/spreadsheet";

const COLUMNS: SheetColumn<CashMonth>[] = [
  { header: "Month", type: "text", value: (row) => row.key },
  { header: "Cash received", type: "money", value: (row) => row.received },
];

export function CashCard({ result, failed, incomplete, customerFiltered }: { result: CashResult | null; failed: boolean; incomplete: boolean; customerFiltered: boolean }) {
  return (
    <Panel title="Cash received" meta="Payments by the date received, reversals included">
      <div data-testid="revenue-cash">
        {failed || !result ? (
          <p className="py-2 text-sm text-muted-foreground" data-testid="revenue-cash-failed">Cash received can&apos;t be read right now.</p>
        ) : (
          <>
            {customerFiltered ? <p className="pb-2 text-sm text-muted-foreground">Payments are not recorded against a customer name, so this shows all customers.</p> : null}
            {incomplete ? <p className="pb-2 text-sm text-muted-foreground">Some rows were not read (20,000 row limit), so these figures may be incomplete.</p> : null}
            <table className="w-full table-fixed text-left text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 font-semibold">Month</th>
                  <th scope="col" className="py-2 text-right font-semibold">Received</th>
                </tr>
              </thead>
              <tbody>
                {result.months.map((m) => (
                  <tr key={m.key} className="border-b border-line/70" data-testid={`revenue-cash-${m.key}`}>
                    <th scope="row" className="py-2 pr-2 font-normal text-ink">{m.label}</th>
                    <td className="py-2 text-right" data-col="received">{gbp(m.received)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="py-2 pr-2 font-semibold text-ink">Total received</th>
                  <td className="py-2 text-right font-semibold" data-testid="revenue-cash-total">{gbp(result.receivedTotal)}</td>
                </tr>
              </tbody>
            </table>
            <div className="mt-3 flex gap-2">
              {(["csv", "xlsx"] as const).map((format) => (
                <button key={format} type="button" onClick={() => void exportSpreadsheet(format, "Revenue cash received by month", COLUMNS, result.months, "invoice_payments")} className="h-8 border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-muted">
                  {format === "csv" ? "Download CSV" : "Download Excel"}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
