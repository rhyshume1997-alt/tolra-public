"use client";

/**
 * Module K (worksheet builder): the internal and customer sign-off blocks of a custom worksheet.
 *
 * Inputs: the job's printed sign-off state (lib/job-signoff PrintedSignOff, or null while loading), the legacy typed box, whether the
 * company's Customer sign-off switch is on. Outputs: the same wording and the same data-signoff / data-customer-signoff-print markers as the
 * Basic sheet (components/job-worksheet-basic-print.tsx), because these are the records people rely on. A sign-off prints exactly what is
 * recorded: a stale or missing one never prints as signed, and a recorded customer sign-off always prints.
 * Must not change: that wording and those markers. Basic and JNR do not use this file.
 */
import type { ReactNode } from "react";

import { SignatureImage } from "@/components/signature-pad";
import { fmtDate } from "@/lib/dates";
import { CUSTOMER_SIGNOFF_STATEMENT, type PrintedSignOff, customerLine, formatSignedAt, hashPrefix, kindLabel, legacySignOffText } from "@/lib/job-signoff";
import { type JobWorksheet, signOffState } from "@/lib/job-worksheet";

const BLANK = " ";

function Slot({ label, children, width = "min-w-[45mm]" }: { label: string; children?: ReactNode; width?: string }) {
  return <span className="flex items-end gap-1.5"><strong className="text-[10px] uppercase">{label}:</strong><span className={`${width} border-b border-black px-1`}>{children ?? BLANK}</span></span>;
}

export function InternalSignOffBlock({ heading, worksheet: ws, signOff, ink }: { heading: string; worksheet: JobWorksheet; signOff: PrintedSignOff | null; ink: string }) {
  const legacyBox = signOffState(ws);
  const legacyText = signOff ? legacySignOffText(signOff, legacyBox.status === "signed" ? legacyBox : null) : null;
  return (
    <div className="grid grid-cols-2 gap-2" style={{ breakInside: "avoid" }} data-worksheet-block="internalSignOff">
      <div className="border border-black">
        <div className="border-b border-black px-2 py-1 text-[11px] font-bold uppercase" style={{ color: ink }}>Checked by</div>
        <div className="space-y-2 px-2 py-2 text-[12px]">
          <Slot label="Name">{ws.checked_by || undefined}</Slot>
          <Slot label="Signature" />
          <Slot label="Date" width="min-w-[30mm]" />
        </div>
      </div>
      <div className="border border-black">
        <div className="border-b border-black px-2 py-1 text-[11px] font-bold uppercase" style={{ color: ink }}>{heading}</div>
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
  );
}

export function CustomerSignOffBlock({ heading, signOff, ink }: { heading: string; signOff: PrintedSignOff | null; ink: string }) {
  const customers = signOff?.customer ?? [];
  return (
    <div className="border border-black" style={{ breakInside: "avoid" }} data-worksheet-block="customerSignOff" data-customer-signoff-print={customers.length ? "signed" : "blank"}>
      <div className="px-2 py-1 text-[11px] font-bold uppercase" style={{ color: ink }}>{heading}</div>
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
  );
}
