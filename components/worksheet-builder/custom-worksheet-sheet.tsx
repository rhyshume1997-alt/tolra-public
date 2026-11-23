"use client";

/**
 * Module K (worksheet builder): prints one job on a company's own worksheet layout.
 *
 * Inputs: a layout (lib/worksheet-builder/layouts), the job's worksheet and its drawings/POs, the per-job custom values, the company
 * profile (logo and brand colour, pulled automatically), the printed sign-off state and the company's switches. WorksheetSheet is pure
 * presentation (used by the print pages through CustomWorksheetPrint and by the Settings live preview with sample data).
 * Outputs: A4 portrait HTML. Locked blocks (internal sign-off, traceability, inspection, and customer sign-off while its switch is on) always
 * print, whatever the saved layout says, and a recorded customer sign-off always prints. Nothing here writes to the database.
 * Must not change: the locked-block rule, or the sign-off wording (sign-off-blocks.tsx). The Basic and JNR sheets do not use this file.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { InternalSignOffBlock, CustomerSignOffBlock } from "@/components/worksheet-builder/sign-off-blocks";
import { PrintLogo } from "@/components/print-logo";
import { type CompanyProfile, useCompanyProfile } from "@/lib/company";
import { fmtDate } from "@/lib/dates";
import { loadInspections } from "@/lib/inspection";
import { type PrintedSignOff, useCustomerSignOffSetting, usePrintedSignOffs } from "@/lib/job-signoff";
import { CHECKLIST_ITEMS, type JobWorksheet, signOffState } from "@/lib/job-worksheet";
import { BLOCK_FIELDS, type WorksheetBlock, blockHeading, fieldLabel } from "@/lib/worksheet-builder/blocks";
import { brandInk } from "@/lib/worksheet-builder/brand";
import { type CustomValues, EMPTY_CUSTOM_VALUES } from "@/lib/worksheet-builder/custom-values";
import { type WorksheetLayout, layoutAsOf } from "@/lib/worksheet-builder/layouts";
import { type CompanyRequirements, withRequiredBlocks } from "@/lib/worksheet-builder/requirements";

const exact: CSSProperties = { WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" };
const ruled = { backgroundImage: "repeating-linear-gradient(transparent, transparent 7mm, #999 7mm, #999 calc(7mm + 0.3mm))", ...exact } as const;
const BLANK = " ";
/** The six standard checklist items read the job's own checklist; any other key is a per-job custom tick and never touches it. */
const STANDARD_CHECKLIST_KEYS: ReadonlySet<string> = new Set(CHECKLIST_ITEMS.map((item) => item.key));

/** What the inspection block may say: the newest inspection record's result, inspector and date (never measurements or criteria). */
export type InspectionLine = { result: "pass" | "fail" | "concession"; inspector: string; inspectedAt: string };

export type SheetData = {
  worksheet: JobWorksheet;
  jobNo: string;
  drawings: string[];
  customerPos: string[];
  /** jobs.traceable (082). */
  traceable?: boolean;
  custom: CustomValues;
  inspection: InspectionLine | null;
};

export type SheetEnvironment = { company: CompanyProfile | null; signOff: PrintedSignOff | null; customerOn: boolean | null; requirements: CompanyRequirements };

/** Traceable (082): marked traceable, or a material cert no. or heat/cast no. already recorded. */
function isTraceable(ws: Pick<JobWorksheet, "material_cert_no" | "heat_cast_no">, traceable?: boolean) {
  return traceable === true || Boolean(ws.material_cert_no.trim() || ws.heat_cast_no.trim());
}

const RESULT_WORDS = { pass: "Passed", fail: "Failed", concession: "Released on concession" } as const;

function Heading({ ink, children }: { ink: string; children: ReactNode }) {
  return <div className="border-b-2 px-0.5 pb-0.5 text-[11px] font-bold uppercase" style={{ borderColor: ink, color: ink, ...exact }}>{children}</div>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[9mm] border-b border-black">
      <div className="flex w-[38%] shrink-0 items-center border-r border-black px-2 text-[10px] font-bold uppercase break-words">{label}</div>
      <div className="flex min-w-0 flex-1 items-center px-2 text-[12px] break-words">{value}</div>
    </div>
  );
}

function FieldGrid({ block, worksheet }: { block: WorksheetBlock; worksheet: JobWorksheet }) {
  const fields = BLOCK_FIELDS[block.kind] ?? [];
  return (
    <div className="grid grid-cols-2 border border-b-0 border-black">
      {fields.map((field, index) => (
        <div key={field.key} className={index % 2 === 0 ? "border-r border-black" : ""}><Field label={fieldLabel(block, field)} value={field.value(worksheet)} /></div>
      ))}
      {fields.length % 2 === 1 ? <div className="border-b border-black" /> : null}
    </div>
  );
}

function Slot({ label, children, width = "min-w-[45mm]" }: { label: string; children?: ReactNode; width?: string }) {
  return <span className="flex items-end gap-1.5"><strong className="text-[10px] uppercase">{label}:</strong><span className={`${width} border-b border-black px-1`}>{children ?? BLANK}</span></span>;
}

