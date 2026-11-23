"use client";

import { type BasicPackSheet, BasicWorksheetPackPrint, BasicWorksheetPrint } from "@/components/job-worksheet-basic-print";
import { JobWorksheetPackPrint } from "@/components/job-worksheet-pack-print";
import { JobWorksheetPrint } from "@/components/job-worksheet-print";
import { CustomWorksheetPrint, type CustomWorksheetPrintProps } from "@/components/worksheet-builder/custom-worksheet-sheet";
import type { JobWorksheet } from "@/lib/job-worksheet";
import { type CompanyPrintLayout, type PrintLayout, PRINT_LAYOUT_OPTIONS, printLayoutLabel } from "@/lib/print-layout";
import { customChoice } from "@/lib/worksheet-builder/layouts";
import { type PrintOverride, parsePrintOverride } from "@/lib/worksheet-builder/print-choice";

/**
 * The per-print layout choice on the print pages (no-print): "Company setting" prints the company's layout (Settings > Print
 * layout); Basic or JNR sheet prints that layout this time only. Nothing is saved. The company's own worksheet layouts (module K, only
 * when the worksheet builder is on) are listed after Basic and JNR sheet; with none, the list is exactly Basic and JNR sheet.
 */
export function PrintLayoutPicker({ company, value, onChange, customLayouts = [], companyLabel }: {
  company: CompanyPrintLayout | null; value: PrintOverride; onChange: (value: PrintOverride) => void;
  customLayouts?: { id: string; name: string }[]; /** What "Company setting" means when the company prints one of its own layouts. */ companyLabel?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      Layout
      <select
        aria-label="Print layout"
        data-testid="print-layout-override"
        className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm text-black"
        value={value ?? ""}
        onChange={(event) => onChange(parsePrintOverride(event.target.value))}
      >
        <option value="">{companyLabel ?? (company ? `Company setting (${printLayoutLabel(company.layout)})` : "Company setting")}</option>
        {PRINT_LAYOUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        {customLayouts.map((layout) => <option key={layout.id} value={customChoice(layout.id)}>{layout.name}</option>)}
      </select>
    </label>
  );
}

type SheetProps = { worksheet: JobWorksheet; jobNo: string; drawings?: string[]; customerPos?: string[]; /** jobs.traceable (082): Basic only. */ traceable?: boolean };

/** A company's own layout for this print (module K): when given, it prints instead of Basic or JNR sheet. */
export type CustomSheet = Pick<CustomWorksheetPrintProps, "layout" | "requirements" | "jobId" | "customValues">;

/** One job's worksheet in the chosen layout. The JNR sheet is the existing component, untouched (it always prints the numbers). */
export function WorksheetInLayout({ layout, traceable, custom, ...props }: SheetProps & { layout: PrintLayout; custom?: CustomSheet }) {
  if (custom) return <CustomWorksheetPrint {...custom} worksheet={props.worksheet} jobNo={props.jobNo} drawings={props.drawings} customerPos={props.customerPos} traceable={traceable} />;
  return layout === "basic" ? <BasicWorksheetPrint {...props} traceable={traceable} /> : <JobWorksheetPrint {...props} />;
}

/** The workshop pack in the chosen layout. */
export function WorksheetPackInLayout({ layout, sheets }: { layout: PrintLayout; sheets: BasicPackSheet[] }) {
  return layout === "basic" ? <BasicWorksheetPackPrint sheets={sheets} /> : <JobWorksheetPackPrint sheets={sheets} />;
}
