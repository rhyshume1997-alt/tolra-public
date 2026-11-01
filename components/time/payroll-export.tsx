"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { requireCompanyProfile } from "@/lib/company";
import { exportSpreadsheet } from "@/lib/export-records";
import { friendlyError } from "@/lib/friendly-error";
import { type PeopleMap, UNKNOWN } from "@/lib/people";
import { supabase } from "@/lib/supabase";
import { PAYROLL_COLUMNS, PAYROLL_MAX_WEEKS, type PayrollWeek, payrollFileBase, payrollRows, payrollWeeks, unapprovedCount } from "@/lib/time-payroll-export";
import { loadWeek } from "@/lib/time-week";

const VALID = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Payroll export (admin / office, on the weekly hours page): everyone's paid hours for 1 to 5 whole weeks in one CSV or Excel file
 * (lib/time-payroll-export.ts). The weeks are read the way the review reads them, one week at a time.
 */
export function PayrollExport({ week, names }: { week: string; names: PeopleMap }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(week);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const period = VALID.test(from) ? payrollWeeks(from, count) : null;

  async function run(format: "csv" | "xlsx") {
    if (!supabase || !period) return;
    setBusy(true);
    try {
      const weeks: PayrollWeek[] = [];
      for (const weekStart of period.weekStarts) weeks.push({ weekStart, people: (await loadWeek(supabase, weekStart, null)).people });
      const rows = payrollRows(weeks, names, UNKNOWN);
      const company = (await requireCompanyProfile()).name;
      await exportSpreadsheet(format, payrollFileBase(company, period.start, period.end), PAYROLL_COLUMNS, rows);
      const unapproved = unapprovedCount(rows);
      if (rows.length && unapproved) toast.warning(`${unapproved} of ${rows.length} person-weeks in this file are not approved (or changed since approval).`);
      if (rows.length) setOpen(false);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't prepare the payroll export."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setFrom(week); setOpen(true); }} data-testid="payroll-export-open">Payroll export</Button>
      {open ? (
        <Dialog open onOpenChange={(o) => !o && !busy && setOpen(false)}>
          <DialogContent data-testid="payroll-export-dialog">
            <DialogHeader>
              <DialogTitle>Payroll export</DialogTitle>
              <DialogDescription>Everyone&apos;s paid hours, one row per person per week (Monday to Sunday), with days worked, overtime ticks and approval. Hours only: no rates or pay.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <label className="space-y-1"><span className="block font-medium">First week (any day in it)</span>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="payroll-from" /></label>
              <label className="space-y-1"><span className="block font-medium">Number of weeks</span>
                <Input type="number" min={1} max={PAYROLL_MAX_WEEKS} value={count} onChange={(e) => setCount(Number(e.target.value))} data-testid="payroll-weeks" /></label>
            </div>
            <p className="text-sm text-slate-600" data-testid="payroll-range">{period ? `${period.start} to ${period.end} (${period.weekStarts.length} week${period.weekStarts.length === 1 ? "" : "s"})` : "Choose a date."}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="outline" disabled={busy || !period} onClick={() => void run("csv")} data-testid="payroll-csv">Export CSV</Button>
              <Button disabled={busy || !period} onClick={() => void run("xlsx")} data-testid="payroll-xlsx">Export Excel</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
