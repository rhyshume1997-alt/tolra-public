"use client";

/**
 * PIPELINE (not revenue): open quotes by the month they were sent, value ex VAT. Shows what it is given (lib/reports/revenue/pipeline);
 * it works nothing out and reads nothing. Titled "Pipeline (not revenue)" and kept apart from the two revenue bases: no total here
 * is ever added to invoiced or cash. Export: exportSpreadsheet with entityTable "quotes".
 */
import { Panel } from "@/components/dashboard-charts";
import { exportSpreadsheet } from "@/lib/export-records";
import { gbp } from "@/lib/money";
import type { PipelineMonth, PipelineResult } from "@/lib/reports/revenue/pipeline";
import type { SheetColumn } from "@/lib/spreadsheet";

const COLUMNS: SheetColumn<PipelineMonth>[] = [
  { header: "Month sent", type: "text", value: (row) => row.sentMonth },
  { header: "Open quotes", type: "number", value: (row) => row.quoteCount },
  { header: "Quoted value ex VAT (pipeline, not revenue)", type: "money", value: (row) => row.quotedValue },
];

export function PipelineCard({ result, failed, incomplete }: { result: PipelineResult | null; failed: boolean; incomplete: boolean }) {
  return (
    <Panel title="Pipeline (not revenue)" meta="Quotes sent and still open, by month sent">
      <div data-testid="revenue-pipeline">
        {failed || !result ? (
          <p className="py-2 text-sm text-muted-foreground" data-testid="revenue-pipeline-failed">The pipeline can&apos;t be read right now.</p>
        ) : (
          <>
            <p className="pb-2 text-sm text-muted-foreground">Open quotes are not invoiced and not paid. This is never added to the revenue above.</p>
            {incomplete ? <p className="pb-2 text-sm text-muted-foreground">Some rows were not read (20,000 row limit), so these figures may be incomplete.</p> : null}
            {result.quotesWithoutLines > 0 ? <p className="pb-2 text-sm text-muted-foreground">{result.quotesWithoutLines} open {result.quotesWithoutLines === 1 ? "quote has" : "quotes have"} no lines, so no value.</p> : null}
            <table className="w-full table-fixed text-left text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 font-semibold">Month sent</th>
                  <th scope="col" className="py-2 text-right font-semibold">Quotes</th>
                  <th scope="col" className="py-2 pl-2 text-right font-semibold">Quoted</th>
                </tr>
              </thead>
              <tbody>
                {result.pipelineMonths.map((m) => (
                  <tr key={m.sentMonth} className="border-b border-line/70" data-testid={`revenue-pipeline-${m.sentMonth}`}>
                    <th scope="row" className="py-2 pr-2 font-normal text-ink">{m.sentLabel}</th>
                    <td className="py-2 text-right" data-col="quotes">{m.quoteCount}</td>
                    <td className="py-2 pl-2 text-right" data-col="quoted">{gbp(m.quotedValue)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="py-2 pr-2 font-semibold text-ink">Open quotes</th>
                  <td className="py-2 text-right font-semibold" data-testid="revenue-pipeline-count">{result.openQuotes}</td>
                  <td className="py-2 pl-2 text-right font-semibold" data-testid="revenue-pipeline-total">{gbp(result.quotedTotal)}</td>
                </tr>
              </tbody>
            </table>
            <div className="mt-3 flex gap-2">
              {(["csv", "xlsx"] as const).map((format) => (
                <button key={format} type="button" onClick={() => void exportSpreadsheet(format, "Pipeline open quotes by month sent", COLUMNS, result.pipelineMonths, "quotes")} className="h-8 border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-muted">
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
