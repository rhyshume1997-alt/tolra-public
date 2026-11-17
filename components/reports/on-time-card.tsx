"use client";

/**
 * On-time completion card: per London month, jobs finished, on time, late, no due date and the on-time percentage (a dash when a month has no
 * dated jobs). Export: an audit table, one row per counted job (the jobs behind the figures). Read-only; no cost.
 * Must not change: the rules are in lib/reports/on-time-completion.ts.
 */
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exportSpreadsheet } from "@/lib/export-records";
import type { OnTimeAuditRow, OnTimeReport } from "@/lib/reports/on-time-completion";
import type { SheetColumn } from "@/lib/spreadsheet";

const COLUMNS: SheetColumn<OnTimeAuditRow>[] = [
  { header: "Job", type: "text", value: (r) => r.jobNo },
  { header: "Customer", type: "text", value: (r) => r.customer },
  { header: "Month finished", type: "text", value: (r) => r.month },
  { header: "Finished", type: "date", value: (r) => r.finishedDate },
  { header: "Due", type: "date", value: (r) => r.dueDate },
  { header: "Result", type: "text", value: (r) => r.result },
  { header: "Days late", type: "number", value: (r) => r.daysLate },
  { header: "Last despatch (information only)", type: "date", value: (r) => r.lastDespatch },
];

export function OnTimeCard({ data }: { data: OnTimeReport }) {
  const { total } = data;
  return (
    <div className="space-y-3">
      <p data-testid="on-time-total" className="text-sm text-slate-700">
        {total.percent === null ? "–" : `${total.percent}%`} on time ({total.onTime} of {total.dated} jobs with a due date). {total.noDueDate} finished with no due date, not in the percentage.
      </p>
      <Table>
        <TableHeader><TableRow>{["Month", "Finished", "On time", "Late", "No due date", "On time %"].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
        <TableBody>
          {data.months.map((m) => (
            <TableRow key={m.key} data-testid="on-time-month" data-month={m.key}>
              <TableCell>{m.label}</TableCell><TableCell>{m.finished}</TableCell><TableCell>{m.onTime}</TableCell><TableCell>{m.late}</TableCell><TableCell>{m.noDueDate}</TableCell>
              <TableCell>{m.percent === null ? "–" : `${m.percent}%`}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-slate-500">A job counts in the month it was finished. On time means finished on or before its required date. Internal jobs are left out.</p>
      <div className="flex gap-2">
        <Button variant="outline" className="min-h-11" disabled={!data.rows.length} onClick={() => void exportSpreadsheet("csv", "On-time completion", COLUMNS, data.rows)}>Download CSV</Button>
        <Button variant="outline" className="min-h-11" disabled={!data.rows.length} onClick={() => void exportSpreadsheet("xlsx", "On-time completion", COLUMNS, data.rows)}>Download Excel</Button>
      </div>
    </div>
  );
}
