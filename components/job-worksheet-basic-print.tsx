"use client";

import type { ReactNode } from "react";

import type { PackSheet } from "@/components/job-worksheet-pack-print";
import { PrintLogo } from "@/components/print-logo";
import { SignatureImage } from "@/components/signature-pad";
import { type CompanyProfile, useCompanyProfile } from "@/lib/company";
import { CUSTOMER_SIGNOFF_STATEMENT, type PrintedSignOff, customerLine, formatSignedAt, hashPrefix, kindLabel, legacySignOffText, useCustomerSignOffSetting, usePrintedSignOffs } from "@/lib/job-signoff";
import { fmtDate } from "@/lib/dates";
import { type JobWorksheet, signOffState } from "@/lib/job-worksheet";

/**
 * The Basic print layout (P1 print pack, D30-4; lib/print-layout): a plain job sheet for any company. The same data and loaders as the
 * JNR sheet (components/job-worksheet-print.tsx, components/job-worksheet-pack-print.tsx) and the same props; no JNR fields or
 * wording (no machines, part checklist or JNR instructions), no colour fills. A traceable job (082) also prints its material cert no.
 * and heat/cast no. in a small Traceability block; any other job does not. Sign-offs print exactly what
 * is recorded, with the same wording and data-signoff markers as the JNR sheet: never a sign-off it could not read.
 */

