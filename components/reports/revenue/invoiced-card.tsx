"use client";

/**
 * Revenue basis 1: INVOICED, ex VAT, less credit notes, per London month. Shows what it is given (lib/reports/revenue/invoiced); it
 * works nothing out and reads nothing. Export: CSV/XLSX through exportSpreadsheet with entityTable "invoices" (the figures are
 * worked out from invoices and credit notes), so the audit log records an EXPORT of invoice data.
 * Must not change: this card never shows or adds cash or pipeline figures.
 */
import { Panel } from "@/components/dashboard-charts";
import { exportSpreadsheet } from "@/lib/export-records";
import { gbp } from "@/lib/money";
import type { InvoicedMonth, InvoicedResult } from "@/lib/reports/revenue/invoiced";
import type { SheetColumn } from "@/lib/spreadsheet";

const COLUMNS: SheetColumn<InvoicedMonth>[] = [
  { header: "Month", type: "text", value: (row) => row.key },
  { header: "Invoiced ex VAT, less credit notes", type: "money", value: (row) => row.invoiced },
];

export function InvoicedCard({ result, failed, incomplete }: { result: InvoicedResult | null; failed: boolean; incomplete: boolean }) {
  return (
    <Panel title="Invoiced revenue (ex VAT, less credit notes)" meta="Issued invoices on invoice date; credit notes on their own date">
      <div data-testid="revenue-invoiced">
        {failed || !result ? (
          <p className="py-2 text-sm text-muted-foreground" data-testid="revenue-invoiced-failed">Invoiced revenue can&apos;t be read right now.</p>
        ) : (
          <>
            {incomplete ? <p className="pb-2 text-sm text-muted-foreground">Some rows were not read (20,000 row limit), so these figures may be incomplete.</p> : null}
            <table className="w-full table-fixed text-left text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 font-semibold">Month</th>
                  <th scope="col" className="py-2 text-right font-semibold">Invoiced</th>
                </tr>
              </thead>
              <tbody>
                {result.months.map((m) => (
                  <tr key={m.key} className="border-b border-line/70" data-testid={`revenue-invoiced-${m.key}`}>
                    <th scope="row" className="py-2 pr-2 font-normal text-ink">{m.label}</th>
                    <td className="py-2 text-right" data-col="invoiced">{m.invoiced === null ? "—" : gbp(m.invoiced)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="py-2 pr-2 font-semibold text-ink">Total invoiced</th>
                  <td className="py-2 text-right font-semibold" data-testid="revenue-invoiced-total">{result.invoicedTotal === null ? "—" : gbp(result.invoicedTotal)}</td>
                </tr>
              </tbody>
            </table>
            <div className="mt-3 flex gap-2">
              {(["csv", "xlsx"] as const).map((format) => (
                <button key={format} type="button" onClick={() => void exportSpreadsheet(format, "Revenue invoiced by month", COLUMNS, result.months, "invoices")} className="h-8 border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-muted">
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
