"use client";

/**
 * WIP ageing card: open jobs by whole days since they started (0-7, 8-14, 15-30, 31-60, 61+), and the open jobs not started yet.
 * Export: an audit table, one row per open job. Read-only; no cost. Must not change: the bands are in lib/reports/wip-ageing.ts.
 */
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exportSpreadsheet } from "@/lib/export-records";
import type { SheetColumn } from "@/lib/spreadsheet";
import type { WipReport, WipRow } from "@/lib/reports/wip-ageing";

const COLUMNS: SheetColumn<WipRow>[] = [
  { header: "Job", type: "text", value: (r) => r.jobNo },
  { header: "Customer", type: "text", value: (r) => r.customer },
  { header: "Started", type: "date", value: (r) => r.startedDate },
  { header: "Age (days)", type: "number", value: (r) => r.ageDays },
  { header: "Band", type: "text", value: (r) => r.band },
];

export function WipAgeingCard({ data }: { data: WipReport }) {
  return (
    <div className="space-y-3">
      <p data-testid="wip-open" className="text-sm text-slate-700">{data.open} open {data.open === 1 ? "job" : "jobs"}.</p>
      <Table>
        <TableHeader><TableRow><TableHead>Age since started</TableHead><TableHead>Open jobs</TableHead></TableRow></TableHeader>
        <TableBody>
          {data.bands.map((b) => <TableRow key={b.key} data-testid="wip-band" data-band={b.key}><TableCell>{b.label}</TableCell><TableCell>{b.count}</TableCell></TableRow>)}
          <TableRow data-testid="wip-band" data-band="not-started"><TableCell>Not started</TableCell><TableCell>{data.notStarted}</TableCell></TableRow>
        </TableBody>
      </Table>
      <p className="text-xs text-slate-500">Age is whole days (UK time) from the day the job started. Internal jobs are left out.</p>
      <div className="flex gap-2">
        <Button variant="outline" className="min-h-11" disabled={!data.rows.length} onClick={() => void exportSpreadsheet("csv", "WIP ageing", COLUMNS, data.rows)}>Download CSV</Button>
        <Button variant="outline" className="min-h-11" disabled={!data.rows.length} onClick={() => void exportSpreadsheet("xlsx", "WIP ageing", COLUMNS, data.rows)}>Download Excel</Button>
      </div>
    </div>
  );
}
