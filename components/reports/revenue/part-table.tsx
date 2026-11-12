"use client";

/**
 * Invoiced revenue by part number (ex VAT, less credit notes). Shows what it is given (lib/reports/revenue/by-part); it works nothing
 * out and reads nothing. Lines with no linked order line or no part number are "Uncategorised"; carriage and credit notes are their own
 * rows. Invoices whose lines do not add up to their net are counted and said so. Export: exportSpreadsheet with entityTable "invoices".
 * Must not change: invoiced basis only; never shows cash or pipeline.
 */
import { Panel } from "@/components/dashboard-charts";
import { exportSpreadsheet } from "@/lib/export-records";
import { gbp } from "@/lib/money";
import type { PartResult, PartRow } from "@/lib/reports/revenue/by-part";
import type { SheetColumn } from "@/lib/spreadsheet";

const COLUMNS: SheetColumn<PartRow>[] = [
  { header: "Part number", type: "text", value: (row) => row.part },
  { header: "Invoiced ex VAT, less credit notes", type: "money", value: (row) => row.partNet },
  { header: "Share of invoiced (%)", type: "number", value: (row) => row.partShare },
];

export function PartTable({ result, failed, incomplete }: { result: PartResult | null; failed: boolean; incomplete: boolean }) {
  return (
    <Panel title="Invoiced revenue by part number" meta="From invoice lines linked to order lines">
      <div data-testid="revenue-parts">
        {failed || !result ? (
          <p className="py-2 text-sm text-muted-foreground" data-testid="revenue-parts-failed">Revenue by part number can&apos;t be read right now.</p>
        ) : (
          <>
            {incomplete ? <p className="pb-2 text-sm text-muted-foreground">Some rows were not read (20,000 row limit), so these figures may be incomplete.</p> : null}
            {result.mismatchedInvoices > 0 ? (
              <p className="pb-2 text-sm text-ink" data-testid="revenue-parts-mismatch">
                {result.mismatchedInvoices} {result.mismatchedInvoices === 1 ? "invoice doesn't" : "invoices don't"} add up by line. Their whole value is under Uncategorised.
              </p>
            ) : null}
            {result.unreadableLines > 0 ? (
              <p className="pb-2 text-sm text-ink" data-testid="revenue-parts-unreadable">
                {result.unreadableLines} {result.unreadableLines === 1 ? "line links" : "lines link"} to sales order lines you can&apos;t read (Sales Orders hidden for you): their part numbers aren&apos;t shown.
              </p>
            ) : null}
            {result.unknownInvoices > 0 ? (
              <p className="pb-2 text-sm text-ink">{result.unknownInvoices} {result.unknownInvoices === 1 ? "invoice has" : "invoices have"} no figures, so the shares can&apos;t be worked out.</p>
            ) : null}
            {result.rows.length === 0 ? <p className="py-2 text-sm text-muted-foreground">No invoiced work in this period.</p> : (
              <table className="w-full table-fixed text-left text-sm tabular-nums">
                <thead>
                  <tr className="border-b border-line text-muted-foreground">
                    <th scope="col" className="py-2 pr-2 font-semibold">Part number</th>
                    <th scope="col" className="py-2 text-right font-semibold">Invoiced</th>
                    <th scope="col" className="py-2 pl-2 text-right font-semibold">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={`${row.partKind}:${row.part}`} className="border-b border-line/70" data-testid="revenue-part-row">
                      <th scope="row" className="py-2 pr-2 font-normal text-ink">{row.part}</th>
                      <td className="py-2 text-right" data-col="invoiced">{gbp(row.partNet)}</td>
                      <td className="py-2 pl-2 text-right" data-col="share">{row.partShare === null ? "—" : `${row.partShare}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-3 flex gap-2">
              {(["csv", "xlsx"] as const).map((format) => (
                <button key={format} type="button" onClick={() => void exportSpreadsheet(format, "Revenue invoiced by part number", COLUMNS, result.rows, "invoices")} className="h-8 border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-muted">
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
