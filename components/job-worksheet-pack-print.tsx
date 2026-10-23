"use client";

import type { CSSProperties, ReactNode } from "react";

import { type PrintedSignOff, customerLine, hashPrefix, kindLabel, legacySignOffText, usePrintedSignOffs } from "@/lib/job-signoff";
import { CHECKLIST_ITEMS, type JobWorksheet, formatDateGB, isOverrun, signOffState } from "@/lib/job-worksheet";
import { useCompanyProfile } from "@/lib/company";
import { PrintLogo } from "@/components/print-logo";

// Same colours and sections as the single worksheet (components/job-worksheet-print.tsx), one row per job.
const COLOURS = { grey: "#b8c0cc", paleYellow: "#fff6c2", green: "#b5dca0", yellow: "#ffe44d", peach: "#f8caa4", blueGrey: "#cfd9e8", red: "#c00000" };
const exact: CSSProperties = { WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" };
const SHORT_CHECKS: Record<string, string> = { sizes_checked: "Sizes", threads_check: "Threads", parts_deburred: "Deburred", parts_marked: "Marked", parts_clean: "Clean", parts_counted: "Counted" };

export type PackSheet = { id: string; worksheet: JobWorksheet; drawings: string[] };

function Th({ bg, color, width, children }: { bg: string; color?: string; width?: string; children: ReactNode }) {
  return <th className="border border-black px-1 py-0.5 text-left align-bottom text-[8.5px] leading-tight font-bold uppercase" style={{ background: bg, color, width, ...exact }}>{children}</th>;
}

/** Two values stacked in one cell, each with a small caption. */
function Pair({ a, b }: { a: [string, string]; b: [string, string] }) {
  return (
    <div className="space-y-0.5">
      <div><span className="text-[7.5px] text-slate-600 uppercase">{a[0]} </span>{a[1]}</div>
      <div><span className="text-[7.5px] text-slate-600 uppercase">{b[0]} </span>{b[1]}</div>
    </div>
  );
}

function Lines({ min }: { min: string }) {
  return <div className="border border-t-0 border-black" style={{ minHeight: min, backgroundImage: "repeating-linear-gradient(transparent, transparent 6.5mm, #888 6.5mm, #888 calc(6.5mm + 0.3mm))", ...exact }} />;
}

function Bar({ bg, color, children }: { bg: string; color?: string; children: ReactNode }) {
  return <div className="border border-black px-2 py-0.5 text-center text-[10px] font-bold uppercase" style={{ background: bg, color, ...exact }}>{children}</div>;
}

export function JobWorksheetPackPrint({ sheets }: { sheets: PackSheet[] }) {
  const { profile: company } = useCompanyProfile();
  const signOffs = usePrintedSignOffs(sheets.map((sheet) => sheet.worksheet.job_no));
  const hours = (v: string) => (v ? `${v} hr` : "");
  const drawings = sheets.filter((sheet) => sheet.drawings.length);
  const overruns = sheets.filter((sheet) => sheet.worksheet.overrun_reasons.trim());
  const comments = sheets.filter((sheet) => sheet.worksheet.improvement_comments.trim());

  return (
    <div className="mx-auto w-[297mm] max-w-full bg-white text-black print:w-full" style={{ ...exact, fontFamily: "Arial, Helvetica, sans-serif" }}>
      <div className="mb-1 flex items-end justify-between">
        <div className="flex items-end gap-3">
          <PrintLogo company={company} className="h-10 w-auto max-w-[35mm] object-contain" />
          <p className="text-[15px] font-black tracking-wide">{company ? company.name.toUpperCase() : "Company details not set"}</p>
        </div>
        <p className="text-[12px] font-bold">JOBS <span className="ml-1 inline-block min-w-[20mm] border-b border-black px-1 text-center font-mono text-[13px]">{sheets.length}</span></p>
      </div>
      <p className="mb-1 text-center text-[17px] font-black tracking-wide">(MULTI PART) WORKSHEET</p>

      <table className="w-full table-fixed border-collapse text-[9.5px] leading-snug">
        <thead>
          <tr>
            <Th bg={COLOURS.grey} width="11%">Job No / Customer</Th>
            <Th bg={COLOURS.grey} width="8%">PO # / Quote #</Th>
            <Th bg={COLOURS.paleYellow} width="7.5%">Received / Required</Th>
            <Th bg={COLOURS.blueGrey} width="14%">Job Description</Th>
            <Th bg={COLOURS.blueGrey} width="8%">Drawing # / Qty Req</Th>
            <Th bg={COLOURS.blueGrey} width="10%">Material Req / Supplier</Th>
            <Th bg={COLOURS.yellow} width="8%">Material Cert # / Heat-Cast #</Th>
            <Th bg={COLOURS.blueGrey} width="9%">Machine / Program #</Th>
            <Th bg={COLOURS.blueGrey} width="5.5%">Set Up / Run</Th>
            <Th bg={COLOURS.peach} width="5.5%">Quoted / Taken</Th>
            <Th bg={COLOURS.red} color="#fff" width="8.5%">Part Checklist</Th>
            <Th bg={COLOURS.green} width="5%">Signed off by</Th>
          </tr>
        </thead>
        <tbody>
          {sheets.map(({ id, worksheet: ws }) => {
            const overrun = isOverrun(ws);
            const machines = ([1, 2, 3] as const)
              .map((n) => [ws[`machine_${n}`], ws[`program_${n}`] ? `Prog: ${ws[`program_${n}`]}` : ""].filter(Boolean).join(" "))
              .filter(Boolean);
            return (
              <tr key={id} className="align-top" style={{ breakInside: "avoid" }}>
                <td className="border border-black px-1 py-1"><p className="font-mono text-[10.5px] font-bold">{ws.job_no}</p><p>{ws.customer}</p></td>
                <td className="border border-black px-1 py-1"><Pair a={["PO", ws.customer_po]} b={["Quote", ws.quote_ref]} /></td>
                <td className="border border-black px-1 py-1"><Pair a={["In", formatDateGB(ws.date_received)]} b={["Req", formatDateGB(ws.date_required)]} /></td>
                <td className="border border-black px-1 py-1 break-words whitespace-pre-wrap">{ws.description}</td>
                <td className="border border-black px-1 py-1 break-words"><Pair a={["Dwg", ws.drawing_no]} b={["Qty", ws.quantity_required]} /></td>
                <td className="border border-black px-1 py-1 break-words">
                  <Pair a={["Req", ws.material_required]} b={["Supp", ws.material_supplier]} />
                  {ws.material_ordered || ws.material_ordered_at ? <p className="text-[8px]">Ordered{ws.material_ordered_at ? ` ${formatDateGB(ws.material_ordered_at)}` : ""}</p> : null}
                </td>
                <td className="border border-black px-1 py-1 break-words"><Pair a={["Cert", ws.material_cert_no]} b={["Heat", ws.heat_cast_no]} /></td>
                <td className="border border-black px-1 py-1 break-words">{machines.map((line) => <p key={line}>{line}</p>)}</td>
                <td className="border border-black px-1 py-1"><Pair a={["Set", hours(ws.setup_time_hr)]} b={["Run", hours(ws.run_time_hr)]} /></td>
                <td className="border border-black px-1 py-1" style={overrun ? { color: COLOURS.red, fontWeight: 700 } : undefined}><Pair a={["Qtd", hours(ws.job_time_quoted_hr)]} b={["Tkn", hours(ws.job_time_taken_hr)]} /></td>
                <td className="border border-black px-1 py-1">
                  <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
                    {CHECKLIST_ITEMS.map((item) => (
                      <span key={item.key} className="flex items-center gap-0.5 text-[8px]">
                        <span className="inline-flex size-2.5 shrink-0 items-center justify-center border border-black text-[8px] leading-none font-bold">{ws.checklist[item.key] ? "✓" : ""}</span>
                        {SHORT_CHECKS[item.key] ?? item.label}
                      </span>
                    ))}
                  </div>
                  {ws.checked_by ? <p className="mt-0.5 text-[8px]">Checked: {ws.checked_by}</p> : null}
                </td>
                <td className="border border-black px-1 py-1 break-words" data-signoff={signOffs === null ? "loading" : signOffs.get(ws.job_no)?.status === "signed" ? "signed" : legacyText(ws, signOffs) ? "legacy" : "unsigned"}><SignOff state={signOffs === null ? null : signOffs.get(ws.job_no) ?? { status: "none" }} legacy={legacyText(ws, signOffs)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {drawings.length ? <p className="mt-1 text-[9px]"><strong>DRAWINGS:</strong> {drawings.map((sheet) => `${sheet.worksheet.job_no}: ${sheet.drawings.join(", ")}`).join("; ")}</p> : null}

      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <div>
          <Bar bg={COLOURS.blueGrey}>Comments for Improvement</Bar>
          {comments.length ? <div className="border border-t-0 border-black px-2 py-1 text-[10px] whitespace-pre-wrap">{comments.map((sheet) => `${sheet.worksheet.job_no}: ${sheet.worksheet.improvement_comments}`).join("\n")}</div> : <Lines min="14mm" />}
        </div>
        <div>
          <Bar bg={COLOURS.blueGrey}>Reasons for Overrun / Delays</Bar>
          {overruns.length ? <div className="border border-t-0 border-black px-2 py-1 text-[10px] whitespace-pre-wrap">{overruns.map((sheet) => `${sheet.worksheet.job_no}: ${sheet.worksheet.overrun_reasons}`).join("\n")}</div> : <Lines min="14mm" />}
        </div>
      </div>

      <p className="mt-1 text-center text-[9.5px] font-bold" style={{ color: COLOURS.red }}>ALL PARTS MUST BE CHECKED AND MARKED FOR IDENTIFICATION BEFORE SIGN OFF (e.g. Black Ink Marker)</p>
      <p className="text-center text-[9.5px] font-bold" style={{ color: COLOURS.red }}>ANY EXCESS MATERIAL MUST BE MARKED WITH MATERIAL GRADE AND HEAT/CAST NUMBER.</p>

      <div className="mt-1 border border-black" style={{ breakInside: "avoid" }}>
        <div className="px-2 py-0.5 text-center text-[10px] font-bold uppercase" style={{ background: COLOURS.yellow, ...exact }}>INTERNAL SIGN OFF (All Worksheets Must Be Signed Off)</div>
        <div className="flex min-h-[9mm] items-end gap-2 border-t border-black px-2 py-1 text-[11px]">
          <strong className="text-[9px] uppercase">Name:</strong>
          <span className="min-w-[60mm] border-b border-black px-1">&nbsp;</span>
          <strong className="ml-auto text-[9px] uppercase">Signature:</strong>
          <span className="min-w-[60mm] border-b border-black px-1">&nbsp;</span>
        </div>
      </div>
    </div>
  );
}

/** The old typed box (before migration 045), when the job has no hashed sign-off at all: an existing record, printed as what it is. */
function legacyText(ws: JobWorksheet, signOffs: Map<string, PrintedSignOff> | null) {
  const box = signOffState(ws);
  return signOffs === null ? null : legacySignOffText(signOffs.get(ws.job_no) ?? { status: "none" }, box.status === "signed" ? box : null);
}

/** The sign-off for the job's current revision (M4): initials, name, date and hash prefix, then any co-signature; anything else prints as not signed off. */
function SignOff({ state, legacy }: { state: PrintedSignOff | null; legacy: string | null }) {
  if (state === null) return null;
  // A customer's sign-off (072), when the job has one: a line under the internal sign-off (jobs without one print as before).
  const customer = state.customer?.length ? <p className="text-[8px]" data-customer-signoff-print="signed">Customer: {state.customer.map((row) => `${customerLine(row)}, ${formatDateGB(row.signed_on)}`).join("; ")}</p> : null;
  return <>{internalSignOff(state, legacy)}{customer}</>;
}

function internalSignOff(state: PrintedSignOff, legacy: string | null) {
  if (legacy) return <span className="text-[8px]">{legacy}</span>;
  if (state.status === "signed") return <>{state.latest.initials} {state.latest.signer_name}<p className="text-[8px]">Signed {formatDateGB(state.latest.signed_on)} (rev {state.latest.worksheet_version}, sha256 {hashPrefix(state.latest.snapshot_sha256)})</p>{state.cosigns.map((row) => <p key={row.id} className="text-[8px]" data-signoff-cosign={row.kind}>{kindLabel(row.kind)}: {row.initials} {row.signer_name}, {formatDateGB(row.signed_on)}</p>)}</>;
  if (state.status === "stale") return <strong style={{ color: COLOURS.red }}>NOT SIGNED OFF<span className="block text-[8px] font-normal">(revision {state.latest.worksheet_version} was signed; edited since)</span></strong>;
  return <strong style={{ color: COLOURS.red }}>NOT SIGNED OFF</strong>;
}
