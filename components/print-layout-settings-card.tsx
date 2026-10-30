"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Printer } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auditEvent } from "@/lib/audit";
import { loadCompanyProfile } from "@/lib/company";
import { friendlyError } from "@/lib/friendly-error";
import { type CompanyPrintLayout, type PrintLayout, PRINT_LAYOUT_OPTIONS, loadCompanyPrintLayout, parsePrintLayout, printLayoutLabel, saveCompanyPrintLayout } from "@/lib/print-layout";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

/** What the card says about the current choice. */
export function printLayoutStatus(company: CompanyPrintLayout): string {
  if (company.source === "saved") return `Your company prints the ${printLayoutLabel(company.layout)} layout.`;
  if (company.source === "default") return `Not chosen yet: your company prints the ${printLayoutLabel(company.layout)} layout, the default for your company.`;
  return `The setting couldn't be read, so worksheets print the ${printLayoutLabel(company.layout)} layout for now.`;
}

/** Settings > Print layout (admins): the layout the job worksheet and workshop pack print in (lib/print-layout). */
export function PrintLayoutCard() {
  const [company, setCompany] = useState<CompanyPrintLayout | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void loadCompanyPrintLayout().then((value) => { if (active) setCompany(value); });
    return () => { active = false; };
  }, []);

  async function change(next: PrintLayout) {
    if (!company || (next === company.layout && company.source === "saved")) return;
    const before = company;
    setSaving(true);
    try {
      await saveCompanyPrintLayout(next, await getCurrentOrganizationId());
      setCompany({ layout: next, saved: next, source: "saved" });
      // Company details holds the profile too: reload it so saving that card writes this choice back unchanged.
      void loadCompanyProfile(true);
      void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", oldData: { printLayout: before.saved }, newData: { printLayout: next }, metadata: { section: "print_layout" } });
      toast.success(`Worksheets now print in the ${printLayoutLabel(next)} layout`);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the print layout."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Printer className="size-5 text-brand-accent" /> Print layout</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">The layout the job worksheet and the workshop pack print in. <strong>Basic</strong> is a plain job sheet: job number, customer, description, quantity, dates, an operations and notes area and sign-off boxes. <strong>JNR sheet</strong> is the full JNR worksheet (material cert, heat / cast, machines, part checklist). Anyone printing can still pick the other layout on the print page.</p>
        {company === null ? <p className="text-slate-500">Loading…</p> : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <label htmlFor="print-layout" className="font-medium text-slate-800">Print layout</label>
              <select
                id="print-layout"
                data-testid="print-layout-setting"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                disabled={saving}
                value={company.layout}
                onChange={(event) => { const next = parsePrintLayout(event.target.value); if (next) void change(next); }}
              >
                {PRINT_LAYOUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <p className="text-xs text-slate-500" data-print-layout-source={company.source}>{printLayoutStatus(company)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