function Tick({ checked }: { checked: boolean }) {
  return <span className="inline-flex size-4 shrink-0 items-center justify-center border-2 border-black text-[12px] leading-none font-bold">{checked ? "✓" : ""}</span>;
}

function BlockView({ block, data, env, ink }: { block: WorksheetBlock; data: SheetData; env: SheetEnvironment; ink: string }) {
  const { worksheet: ws } = data;
  const heading = blockHeading(block);
  switch (block.kind) {
    case "header":
      return (
        <div className="flex items-end justify-between gap-4 border-b-2 pb-2" style={{ borderColor: ink, ...exact }} data-worksheet-block="header">
          <div className="flex min-w-0 items-end gap-3">
            <PrintLogo company={env.company} className="h-12 w-auto max-w-[40mm] object-contain" />
            <div className="min-w-0">
              {env.company ? <p className="text-[15px] font-bold break-words">{env.company.documentName || env.company.name}</p> : null}
              <p className="text-[18px] font-bold tracking-wide break-words" style={{ color: ink, ...exact }}>{heading}</p>
            </div>
          </div>
          <p className="shrink-0 text-[13px] font-bold">Job no. <span className="ml-1 inline-block min-w-[40mm] border-b border-black px-1 text-center font-mono text-[14px]">{data.jobNo}</span></p>
        </div>
      );
    case "jobDetails":
    case "quantityDates":
      return <div data-worksheet-block={block.kind}><Heading ink={ink}>{heading}</Heading><FieldGrid block={block} worksheet={ws} /></div>;
    case "materialTrace":
      if (block.traceableOnly && !isTraceable(ws, data.traceable)) return null;
      return <div data-worksheet-block="materialTrace" data-traceability=""><Heading ink={ink}>{heading}</Heading><FieldGrid block={block} worksheet={ws} /></div>;
    case "machines":
      return <div data-worksheet-block="machines"><Heading ink={ink}>{heading}</Heading><FieldGrid block={block} worksheet={ws} /></div>;
    case "description":
      return <div data-worksheet-block="description"><Heading ink={ink}>{heading}</Heading><div className="border border-t-0 border-black px-2 py-1 text-[12px] break-words whitespace-pre-wrap" style={{ minHeight: "24mm" }}>{ws.description}</div></div>;
    case "operations":
      return (
        <div data-worksheet-block="operations">
          <Heading ink={ink}>{heading}</Heading>
          <table className="w-full table-fixed border-collapse text-[10px]">
            <thead><tr>{[["No.", "8%"], ["Operation", "52%"], ["Done by", "16%"], ["Date", "12%"], ["Hours", "12%"]].map(([label, width]) => <th key={label} className="border border-t-0 border-black px-1 py-0.5 text-left font-bold uppercase" style={{ width }}>{label}</th>)}</tr></thead>
            <tbody>{Array.from({ length: 8 }, (_, i) => <tr key={i} className="h-[8mm]">{Array.from({ length: 5 }, (_, j) => <td key={j} className="border border-black px-1">{j === 0 ? i + 1 : BLANK}</td>)}</tr>)}</tbody>
          </table>
          <div className="mt-2 border border-black" style={{ minHeight: "22mm", ...ruled }} aria-label="Notes" />
        </div>
      );
    case "checklist":
      return (
        <div data-worksheet-block="checklist">
          <Heading ink={ink}>{heading}</Heading>
          <div className="grid grid-cols-3 gap-y-1 border border-t-0 border-black px-2 py-1.5 text-[12px]">
            {(block.items ?? []).map((item) => (
              <div key={item.key} className="flex items-center gap-1.5 break-words"><Tick checked={STANDARD_CHECKLIST_KEYS.has(item.key) ? ws.checklist[item.key as keyof typeof ws.checklist] === true : data.custom.ticks[item.key] === true} />{item.label}</div>
            ))}
            <div className="col-span-3 mt-1 flex items-end gap-2">Signed off by: <span className="inline-block min-w-[60mm] border-b border-black px-1">{ws.checked_by}</span></div>
          </div>
        </div>
      );
    case "drawings":
      return (
        <div data-worksheet-block="drawings">
          {data.customerPos.length ? <p className="text-[10px] break-words"><strong>Customer PO attached:</strong> {data.customerPos.join(", ")}</p> : null}
          {data.drawings.length ? <p className="text-[10px] break-words"><strong>{heading}:</strong> {data.drawings.join(", ")}</p> : null}
        </div>
      );
    case "inspection":
      return (
        <div className="border border-black" style={{ breakInside: "avoid" }} data-worksheet-block="inspection" data-inspection={data.inspection ? data.inspection.result : "blank"}>
          <div className="border-b border-black px-2 py-1 text-[11px] font-bold uppercase" style={{ color: ink, ...exact }}>{heading}</div>
          <div className="flex flex-wrap items-end gap-3 px-2 py-2 text-[12px]">
            <Slot label="Inspected by">{data.inspection?.inspector || undefined}</Slot>
            <Slot label="Date" width="min-w-[30mm]">{data.inspection ? fmtDate(data.inspection.inspectedAt) : undefined}</Slot>
            <Slot label="Result" width="min-w-[35mm]">{data.inspection ? RESULT_WORDS[data.inspection.result] : undefined}</Slot>
          </div>
        </div>
      );
    case "internalSignOff":
      return <InternalSignOffBlock heading={heading} worksheet={ws} signOff={env.signOff} ink={ink} />;
    case "customerSignOff":
      return <CustomerSignOffBlock heading={heading} signOff={env.signOff} ink={ink} />;
    case "freeText":
      return <div className="border border-black px-2 py-1.5 text-[11px] break-words whitespace-pre-wrap" data-worksheet-block="freeText">{block.label.trim() ? <strong className="block text-[10px] uppercase">{block.label}</strong> : null}{block.text}</div>;
    case "customTick":
      return <div className="flex items-center gap-1.5 text-[12px] break-words" data-worksheet-block="customTick"><Tick checked={data.custom.ticks[block.id] === true} />{heading}</div>;
    case "customText":
      return <div className="flex items-end gap-1.5 text-[12px]" data-worksheet-block="customText"><strong className="text-[10px] uppercase">{heading}:</strong><span className="min-w-[60mm] flex-1 border-b border-black px-1 break-words">{data.custom.texts[block.id] || BLANK}</span></div>;
  }
}

