"use client";

/**
 * NCR trend card: per London month, confirmed NCRs (by type), quantity scrapped, and failed inspections with no linked rework (shown apart,
 * not in the confirmed count). Export: one row per month. NO cost is shown or exported. Must not change: the rules are in lib/reports/ncr-trend.ts.
 */
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exportSpreadsheet } from "@/lib/export-records";
import { NCR_CONFIRMED_TYPES } from "@/lib/jobs/ncr-register";
import type { NcrTrendMonth, NcrTrendReport } from "@/lib/reports/ncr-trend";
import type { SheetColumn } from "@/lib/spreadsheet";

const COLUMNS: SheetColumn<NcrTrendMonth>[] = [
  { header: "Month", type: "text", value: (r) => r.key },
  { header: "Confirmed NCRs", type: "number", value: (r) => r.confirmed },
  ...NCR_CONFIRMED_TYPES.map((t): SheetColumn<NcrTrendMonth> => ({ header: t, type: "number", value: (r) => r.byType[t] ?? 0 })),
  { header: "Quantity scrapped", type: "number", value: (r) => r.scrapped },
  { header: "Not linked (no rework)", type: "number", value: (r) => r.notLinked },
];

export function NcrTrendCard({ data }: { data: NcrTrendReport }) {
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader><TableRow>{["Month", "Confirmed", ...NCR_CONFIRMED_TYPES, "Scrapped", "Not linked"].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
        <TableBody>
          {data.months.map((m) => (
            <TableRow key={m.key} data-testid="ncr-month" data-month={m.key}>
              <TableCell>{m.label}</TableCell><TableCell>{m.confirmed}</TableCell>
              {NCR_CONFIRMED_TYPES.map((t) => <TableCell key={t}>{m.byType[t] ?? 0}</TableCell>)}
              <TableCell>{m.scrapped}</TableCell><TableCell>{m.notLinked}</TableCell>
            </TableRow>
          ))}
          <TableRow data-testid="ncr-total"><TableCell>Total</TableCell><TableCell>{data.total.confirmed}</TableCell>{NCR_CONFIRMED_TYPES.map((t) => <TableCell key={t}>{data.total.byType[t] ?? 0}</TableCell>)}<TableCell>{data.total.scrapped}</TableCell><TableCell>{data.total.notLinked}</TableCell></TableRow>
        </TableBody>
      </Table>
      <p className="text-xs text-slate-500">By the month the record was raised. &quot;Not linked&quot; is a failed inspection with no rework record; it is not in the confirmed count. No costs are shown.</p>
      <div className="flex gap-2">
        <Button variant="outline" className="min-h-11" onClick={() => void exportSpreadsheet("csv", "NCR trend", COLUMNS, data.months)}>Download CSV</Button>
        <Button variant="outline" className="min-h-11" onClick={() => void exportSpreadsheet("xlsx", "NCR trend", COLUMNS, data.months)}>Download Excel</Button>
      </div>
    </div>
  );
}
