"use client";

/**
 * Invoiced revenue per customer (ex VAT, less credit notes). Shows what it is given (lib/reports/revenue/by-customer); it works
 * nothing out and reads nothing. Customers are matched by the name text on the invoice. Export: exportSpreadsheet with entityTable
 * "invoices".
 * Must not change: invoiced basis only; never shows cash or pipeline.
 */
import { Panel } from "@/components/dashboard-charts";
import type { CustomerResult, CustomerRow } from "@/lib/reports/revenue/by-customer";
import { exportSpreadsheet } from "@/lib/export-records";
import { gbp } from "@/lib/money";
import type { SheetColumn } from "@/lib/spreadsheet";

const COLUMNS: SheetColumn<CustomerRow>[] = [
  { header: "Customer", type: "text", value: (row) => row.customer },
  { header: "Invoiced ex VAT, less credit notes", type: "money", value: (row) => row.invoicedNet },
  { header: "Share of invoiced (%)", type: "number", value: (row) => row.invoicedShare },
];

export function CustomerTable({ result, failed, incomplete }: { result: CustomerResult | null; failed: boolean; incomplete: boolean }) {
  return (
    <Panel title="Invoiced revenue by customer" meta="Customers are matched by the name on the invoice">
      <div data-testid="revenue-customers">
        {failed || !result ? (
          <p className="py-2 text-sm text-muted-foreground" data-testid="revenue-customers-failed">Revenue by customer can&apos;t be read right now.</p>
        ) : (
          <>
            {incomplete ? <p className="pb-2 text-sm text-muted-foreground">Some rows were not read (20,000 row limit), so these figures may be incomplete.</p> : null}
            {result.rows.length === 0 ? <p className="py-2 text-sm text-muted-foreground">No invoiced work in this period.</p> : (
              <table className="w-full table-fixed text-left text-sm tabular-nums">
                <thead>
                  <tr className="border-b border-line text-muted-foreground">
                    <th scope="col" className="py-2 pr-2 font-semibold">Customer</th>
                    <th scope="col" className="py-2 text-right font-semibold">Invoiced</th>
                    <th scope="col" className="py-2 pl-2 text-right font-semibold">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.customer} className="border-b border-line/70" data-testid="revenue-customer-row">
                      <th scope="row" className="truncate py-2 pr-2 font-normal text-ink">{row.customer}</th>
                      <td className="py-2 text-right" data-col="invoiced">{row.invoicedNet === null ? "—" : gbp(row.invoicedNet)}</td>
                      <td className="py-2 pl-2 text-right" data-col="share">{row.invoicedShare === null ? "—" : `${row.invoicedShare}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-3 flex gap-2">
              {(["csv", "xlsx"] as const).map((format) => (
                <button key={format} type="button" onClick={() => void exportSpreadsheet(format, "Revenue invoiced by customer", COLUMNS, result.rows, "invoices")} className="h-8 border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-muted">
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
