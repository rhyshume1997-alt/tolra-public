"use client";

import { BasicWorksheetPackPrint, BasicWorksheetPrint } from "@/components/job-worksheet-basic-print";
import { JobWorksheetPackPrint, type PackSheet } from "@/components/job-worksheet-pack-print";
import { JobWorksheetPrint } from "@/components/job-worksheet-print";
import type { JobWorksheet } from "@/lib/job-worksheet";
import { type CompanyPrintLayout, type PrintLayout, PRINT_LAYOUT_OPTIONS, parsePrintLayout, printLayoutLabel } from "@/lib/print-layout";

/**
 * The per-print layout choice on the print pages (no-print): "Company setting" prints the company's layout (Settings > Print
 * layout); Basic or JNR sheet prints that layout this time only. Nothing is saved.
 */
export function PrintLayoutPicker({ company, value, onChange }: { company: CompanyPrintLayout | null; value: PrintLayout | null; onChange: (value: PrintLayout | null) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      Layout
      <select
        aria-label="Print layout"
        data-testid="print-layout-override"
        className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm text-black"
        value={value ?? ""}
        onChange={(event) => onChange(parsePrintLayout(event.target.value))}
      >
        <option value="">{company ? `Company setting (${printLayoutLabel(company.layout)})` : "Company setting"}</option>
        {PRINT_LAYOUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

type SheetProps = { worksheet: JobWorksheet; jobNo: string; drawings?: string[]; customerPos?: string[] };

/** One job's worksheet in the chosen layout. The JNR sheet is the existing component, untouched. */
export function WorksheetInLayout({ layout, ...props }: SheetProps & { layout: PrintLayout }) {
  return layout === "basic" ? <BasicWorksheetPrint {...props} /> : <JobWorksheetPrint {...props} />;
}

/** The workshop pack in the chosen layout. */
export function WorksheetPackInLayout({ layout, sheets }: { layout: PrintLayout; sheets: PackSheet[] }) {
  return layout === "basic" ? <BasicWorksheetPackPrint sheets={sheets} /> : <JobWorksheetPackPrint sheets={sheets} />;
}