const font = { fontFamily: "Arial, Helvetica, sans-serif" };
const ruled = { backgroundImage: "repeating-linear-gradient(transparent, transparent 7mm, #999 7mm, #999 calc(7mm + 0.3mm))", WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as const;
const BLANK = " ";

function Header({ company, title, right }: { company: CompanyProfile | null; title: string; right: ReactNode }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-4 border-b-2 border-black pb-2">
      <div className="flex min-w-0 items-end gap-3">
        <PrintLogo company={company} className="h-12 w-auto max-w-[40mm] object-contain" />
        <div className="min-w-0">
          {company ? <p className="text-[15px] font-bold break-words">{company.documentName || company.name}</p> : null}
          <p className="text-[18px] font-bold tracking-wide">{title}</p>
        </div>
      </div>
      {right}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[9mm] border-b border-black">
      <div className="flex w-[38%] shrink-0 items-center border-r border-black px-2 text-[10px] font-bold uppercase">{label}</div>
      <div className="flex min-w-0 flex-1 items-center px-2 text-[12px] break-words">{value}</div>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <div className="border border-black px-2 py-1 text-[11px] font-bold uppercase">{children}</div>;
}

/** A labelled line to write on, filled when the value is known. */
function Slot({ label, children, width = "min-w-[45mm]" }: { label: string; children?: ReactNode; width?: string }) {
  return <span className="flex items-end gap-1.5"><strong className="text-[10px] uppercase">{label}:</strong><span className={`${width} border-b border-black px-1`}>{children ?? BLANK}</span></span>;
}

/** A pack row for the Basic pack: the JNR pack's row plus whether the job is traceable (jobs.traceable, 082). */
export type BasicPackSheet = PackSheet & { traceable?: boolean };

/** Traceable (082): marked traceable, or a material cert no. or heat/cast no. already recorded. */
export function isTraceable(ws: Pick<JobWorksheet, "material_cert_no" | "heat_cast_no">, traceable?: boolean) {
  return traceable === true || Boolean(ws.material_cert_no.trim() || ws.heat_cast_no.trim());
}

export function BasicWorksheetPrint({ worksheet: ws, jobNo, drawings = [], customerPos = [], traceable }: { worksheet: JobWorksheet; jobNo: string; drawings?: string[]; customerPos?: string[]; /** jobs.traceable (082). */ traceable?: boolean }) {
  const number = jobNo || ws.job_no;
  const signOff = usePrintedSignOffs([number])?.get(number) ?? null;
  const legacyBox = signOffState(ws);
  const legacyText = signOff ? legacySignOffText(signOff, legacyBox.status === "signed" ? legacyBox : null) : null;
  const customerOn = useCustomerSignOffSetting();
  const customers = signOff?.customer ?? [];
  const { profile: company } = useCompanyProfile();

  return (
    <div className="mx-auto w-[210mm] bg-white text-black print:w-full" style={font} data-print-layout="basic">
      <Header company={company} title="JOB SHEET" right={<p className="shrink-0 text-[13px] font-bold">Job no. <span className="ml-1 inline-block min-w-[40mm] border-b border-black px-1 text-center font-mono text-[14px]">{jobNo}</span></p>} />

      <div className="grid grid-cols-2 border border-b-0 border-black">
        <div className="border-r border-black">
          <Field label="Customer" value={ws.customer} />
          <Field label="Date received" value={fmtDate(ws.date_received)} />
          <Field label="Drawing no." value={ws.drawing_no} />
        </div>
        <div>
          <Field label="Customer PO" value={ws.customer_po} />
          <Field label="Date required" value={fmtDate(ws.date_required)} />
          <Field label="Quantity" value={ws.quantity_required} />
        </div>
      </div>

      {isTraceable(ws, traceable) ? (
        <div className="mt-2" data-traceability="">
          <Heading>Traceability</Heading>
          <div className="grid grid-cols-2 border border-t-0 border-b-0 border-black">
            <div className="border-r border-black"><Field label="Material cert no." value={ws.material_cert_no} /></div>
            <div><Field label="Heat/cast no." value={ws.heat_cast_no} /></div>
          </div>
        </div>
      ) : null}

      <div className="mt-2"><Heading>Description</Heading><div className="border border-t-0 border-black px-2 py-1 text-[12px] break-words whitespace-pre-wrap" style={{ minHeight: "24mm" }}>{ws.description}</div></div>

      {customerPos.length ? <p className="mt-1 text-[10px] break-words"><strong>Customer PO attached:</strong> {customerPos.join(", ")}</p> : null}
      {drawings.length ? <p className="mt-1 text-[10px] break-words"><strong>Drawings:</strong> {drawings.join(", ")}</p> : null}

      <div className="mt-2">
        <Heading>Operations</Heading>
        <table className="w-full table-fixed border-collapse text-[10px]">
          <thead>
            <tr>
              {[["No.", "8%"], ["Operation", "52%"], ["Done by", "16%"], ["Date", "12%"], ["Hours", "12%"]].map(([label, width]) => (
                <th key={label} className="border border-t-0 border-black px-1 py-0.5 text-left font-bold uppercase" style={{ width }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 8 }, (_, i) => (
              <tr key={i} className="h-[8mm]">{Array.from({ length: 5 }, (_, j) => <td key={j} className="border border-black px-1">{j === 0 ? i + 1 : BLANK}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2"><Heading>Notes</Heading><div className="border border-t-0 border-black" style={{ minHeight: "22mm", ...ruled }} /></div>

      <div className="mt-2 grid grid-cols-2 gap-2" style={{ breakInside: "avoid" }}>
        <div className="border border-black">
          <div className="border-b border-black px-2 py-1 text-[11px] font-bold uppercase">Checked by</div>
          <div className="space-y-2 px-2 py-2 text-[12px]">
            <Slot label="Name">{ws.checked_by || undefined}</Slot>
            <Slot label="Signature" />
            <Slot label="Date" width="min-w-[30mm]" />
          </div>
        </div>
        <div className="border border-black">
          <div className="border-b border-black px-2 py-1 text-[11px] font-bold uppercase">Signed off</div>
          <div className="space-y-2 px-2 py-2 text-[12px]">
            <span className="flex items-end gap-1.5">
              <strong className="text-[10px] uppercase">Name:</strong>
              <span className="min-w-[45mm] border-b border-black px-1" data-signoff={signOff === null ? "loading" : signOff.status === "signed" ? "signed" : legacyText ? "legacy" : "unsigned"}>
                {signOff?.status === "signed" ? `${signOff.latest.initials} ${signOff.latest.signer_name} (signed ${fmtDate(signOff.latest.signed_on)}, revision ${signOff.latest.worksheet_version}, sha256 ${hashPrefix(signOff.latest.snapshot_sha256)})` : null}
                {signOff?.status === "signed" ? signOff.cosigns.map((row) => (
                  <span key={row.id} className="block text-[10px]" data-signoff-cosign={row.kind}>{kindLabel(row.kind)} co-signature: {row.initials} {row.signer_name} (signed {fmtDate(row.signed_on)})</span>
                )) : null}
                {signOff?.status === "stale" ? <strong>NOT SIGNED OFF (revision {signOff.latest.worksheet_version} was signed; edited since)</strong> : null}
                {signOff?.status === "none" ? (legacyText ? <span className="text-[10px]">{legacyText}</span> : <strong>Not signed off</strong>) : null}
                {signOff === null ? BLANK : null}
              </span>
            </span>
            <Slot label="Signature">
              {signOff?.status === "signed" ? [signOff.latest, ...signOff.cosigns].map((row) => (
                <span key={row.id} className="inline-block align-bottom">{row.signature_kind === "drawn" ? <SignatureImage path={row.signature_data} className="h-[9mm] w-[27mm]" /> : <span className="font-serif italic">{row.signature_data}</span>}</span>
              )) : undefined}
            </Slot>
            <Slot label="Date" width="min-w-[30mm]">{signOff?.status === "signed" ? fmtDate(signOff.latest.signed_on) : undefined}</Slot>
          </div>
        </div>
      </div>

      {customers.length || customerOn ? (
        <div className="mt-2 border border-black" style={{ breakInside: "avoid" }} data-customer-signoff-print={customers.length ? "signed" : "blank"}>
          <div className="px-2 py-1 text-[11px] font-bold uppercase">Customer sign-off</div>
          {customers.length ? customers.map((row) => (
            <div key={row.id} className="flex items-end gap-3 border-t border-black px-2 py-1 text-[11px]">
              <div className="min-w-0 flex-1 break-words">
                <p><strong>{customerLine(row)}</strong></p>
                {row.statement ? <p className="italic">&ldquo;{row.statement}&rdquo;</p> : null}
                {row.customer_comment ? <p className="whitespace-pre-wrap">Comment: {row.customer_comment}</p> : null}
                <p className="text-[9px]">Signed {formatSignedAt(row.device_signed_at) || fmtDate(row.signed_on)} (phone time); received {formatSignedAt(row.created_at)}; revision {row.worksheet_version}, sha256 {hashPrefix(row.record_sha256)}</p>
              </div>
              <span className="shrink-0 border-b border-black px-1">{row.signature_kind === "drawn" ? <SignatureImage path={row.signature_data} className="h-[12mm] w-[40mm]" /> : <span className="font-serif text-[14px] italic">{row.signature_data}</span>}</span>
            </div>
          )) : (<>
            <p className="border-t border-black px-2 py-1 text-[11px] italic">{CUSTOMER_SIGNOFF_STATEMENT}</p>
            <div className="flex min-h-[12mm] items-end gap-3 px-2 py-1 text-[12px]">
              <Slot label="Name" width="min-w-[50mm]" /><Slot label="Signature" width="min-w-[50mm]" /><Slot label="Date" width="min-w-[25mm]" />
            </div>
          </>)}
        </div>
      ) : null}
    </div>
  );
}

export function BasicWorksheetPackPrint({ sheets }: { sheets: BasicPackSheet[] }) {
  const { profile: company } = useCompanyProfile();
  const signOffs = usePrintedSignOffs(sheets.map((sheet) => sheet.worksheet.job_no));
  const drawings = sheets.filter((sheet) => sheet.drawings.length);
  const th = "border border-black px-1 py-0.5 text-left align-bottom text-[9px] leading-tight font-bold uppercase";
  const td = "border border-black px-1 py-1 break-words";

  return (
    <div className="mx-auto w-[297mm] max-w-full bg-white text-black print:w-full" style={font} data-print-layout="basic">
      <Header company={company} title="JOB SHEETS" right={<p className="shrink-0 text-[12px] font-bold">Jobs <span className="ml-1 inline-block min-w-[20mm] border-b border-black px-1 text-center font-mono text-[13px]">{sheets.length}</span></p>} />

      <table className="w-full table-fixed border-collapse text-[10px] leading-snug">
        <thead>
          <tr>
            <th className={th} style={{ width: "10%" }}>Job no.</th>
            <th className={th} style={{ width: "13%" }}>Customer</th>
            <th className={th} style={{ width: "10%" }}>Customer PO</th>
            <th className={th} style={{ width: "24%" }}>Description</th>
            <th className={th} style={{ width: "10%" }}>Drawing no.</th>
            <th className={th} style={{ width: "6%" }}>Qty</th>
            <th className={th} style={{ width: "9%" }}>Received / Required</th>
            <th className={th} style={{ width: "18%" }}>Signed off</th>
          </tr>
        </thead>
        <tbody>
          {sheets.map(({ id, worksheet: ws, traceable }) => {
            const state = signOffs === null ? null : signOffs.get(ws.job_no) ?? { status: "none" as const };
            const legacy = packLegacyText(ws, signOffs);
            return (
              <tr key={id} className="align-top" style={{ breakInside: "avoid" }}>
                <td className={td}>
                  <p className="font-mono font-bold">{ws.job_no}</p>
                  {isTraceable(ws, traceable) ? <div className="mt-0.5 text-[8.5px]" data-traceability=""><p>Cert: {ws.material_cert_no}</p><p>Heat/cast: {ws.heat_cast_no}</p></div> : null}
                </td>
                <td className={td}>{ws.customer}</td>
                <td className={td}>{ws.customer_po}</td>
                <td className={`${td} whitespace-pre-wrap`}>{ws.description}</td>
                <td className={td}>{ws.drawing_no}</td>
                <td className={td}>{ws.quantity_required}</td>
                <td className={td}><p>{fmtDate(ws.date_received)}</p><p>{fmtDate(ws.date_required)}</p></td>
                <td className={td} data-signoff={signOffs === null ? "loading" : signOffs.get(ws.job_no)?.status === "signed" ? "signed" : legacy ? "legacy" : "unsigned"}><PackSignOff state={state} legacy={legacy} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {drawings.length ? <p className="mt-1 text-[9px] break-words"><strong>Drawings:</strong> {drawings.map((sheet) => `${sheet.worksheet.job_no}: ${sheet.drawings.join(", ")}`).join("; ")}</p> : null}

      <div className="mt-2"><Heading>Operations / notes</Heading><div className="border border-t-0 border-black" style={{ minHeight: "24mm", ...ruled }} /></div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]" style={{ breakInside: "avoid" }}>
        {["Checked by", "Signed off"].map((title) => (
          <div key={title} className="border border-black">
            <div className="border-b border-black px-2 py-0.5 text-[10px] font-bold uppercase">{title}</div>
            <div className="flex min-h-[9mm] flex-wrap items-end gap-3 px-2 py-1"><Slot label="Name" /><Slot label="Signature" /><Slot label="Date" width="min-w-[25mm]" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The old typed box (before migration 045), when the job has no hashed sign-off at all: an existing record, printed as what it is. */
function packLegacyText(ws: JobWorksheet, signOffs: Map<string, PrintedSignOff> | null) {
  const box = signOffState(ws);
  return signOffs === null ? null : legacySignOffText(signOffs.get(ws.job_no) ?? { status: "none" }, box.status === "signed" ? box : null);
}

/** The current revision's sign-off, worded as on the JNR pack; anything else prints as not signed off. */
function PackSignOff({ state, legacy }: { state: PrintedSignOff | null; legacy: string | null }) {
  if (state === null) return null;
  const customer = state.customer?.length ? <p className="text-[8.5px]" data-customer-signoff-print="signed">Customer: {state.customer.map((row) => `${customerLine(row)}, ${fmtDate(row.signed_on)}`).join("; ")}</p> : null;
  let internal: ReactNode;
  if (legacy) internal = <span className="text-[8.5px]">{legacy}</span>;
  else if (state.status === "signed") internal = <>{state.latest.initials} {state.latest.signer_name}<p className="text-[8.5px]">Signed {fmtDate(state.latest.signed_on)} (rev {state.latest.worksheet_version}, sha256 {hashPrefix(state.latest.snapshot_sha256)})</p>{state.cosigns.map((row) => <p key={row.id} className="text-[8.5px]" data-signoff-cosign={row.kind}>{kindLabel(row.kind)}: {row.initials} {row.signer_name}, {fmtDate(row.signed_on)}</p>)}</>;
  else if (state.status === "stale") internal = <strong>NOT SIGNED OFF<span className="block text-[8.5px] font-normal">(revision {state.latest.worksheet_version} was signed; edited since)</span></strong>;
  else internal = <strong>NOT SIGNED OFF</strong>;
  return <>{internal}{customer}</>;
}