/** The blocks that print: the layout with every locked block present and visible, and a recorded customer sign-off always shown. */
export function printedBlocks(layout: WorksheetLayout, env: Pick<SheetEnvironment, "requirements" | "customerOn" | "signOff">): WorksheetBlock[] {
  const requirements = { customerSignOff: env.requirements.customerSignOff || env.customerOn === true };
  const recorded = (env.signOff?.customer?.length ?? 0) > 0;
  return withRequiredBlocks(layout, requirements).blocks.map((block) => (block.kind === "customerSignOff" && recorded && !block.visible ? { ...block, visible: true } : block)).filter((block) => block.visible);
}

/** When the job was signed off (the newest sign-off record, or the old typed box), so a signed worksheet reprints on the layout it was signed on. */
export function signedAtOf(worksheet: Pick<JobWorksheet, "signed_off_by" | "signed_off_at">, signOff: PrintedSignOff | null): string | null {
  if (signOff && (signOff.status === "signed" || signOff.status === "stale")) return signOff.latest.created_at;
  const legacy = signOffState(worksheet);
  return legacy.status === "signed" ? worksheet.signed_off_at : null;
}

export function WorksheetSheet({ layout, data, env }: { layout: WorksheetLayout; data: SheetData; env: SheetEnvironment }) {
  const ink = brandInk(env.company?.brandPrimary);
  const blocks = printedBlocks(layoutAsOf(layout, signedAtOf(data.worksheet, env.signOff)), env);
  return (
    <div className="mx-auto w-[210mm] space-y-2 bg-white text-black print:w-full" style={{ fontFamily: "Arial, Helvetica, sans-serif", ...exact }} data-print-layout="custom" data-custom-layout={layout.id}>
      {blocks.map((block) => <BlockView key={block.id} block={block} data={data} env={env} ink={ink} />)}
    </div>
  );
}

/** The newest inspection of a job as the block prints it. Never throws: no record (or no access) prints as the blank boxes. */
function useInspectionLine(jobId: string | undefined, enabled: boolean): InspectionLine | null {
  const [line, setLine] = useState<InspectionLine | null>(null);
  useEffect(() => {
    if (!jobId || !enabled) return;
    let active = true;
    loadInspections(jobId).then((records) => {
      const latest = records[0];
      if (active) setLine(latest ? { result: latest.result, inspector: (latest.inspector_name ?? "").includes("@") ? "" : latest.inspector_name ?? "", inspectedAt: latest.inspected_at } : null);
    }, () => { if (active) setLine(null); });
    return () => { active = false; };
  }, [jobId, enabled]);
  return line;
}

export type CustomWorksheetPrintProps = {
  layout: WorksheetLayout;
  requirements: CompanyRequirements;
  worksheet: JobWorksheet;
  jobNo: string;
  jobId?: string;
  drawings?: string[];
  customerPos?: string[];
  traceable?: boolean;
  customValues?: CustomValues;
};

/** The print page's entry: loads the company profile, sign-offs and inspection itself, like the Basic and JNR sheets. */
export function CustomWorksheetPrint({ layout, requirements, worksheet, jobNo, jobId, drawings = [], customerPos = [], traceable, customValues = EMPTY_CUSTOM_VALUES }: CustomWorksheetPrintProps) {
  const number = jobNo || worksheet.job_no;
  const signOff = usePrintedSignOffs([number])?.get(number) ?? null;
  const customerOn = useCustomerSignOffSetting();
  const { profile: company } = useCompanyProfile();
  const inspection = useInspectionLine(jobId, true);
  return <WorksheetSheet layout={layout} data={{ worksheet, jobNo, drawings, customerPos, traceable, custom: customValues, inspection }} env={{ company, signOff, customerOn, requirements }} />;
}
