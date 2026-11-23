/**
 * Module K (worksheet builder): the fixed palette of safe blocks a company can put on its own job worksheet.
 *
 * Inputs: none (constants and pure helpers). Outputs: block kinds, their default labels, the built-in field lists and which kinds are
 * locked (see requirements.ts). A block is only ever a kind from this list: a company chooses, orders, hides and renames blocks, and writes
 * plain text into labels and free text. No markup, no scripts, no formulas and no data source other than the job worksheet fields below.
 * Must not change: the kind names and field keys (they are stored in companies' saved layouts); the existing Basic and JNR layouts, which
 * do not use this file to print.
 * Pure (no React, no I/O).
 */
import { fmtDate } from "@/lib/dates";
import type { JobWorksheet } from "@/lib/job-worksheet";

export const BLOCK_KINDS = [
  "header", "jobDetails", "description", "quantityDates", "operations", "materialTrace", "machines", "checklist",
  "drawings", "inspection", "customerSignOff", "internalSignOff", "freeText", "customTick", "customText",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export type ChecklistItem = { key: string; label: string };

export type WorksheetBlock = {
  /** Stable within a layout. Per-job custom values are keyed by it (customTick, customText) so renaming never loses a value. */
  id: string;
  kind: BlockKind;
  visible: boolean;
  /** The block's heading (the sheet title for the header). Plain text. */
  label: string;
  /** Renamed labels of a built-in field, by field key (jobDetails, quantityDates, materialTrace, machines). */
  fieldLabels?: Record<string, string>;
  /** freeText: the text printed in the box. */
  text?: string;
  /** checklist: the items, in order. A standard key reads the job's own checklist; any other key is a per-job custom tick. */
  items?: ChecklistItem[];
  /** materialTrace: print the numbers only on a traceable job (Basic's rule). A traceable job always prints them. */
  traceableOnly?: boolean;
};

export type PaletteEntry = { title: string; description: string; defaultLabel: string; repeatable: boolean };

export const PALETTE: Record<BlockKind, PaletteEntry> = {
  header: { title: "Header with logo", description: "Company logo, name, sheet title and job number.", defaultLabel: "JOB SHEET", repeatable: false },
  jobDetails: { title: "Job and customer details", description: "Customer, customer PO, quote, dimension report and drawing number.", defaultLabel: "Job details", repeatable: false },
  description: { title: "Description", description: "The job description.", defaultLabel: "Description", repeatable: false },
  quantityDates: { title: "Quantity and dates", description: "Quantity, date received and date required.", defaultLabel: "Quantity and dates", repeatable: false },
  operations: { title: "Operations and notes area", description: "A blank operations table and ruled notes area to write on.", defaultLabel: "Operations and notes", repeatable: false },
  materialTrace: { title: "Material cert and heat / cast", description: "Traceability numbers. Cannot be removed.", defaultLabel: "Traceability", repeatable: false },
  machines: { title: "Machines and times", description: "Machines, programs, quoted, taken, set up and run times.", defaultLabel: "Machines and times", repeatable: false },
  checklist: { title: "Part checklist", description: "Tick boxes you can edit. Standard items follow the job's own checklist.", defaultLabel: "Part checklist", repeatable: false },
  drawings: { title: "Drawings list", description: "The job's drawings and attached customer POs.", defaultLabel: "Drawings", repeatable: false },
  inspection: { title: "Inspection", description: "Inspected by, date and result. Cannot be removed.", defaultLabel: "Inspection", repeatable: false },
  customerSignOff: { title: "Customer sign-off", description: "The customer's sign-off. Cannot be removed while Customer sign-off is on.", defaultLabel: "Customer sign-off", repeatable: false },
  internalSignOff: { title: "Internal sign-off", description: "Checked by and signed off. Cannot be removed.", defaultLabel: "Internal sign-off", repeatable: false },
  freeText: { title: "Free text box", description: "A box of fixed text, such as an instruction.", defaultLabel: "Notice", repeatable: true },
  customTick: { title: "Custom tick box", description: "A tick box with your own wording, ticked per job.", defaultLabel: "Tick", repeatable: true },
  customText: { title: "Custom text field", description: "A labelled line you fill in per job.", defaultLabel: "Field", repeatable: true },
};

export type FieldDef = { key: string; label: string; value: (ws: JobWorksheet) => string };

const hours = (v: string) => (v ? `${v} hr` : "");
const machine = (ws: JobWorksheet, n: 1 | 2 | 3) => [ws[`machine_${n}`], ws[`program_${n}`] ? `Prog: ${ws[`program_${n}`]}` : ""].filter(Boolean).join("   ");

/** The built-in fields of the field blocks, in print order. Renaming changes the label only, never what is read. */
export const BLOCK_FIELDS: Partial<Record<BlockKind, FieldDef[]>> = {
  jobDetails: [
    { key: "customer", label: "Customer", value: (ws) => ws.customer },
    { key: "customer_po", label: "Customer PO", value: (ws) => ws.customer_po },
    { key: "quote_ref", label: "Quote no.", value: (ws) => ws.quote_ref },
    { key: "dimension_report_no", label: "Dimension report no.", value: (ws) => ws.dimension_report_no },
    { key: "drawing_no", label: "Drawing no.", value: (ws) => ws.drawing_no },
  ],
  quantityDates: [
    { key: "quantity_required", label: "Quantity", value: (ws) => ws.quantity_required },
    { key: "date_received", label: "Date received", value: (ws) => fmtDate(ws.date_received) },
    { key: "date_required", label: "Date required", value: (ws) => fmtDate(ws.date_required) },
  ],
  materialTrace: [
    { key: "material_cert_no", label: "Material cert no.", value: (ws) => ws.material_cert_no },
    { key: "heat_cast_no", label: "Heat/cast no.", value: (ws) => ws.heat_cast_no },
  ],
  machines: [
    { key: "machine_1", label: "Machine 1 / Program", value: (ws) => machine(ws, 1) },
    { key: "machine_2", label: "Machine 2 / Program", value: (ws) => machine(ws, 2) },
    { key: "machine_3", label: "Machine 3 / Program", value: (ws) => machine(ws, 3) },
    { key: "job_time_quoted_hr", label: "Job time quoted", value: (ws) => hours(ws.job_time_quoted_hr) },
    { key: "job_time_taken_hr", label: "Job time taken", value: (ws) => hours(ws.job_time_taken_hr) },
    { key: "setup_time_hr", label: "Set up time", value: (ws) => hours(ws.setup_time_hr) },
    { key: "run_time_hr", label: "Run time", value: (ws) => hours(ws.run_time_hr) },
  ],
};

/** The label of a built-in field: the company's rename, else the default. */
export function fieldLabel(block: WorksheetBlock, field: FieldDef): string {
  const renamed = block.fieldLabels?.[field.key]?.trim();
  return renamed ? renamed : field.label;
}

/** The heading of a block: the company's label, else the palette default. */
export function blockHeading(block: WorksheetBlock): string {
  return block.label.trim() || PALETTE[block.kind].defaultLabel;
}

export const MAX_LABEL = 80;
export const MAX_FREE_TEXT = 1000;
export const MAX_CHECKLIST_ITEMS = 20;
export const MAX_BLOCKS = 40;
export const MAX_LAYOUTS = 10;
export const MAX_LAYOUT_NAME = 40;
