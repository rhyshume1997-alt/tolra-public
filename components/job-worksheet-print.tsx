"use client";

import type { CSSProperties } from "react";

import { SignatureImage } from "@/components/signature-pad";
import { CUSTOMER_SIGNOFF_STATEMENT, customerLine, formatSignedAt, hashPrefix, kindLabel, legacySignOffText, useCustomerSignOffSetting, usePrintedSignOffs } from "@/lib/job-signoff";
import { fmtDate } from "@/lib/dates";
import { CHECKLIST_ITEMS, type JobWorksheet, isOverrun, signOffState } from "@/lib/job-worksheet";
import { useCompanyProfile } from "@/lib/company";
import { PrintLogo } from "@/components/print-logo";

const COLOURS = { grey: "#b8c0cc", paleYellow: "#fff6c2", green: "#b5dca0", yellow: "#ffe44d", peach: "#f8caa4", blueGrey: "#cfd9e8", red: "#c00000" };
const exact: CSSProperties = { WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" };

function Label({ bg, children }: { bg: string; children: React.ReactNode }) {
  return <div className="flex w-[38%] shrink-0 items-center border-r border-black px-1.5 py-1 text-[10px] font-bold uppercase" style={{ background: bg, ...exact }}>{children}</div>;
}

function Row({ bg, label, value }: { bg: string; label: string; value: string }) {
  return <div className="flex min-h-[8mm] border-b border-black last:border-b-0"><Label bg={bg}>{label}</Label><div className="flex flex-1 items-center px-1.5 text-[12px]">{value}</div></div>;
}

function Bar({ bg, children, color }: { bg: string; children: React.ReactNode; color?: string }) {
  return <div className="border border-black px-2 py-1 text-center text-[11px] font-bold uppercase" style={{ background: bg, color, ...exact }}>{children}</div>;
}

function Lines({ value, min = "22mm" }: { value: string; min?: string }) {
  return (
    <div className="border border-t-0 border-black px-2 py-1 text-[12px] whitespace-pre-wrap" style={{ minHeight: min, backgroundImage: value ? undefined : "repeating-linear-gradient(transparent, transparent 6.5mm, #888 6.5mm, #888 calc(6.5mm + 0.3mm))", ...exact }}>{value}</div>
  );
}

function Cell({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return <div className={`flex min-h-[8mm] border-b border-black ${wide ? "" : "last:border-b-0"}`}><div className="flex w-[34%] shrink-0 items-center border-r border-black px-1.5 py-1 text-[10px] font-bold uppercase" style={{ background: COLOURS.blueGrey, ...exact }}>{label}</div><div className="flex flex-1 items-center px-1.5 text-[12px]">{value}</div></div>;
}

export function JobWorksheetPrint({ worksheet: ws, jobNo, drawings = [], customerPos = [] }: { worksheet: JobWorksheet; jobNo: string; drawings?: string[]; /** The customer's PO files in the job pack (067). */ customerPos?: string[] }) {
  const overrun = isOverrun(ws);
  const signOff = usePrintedSignOffs([jobNo || ws.job_no])?.get(jobNo || ws.job_no) ?? null;
  // The old typed box (before migration 045) is an existing record: printed as such, clearly apart from a hashed sign-off.
  const legacyBox = signOffState(ws);
  const legacyText = signOff ? legacySignOffText(signOff, legacyBox.status === "signed" ? legacyBox : null) : null;
  // Customer sign-off (072): printed when the job has one, or as an empty box to sign on paper when the company has it on.
  const customerOn = useCustomerSignOffSetting();
  const customers = signOff?.customer ?? [];
  const { profile: company } = useCompanyProfile();
  const hours = (v: string) => (v ? `${v} hr` : "");
  const materialOrdered = [ws.material_ordered ? "YES" : "", ws.material_ordered_at ? fmtDate(ws.material_ordered_at) : "", ws.material_ordered_notes].filter(Boolean).join(" - ");
  const machine = (n: 1 | 2 | 3) => [ws[`machine_${n}`], ws[`program_${n}`] ? `Prog: ${ws[`program_${n}`]}` : ""].filter(Boolean).join("   ");

  return (
    <div className="mx-auto w-[210mm] bg-white text-black print:w-full" style={{ ...exact, fontFamily: "Arial, Helvetica, sans-serif" }}>
      <div className="mb-1 flex items-end justify-between">
        <div className="flex items-end gap-3">
          <PrintLogo company={company} className="h-12 w-auto max-w-[35mm] object-contain" />
          <p className="text-[16px] font-black tracking-wide">{company ? company.name.toUpperCase() : "Company details not set"}</p>
        </div>
        <p className="text-[13px] font-bold">JOB No <span className="ml-1 inline-block min-w-[40mm] border-b border-black px-1 text-center font-mono text-[14px]">{jobNo}</span></p>
      </div>
      <p className="mb-1.5 text-center text-[18px] font-black tracking-wide">(SINGLE PART) WORKSHEET</p>

      <div className="grid grid-cols-2 border border-black">
        <div className="border-r border-black">
          <Row bg={COLOURS.grey} label="Customer" value={ws.customer} />
          <Row bg={COLOURS.paleYellow} label="Date Received" value={fmtDate(ws.date_received)} />
          <Row bg={COLOURS.green} label="Quote #" value={ws.quote_ref} />
          <Row bg={COLOURS.yellow} label="Material Cert #" value={ws.material_cert_no} />
          <Row bg={COLOURS.peach} label="Job Time Quoted" value={hours(ws.job_time_quoted_hr)} />
        </div>
        <div>
          <Row bg={COLOURS.grey} label="Purchase Order #" value={ws.customer_po} />
          <Row bg={COLOURS.paleYellow} label="Date Required" value={fmtDate(ws.date_required)} />
          <Row bg={COLOURS.green} label="Dimension Report #" value={ws.dimension_report_no} />
          <Row bg={COLOURS.yellow} label="Heat / Cast #" value={ws.heat_cast_no} />
          <Row bg={COLOURS.peach} label="Job Time Taken" value={hours(ws.job_time_taken_hr)} />
        </div>
      </div>

      <div className="mt-1.5"><Bar bg={COLOURS.blueGrey}>Job Description</Bar><Lines value={ws.description} min="20mm" /></div>

      <div className="mt-1.5 border border-black">
        <Cell label="Drawing #" value={ws.drawing_no} />
        <Cell label="Quantity Req" value={ws.quantity_required} />
        <Cell label="Material Required" value={ws.material_required} />
        <Cell label="Material Ordered" value={materialOrdered} />
        <Cell label="Material Supplier" value={ws.material_supplier} />
        <Cell label="Machine # 1 / Program #" value={machine(1)} />
        <Cell label="Machine # 2 / Program #" value={machine(2)} />
        <Cell label="Machine # 3 / Program #" value={machine(3)} />
        <Cell label="Set Up Time" value={hours(ws.setup_time_hr)} />
        <Cell label="Run Time" value={hours(ws.run_time_hr)} />
      </div>

      <div className="mt-1.5"><Bar bg={COLOURS.blueGrey}>Comments for Improvement</Bar><Lines value={ws.improvement_comments} min="18mm" /></div>

      <div className="mt-1.5">
        <Bar bg={overrun ? "#fde2e2" : COLOURS.blueGrey} color={overrun ? COLOURS.red : undefined}>Reasons for Overrun / Delays{overrun ? " (job time taken exceeds quoted)" : ""}</Bar>
        <div className={overrun ? "border-2 border-t-0 border-[#c00000]" : ""}><Lines value={ws.overrun_reasons} min="16mm" /></div>
      </div>

      {customerPos.length ? <p className="mt-1 text-[10px]"><strong>CUSTOMER PO ATTACHED:</strong> {customerPos.join(", ")}</p> : null}
      {drawings.length ? <p className="mt-1 text-[10px]"><strong>DRAWINGS:</strong> {drawings.join(", ")}</p> : null}

      <div className="mt-1.5">
        <Bar bg={COLOURS.red} color="#fff">Part Checklist Must Be Completed</Bar>
        <div className="grid grid-cols-3 gap-y-1 border border-t-0 border-black px-2 py-1.5 text-[12px]">
          {CHECKLIST_ITEMS.map((item) => (
            <div key={item.key} className="flex items-center gap-1.5"><span className="inline-flex size-4 items-center justify-center border-2 border-black text-[12px] leading-none font-bold">{ws.checklist[item.key] ? "✓" : ""}</span>{item.label}</div>
          ))}
          <div className="col-span-3 mt-1 flex items-end gap-2">Signed off by: <span className="inline-block min-w-[60mm] border-b border-black px-1">{ws.checked_by}</span></div>
        </div>
      </div>

      <p className="mt-1.5 text-center text-[10.5px] font-bold" style={{ color: COLOURS.red }}>ALL PARTS MUST BE CHECKED AND MARKED FOR IDENTIFICATION BEFORE SIGN OFF (e.g. Black Ink Marker)</p>
      <p className="text-center text-[10.5px] font-bold" style={{ color: COLOURS.red }}>ANY EXCESS MATERIAL MUST BE MARKED WITH MATERIAL GRADE AND HEAT/CAST NUMBER.</p>

      <div className="mt-1.5 border border-black">
        <div className="px-2 py-1 text-center text-[11px] font-bold uppercase" style={{ background: "#ffe44d", ...exact }}>INTERNAL SIGN OFF (All Worksheets Must Be Signed Off)</div>
        <div className="flex min-h-[10mm] items-end gap-2 border-t border-black px-2 py-1 text-[12px]">
          <strong className="text-[10px] uppercase">Name:</strong>
          <span className="min-w-[60mm] border-b border-black px-1" data-signoff={signOff === null ? "loading" : signOff.status === "signed" ? "signed" : legacyText ? "legacy" : "unsigned"}>
            {signOff?.status === "signed" ? `${signOff.latest.initials} ${signOff.latest.signer_name} (signed ${fmtDate(signOff.latest.signed_on)}, revision ${signOff.latest.worksheet_version}, sha256 ${hashPrefix(signOff.latest.snapshot_sha256)})` : null}
            {signOff?.status === "signed" ? signOff.cosigns.map((row) => (
              <span key={row.id} className="block text-[10px]" data-signoff-cosign={row.kind}>{kindLabel(row.kind)} co-signature: {row.initials} {row.signer_name} (signed {fmtDate(row.signed_on)})</span>
            )) : null}
            {signOff?.status === "stale" ? <strong style={{ color: COLOURS.red, ...exact }}>NOT SIGNED OFF (revision {signOff.latest.worksheet_version} was signed; edited since)</strong> : null}
            {signOff?.status === "none" ? (legacyText ? <span className="text-[10px]">{legacyText}</span> : <strong style={{ color: COLOURS.red, ...exact }}>Not signed off</strong>) : null}
            {signOff === null ? "\u00a0" : null}
          </span>
          <strong className="ml-auto text-[10px] uppercase">Signature:</strong>
          <span className="min-w-[60mm] border-b border-black px-1">
            {signOff?.status === "signed" ? [signOff.latest, ...signOff.cosigns].map((row) => (
              <span key={row.id} className="inline-block align-bottom">{row.signature_kind === "drawn" ? <SignatureImage path={row.signature_data} className="h-[9mm] w-[27mm]" /> : <span className="font-serif italic">{row.signature_data}</span>}</span>
            )) : "\u00a0"}
          </span>
        </div>
      </div>

      {customers.length || customerOn ? (
        <div className="mt-1.5 border border-black" style={{ breakInside: "avoid" }} data-customer-signoff-print={customers.length ? "signed" : "blank"}>
          <div className="px-2 py-1 text-center text-[11px] font-bold uppercase" style={{ background: COLOURS.green, ...exact }}>Customer Sign Off</div>
          {customers.length ? customers.map((row) => (
            <div key={row.id} className="flex items-end gap-3 border-t border-black px-2 py-1 text-[11px]">
              <div className="min-w-0 flex-1">
                <p><strong>{customerLine(row)}</strong></p>
                {row.statement ? <p className="italic">&ldquo;{row.statement}&rdquo;</p> : null}
                {row.customer_comment ? <p className="whitespace-pre-wrap">Comment: {row.customer_comment}</p> : null}
                <p className="text-[9px]">Signed {formatSignedAt(row.device_signed_at) || fmtDate(row.signed_on)} (phone time); received {formatSignedAt(row.created_at)}; revision {row.worksheet_version}, sha256 {hashPrefix(row.record_sha256)}</p>
              </div>
              <span className="shrink-0 border-b border-black px-1">{row.signature_kind === "drawn" ? <SignatureImage path={row.signature_data} className="h-[12mm] w-[40mm]" /> : <span className="font-serif text-[14px] italic">{row.signature_data}</span>}</span>
            </div>
          )) : (<>
            <p className="border-t border-black px-2 py-1 text-[11px] italic">{CUSTOMER_SIGNOFF_STATEMENT}</p>
            <div className="flex min-h-[12mm] items-end gap-2 px-2 py-1 text-[12px]">
              <strong className="text-[10px] uppercase">Name:</strong><span className="min-w-[50mm] border-b border-black px-1">{"\u00a0"}</span>
              <strong className="text-[10px] uppercase">Signature:</strong><span className="min-w-[50mm] border-b border-black px-1">{"\u00a0"}</span>
              <strong className="text-[10px] uppercase">Date:</strong><span className="min-w-[25mm] border-b border-black px-1">{"\u00a0"}</span>
            </div>
          </>)}
        </div>
      ) : null}
    </div>
  );
}
