"use client";

/**
 * Machine hours card: planned vs actual hours per machine for jobs finished in the period, with the variance and over / under the same way the
 * job worksheet reports it. A machine with no planned hours shows actual only, no percentage. Export: one row per machine. No cost.
 * Must not change: the rules are in lib/reports/machine-hours-variance.ts.
 */
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exportSpreadsheet } from "@/lib/export-records";
import type { MachineVarianceReport, MachineVarianceRow, MachineVarianceStatus } from "@/lib/reports/machine-hours-variance";
import type { SheetColumn } from "@/lib/spreadsheet";

const STATUS_TEXT: Record<MachineVarianceStatus, string> = { over: "Over plan", under: "Under plan", on_plan: "On plan", no_plan: "No plan" };
const signed = (n: number | null) => (n === null ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(2)}`);

const COLUMNS: SheetColumn<MachineVarianceRow>[] = [
  { header: "Machine", type: "text", value: (r) => r.label },
  { header: "Jobs", type: "number", value: (r) => r.jobs },
  { header: "Planned hours", type: "number", value: (r) => r.plannedHours },
  { header: "Actual hours", type: "number", value: (r) => r.actualHours },
  { header: "Variance hours", type: "number", value: (r) => r.varianceHours },
  { header: "Variance %", type: "number", value: (r) => r.variancePercent },
  { header: "Status", type: "text", value: (r) => STATUS_TEXT[r.status] },
];

export function MachineHoursCard({ data }: { data: MachineVarianceReport }) {
  return (
    <div className="space-y-3">
      {!data.rows.length ? <p className="text-sm text-slate-500">No machine hours for jobs finished in this period.</p> : (
        <Table>
          <TableHeader><TableRow>{["Machine", "Jobs", "Planned (h)", "Actual (h)", "Variance (h)", "Variance %", "Status"].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={r.machineId} data-testid="machine-row">
                <TableCell>{r.label}</TableCell><TableCell>{r.jobs}</TableCell><TableCell>{r.plannedHours.toFixed(2)}</TableCell><TableCell>{r.actualHours.toFixed(2)}</TableCell>
                <TableCell>{signed(r.varianceHours)}</TableCell><TableCell>{r.variancePercent === null ? "–" : `${signed(r.variancePercent)}%`}</TableCell><TableCell>{STATUS_TEXT[r.status]}</TableCell>
              </TableRow>
            ))}
            <TableRow data-testid="machine-total"><TableCell>Total</TableCell><TableCell /><TableCell>{data.plannedHours.toFixed(2)}</TableCell><TableCell>{data.actualHours.toFixed(2)}</TableCell><TableCell>{signed(data.varianceHours)}</TableCell><TableCell>{data.plannedMachinesPercent === null ? "–" : `${signed(data.plannedMachinesPercent)}%`}</TableCell><TableCell /></TableRow>
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-slate-500">Jobs finished in the period (newest 500 at most). Internal jobs are left out. The total percentage leaves out machines with no planned hours. Bench time is not included.</p>
      <div className="flex gap-2">
        <Button variant="outline" className="min-h-11" disabled={!data.rows.length} onClick={() => void exportSpreadsheet("csv", "Machine hours", COLUMNS, data.rows)}>Download CSV</Button>
        <Button variant="outline" className="min-h-11" disabled={!data.rows.length} onClick={() => void exportSpreadsheet("xlsx", "Machine hours", COLUMNS, data.rows)}>Download Excel</Button>
      </div>
    </div>
  );
}
