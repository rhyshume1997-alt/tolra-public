"use client";

/**
 * The ISO templates page body (admin only, off by default). Inputs: the company's switch (organization_settings.hidden_nav marker),
 * the signed-in role, the company profile and the records read by lib/iso/load-iso-evidence. Outputs: the nine draft documents (each a
 * PDF), a zip of all nine plus the gap checklist PDF, the gap checklist (also CSV) and an internal reminder of NCRs open too long.
 * Must not change: it never writes anything, reads nothing while the switch is off, shows only to admin, and the reminder (its day
 * count is held in this component only, nothing saved) never feeds the gap checklist. Fail closed: a failed, partial or timed-out read shows the
 * incomplete warning and every export (each PDF, the checklist PDF and CSV, the zip) stays off until a full read succeeds for THIS company; a result
 * for another company or an older request is never shown or exported (lib/iso/iso-export-ready).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { IsoPackRedesign } from "@/components/iso/iso-pack-redesign";
import { useCompanyUiSwitch } from "@/lib/use-company-ui-switch";
import { IsoSwitchCard } from "@/components/iso/iso-switch-card";
import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadCompanyProfile, type CompanyProfile } from "@/lib/company";
import { fmtDate, toDateInput } from "@/lib/dates";
import { DEMO_MODE } from "@/lib/demo";
import { exportSpreadsheet } from "@/lib/export-records";
import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { fillDocument, TO_COMPLETE, type FillContext } from "@/lib/iso/fill";
import { buildGapChecklist, EMPTY_EVIDENCE, GAP_CSV_COLUMNS, gapStatusLabel } from "@/lib/iso/gap-checklist";
import { ISO_OFF_NOTICE, ISO_TEMPLATES_ON_MARKER, isoTemplatesEnabled } from "@/lib/iso/iso-switch";
import { isoReadIsComplete } from "@/lib/iso/iso-export-ready";
import type { IsoEvidence } from "@/lib/iso/load-iso-evidence";
import { failedIsoEvidence, ISO_LOAD_LIMIT_MS, loadIsoEvidenceSafe, settleWithin } from "@/lib/iso/load-iso-evidence-safe";
import { overdueNcrs, REVIEW_DAYS_DEFAULT, reviewDays } from "@/lib/iso/ncr-review-reminder";
import { useOrgSettings } from "@/lib/org-settings";
import { downloadFile } from "@/lib/spreadsheet";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useUser } from "@/lib/use-user";

type IsoLoadResult = { orgId: string; attempt: number; status: "ready" | "incomplete"; company: CompanyProfile | null; evidence: IsoEvidence };

export function IsoPackView() {
  return (
    <RoleGate allowed={["admin"]}>
      <IsoPackBody />
    </RoleGate>
  );
}

function IsoPackBody() {
  const redesign = useCompanyUiSwitch("ui-admin-iso-v2:on", ISO_TEMPLATES_ON_MARKER);
  const { hiddenNav, loaded } = useOrgSettings();
  const on = isoTemplatesEnabled(hiddenNav);
  const available = !DEMO_MODE && Boolean(supabase);
  const { profile: userProfile } = useUser();
  const orgId = userProfile?.organization_id ?? "";
  const [result, setResult] = useState<IsoLoadResult | null>(null);
  // Held in this component only: nothing is saved.
  const [daysText, setDaysText] = useState(String(REVIEW_DAYS_DEFAULT));
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${orgId}:${attempt}`;
  const latestRequest = useRef(requestKey);
  latestRequest.current = requestKey;

  useEffect(() => {
    if (!loaded || !on || !available || !orgId) return;
    const key = `${orgId}:${attempt}`;
    let cancelled = false;
    const stillCurrent = () => !cancelled && latestRequest.current === key;
    setResult(null);
    void (async () => {
      try {
        const before = await settleWithin(getCurrentOrganizationId(), ISO_LOAD_LIMIT_MS, null);
        if (before !== orgId) {
          if (stillCurrent()) setResult({ orgId, attempt, status: "incomplete", company: null, evidence: failedIsoEvidence() });
          return;
        }
        const [company, evidence] = await Promise.all([settleWithin(loadCompanyProfile(true), ISO_LOAD_LIMIT_MS, null), loadIsoEvidenceSafe()]);
        const after = await settleWithin(getCurrentOrganizationId(), ISO_LOAD_LIMIT_MS, null);
        if (!stillCurrent()) return;
        const complete = isoReadIsComplete(orgId, before, after, company, evidence);
        const same = before === orgId && after === orgId;
        setResult({ orgId, attempt, status: complete ? "ready" : "incomplete", company: same ? company : null, evidence: same ? evidence : failedIsoEvidence() });
      } catch {
        if (stillCurrent()) setResult({ orgId, attempt, status: "incomplete", company: null, evidence: failedIsoEvidence() });
      }
    })();
    return () => { cancelled = true; };
  }, [loaded, on, available, orgId, attempt]);

  const current = result && result.orgId === orgId && result.attempt === attempt ? result : null;
  const company = current?.company ?? null;
  const data = current?.evidence ?? null;
  const canExport = loaded && on && available && Boolean(orgId) && current?.status === "ready" && !busy;

  const ctx: FillContext = useMemo(() => ({ company, facts: data?.facts ?? null }), [company, data]);
  const gapRows = useMemo(() => buildGapChecklist(data?.evidence ?? EMPTY_EVIDENCE), [data]);
  const days = reviewDays(daysText);
  const overdue = useMemo(() => (data?.ncrRows ? overdueNcrs(data.ncrRows, new Date(), days) : []), [data, days]);

  if (!loaded) return <Skeleton className="h-80" />;
  if (!on) return <div className="space-y-4"><p className="text-sm text-slate-500">{ISO_OFF_NOTICE}</p><IsoSwitchCard /></div>;
  if (!available) return <p className="text-sm text-slate-500">The ISO templates are not available in this mode.</p>;

  const companyName = company?.name || company?.documentName || TO_COMPLETE;
  const stamp = toDateInput(new Date());

  async function build() {
    if (!canExport || latestRequest.current !== requestKey) throw new Error("ISO data is not ready.");
    const [{ pdf }, { IsoDocumentPDF }, { GapChecklistPDF }] = await Promise.all([import("@react-pdf/renderer"), import("@/components/iso/iso-document-pdf"), import("@/components/iso/gap-checklist-pdf")]);
    const toBytes = async (element: Parameters<typeof pdf>[0]) => new Uint8Array(await (await pdf(element).toBlob()).arrayBuffer());
    return {
      document: (id: string) => {
        const doc = ISO_DOCUMENTS.find((d) => d.id === id)!;
        return toBytes(<IsoDocumentPDF doc={fillDocument(doc, ctx)} logoSrc={company?.logoSrc} /> as never);
      },
      checklist: () => toBytes(<GapChecklistPDF rows={gapRows} companyName={companyName} logoSrc={company?.logoSrc} /> as never),
    };
  }

  async function downloadDocument(id: string) {
    if (!canExport || latestRequest.current !== requestKey) return;
    const downloadKey = requestKey;
    setBusy(true);
    try {
      const doc = ISO_DOCUMENTS.find((d) => d.id === id)!;
      const bytes = await (await build()).document(id);
      if (latestRequest.current === downloadKey) downloadFile(`${doc.filename}.pdf`, bytes as BlobPart, "application/pdf");
    } catch { if (latestRequest.current === downloadKey) toast.error("Couldn't make the PDF. Try again."); } finally { setBusy(false); }
  }

  async function downloadChecklist() {
    if (!canExport || latestRequest.current !== requestKey) return;
    const downloadKey = requestKey;
    setBusy(true);
    try {
      const bytes = await (await build()).checklist();
      if (latestRequest.current === downloadKey) downloadFile("10-gap-checklist.pdf", bytes as BlobPart, "application/pdf");
    } catch { if (latestRequest.current === downloadKey) toast.error("Couldn't make the PDF. Try again."); } finally { setBusy(false); }
  }

  async function downloadPack() {
    if (!canExport || latestRequest.current !== requestKey) return;
    const downloadKey = requestKey;
    setBusy(true);
    try {
      const make = await build();
      const { zipSync } = await import("fflate");
      const files: Record<string, Uint8Array> = {};
      for (const d of ISO_DOCUMENTS) files[`${d.filename}.pdf`] = await make.document(d.id);
      files["10-gap-checklist.pdf"] = await make.checklist();
      if (latestRequest.current === downloadKey) downloadFile(`iso-draft-templates-${stamp}.zip`, zipSync(files) as BlobPart, "application/zip");
    } catch { if (latestRequest.current === downloadKey) toast.error("Couldn't make the zip. Try again."); } finally { setBusy(false); }
  }

  const contents = (
    <>
          {current?.status === "incomplete" ? (
            <div role="alert" data-testid="iso-incomplete" className="space-y-2 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              <p className="font-semibold">ISO information is incomplete</p>
              <p>Some records couldn&apos;t be confirmed, so downloads are disabled until the required reads succeed.</p>
              {data?.unread.length ? <p>Some records could not be read ({data.unread.join(", ")}). Those clauses show as not evidenced.</p> : null}
              <Button variant="outline" size="sm" className="min-h-11" disabled={busy} onClick={() => setAttempt((n) => n + 1)}>Try reading again</Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button className="min-h-11" disabled={!canExport} onClick={() => void downloadPack()}>Download pack (zip)</Button>
            <span className="text-xs text-slate-500">All nine documents and the gap checklist, as PDFs.</span>
          </div>
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Documents</h2>
            <Table>
              <TableHeader><TableRow><TableHead>Document</TableHead><TableHead>Clause</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {ISO_DOCUMENTS.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{d.title}</TableCell>
                    <TableCell>{d.clause}</TableCell>
                    <TableCell><Button variant="outline" className="min-h-11" disabled={!canExport} onClick={() => void downloadDocument(d.id)} aria-label={`Download PDF: ${d.title}`}>Download PDF</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Gap checklist</h2>
              <div className="flex gap-2">
                <Button variant="outline" className="min-h-11" disabled={!canExport} onClick={() => void downloadChecklist()}>Download checklist (PDF)</Button>
                {/* No audit entry: the checklist is not one of the audited record types (lib/audit-contract.ts). */}
                <Button variant="outline" className="min-h-11" disabled={!canExport} onClick={() => { if (canExport) void exportSpreadsheet("csv", "iso-gap-checklist", GAP_CSV_COLUMNS, gapRows); }}>Download checklist (CSV)</Button>
              </div>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>Clause</TableHead><TableHead>Requirement</TableHead><TableHead>Status</TableHead><TableHead>Basis</TableHead></TableRow></TableHeader>
              <TableBody>
                {gapRows.map((r) => <TableRow key={r.clause}><TableCell>{r.clause}</TableCell><TableCell>{r.requirement}</TableCell><TableCell className="font-medium">{gapStatusLabel(r.status)}</TableCell><TableCell className="text-sm text-slate-600">{r.basis}</TableCell></TableRow>)}
              </TableBody>
            </Table>
          </section>
          <section className="space-y-2">
            <h2 className="text-base font-semibold">NCR review reminder</h2>
            <p className="text-xs text-slate-500">An internal reminder only. It does not change the gap checklist.</p>
            <label className="block text-sm">Remind after (days open, this visit only)
              <Input className="mt-1 w-32" inputMode="numeric" value={daysText} onChange={(e) => setDaysText(e.target.value)} />
            </label>
            {!data?.ncrRows ? <p className="text-sm text-slate-500">Nonconformance records could not be read.</p>
              : !overdue.length ? <p className="text-sm text-slate-500">No confirmed NCR has been open for more than {days} days.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Record</TableHead><TableHead>Raised</TableHead><TableHead>Days open</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {overdue.map((o) => <TableRow key={o.row.key}><TableCell>{o.row.record}</TableCell><TableCell>{fmtDate(o.row.raisedAt)}</TableCell><TableCell>{o.daysOpen}</TableCell><TableCell>{o.row.reason}</TableCell></TableRow>)}
                  </TableBody>
                </Table>
              )}
          </section>
        </>
  );
  if (redesign) {
    return (
      <IsoPackRedesign companyName={companyName} switching={<IsoSwitchCard />} ready={current !== null}>
        {contents}
      </IsoPackRedesign>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">ISO templates</h1>
        <p className="mt-2 text-sm text-slate-500">Branded draft templates and a self-check list for {companyName}. Template and self-check aid. Needs company review. Not certification evidence.</p>
      </div>
      <IsoSwitchCard />
      {current === null ? <Skeleton className="h-80" /> : (
        contents
      )}
    </div>
  );
}
