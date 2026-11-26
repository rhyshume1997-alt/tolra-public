"use client";

/**
 * BOUNDARY (module 9, ISO templates; owner-approved exception to "no saved documents / no SQL", 26 Nov, database proposal p171). The editor for ONE of the nine ISO
 * documents (/admin/iso/[doc]). Inputs: the document id, the company switch (iso-templates marker), the signed-in role, the company profile, the facts read by
 * lib/iso/load-iso-evidence and the saved versions (lib/iso/iso-document-versions.ts). Outputs: edit (plain text per section, gaps highlighted), save as a NEW version,
 * history with a read-only view and "restore as new version", approve (typed name, date = now), and a PDF of the latest APPROVED version (else the latest saved draft,
 * else today's generated draft).
 * Must not change: admin only; shows nothing and reads nothing while the switch is off; it never edits or deletes a version (every save is a new one); an approved version
 * is locked; when the saved versions cannot be read (table or function not applied yet, no access, timeout) it shows today's generated draft read-only with "Editing is not
 * available yet" and never an error loop; the page keeps "template and self-check aid, not certification evidence". No business rules here: they live in lib/iso/*.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { isoDocumentPdfBytes } from "@/components/iso/iso-pdf-build";
import { IsoBodyReadOnly, IsoSectionFields } from "@/components/iso/iso-section-fields";
import { IsoSwitchCard } from "@/components/iso/iso-switch-card";
import { IsoVersionHistory } from "@/components/iso/iso-version-history";
import { RoleGate } from "@/components/role-gate";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, Callout, Dialog, EmptyState, Field, FailedState, Input, LoadingState, PageHeader, StatusBadge, TabPanel, Tabs, premiumTokens } from "@/components/ui/premium";
import { loadCompanyProfile, useCompanyProfile, type CompanyProfile } from "@/lib/company";
import { fmtDate, toDateInput } from "@/lib/dates";
import { DEMO_MODE } from "@/lib/demo";
import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import {
  bodyFromFilled, countGaps, editorStart, effectiveDocument, isLocked, latestSaved, printChoiceLabel, sameBody, validateApproverName, validateBody, validateChangeNote,
  versionsOf, whichVersionPrints, type IsoBody, type IsoVersion, type IsoVersionMeta,
} from "@/lib/iso/editable-document";
import { approveIsoVersion, loadIsoVersion, loadIsoVersionMetas, saveIsoVersion } from "@/lib/iso/iso-document-versions";
import { fillDocument } from "@/lib/iso/fill";
import { ISO_OFF_NOTICE, isoTemplatesEnabled } from "@/lib/iso/iso-switch";
import { ISO_LOAD_LIMIT_MS, loadIsoEvidenceSafe, settleWithin } from "@/lib/iso/load-iso-evidence-safe";
import { useOrgSettings } from "@/lib/org-settings";
import { downloadFile } from "@/lib/spreadsheet";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";
import type { IsoFacts } from "@/lib/iso/fill";

export function IsoDocumentEditor({ docId }: { docId: string }) {
  return (
    <RoleGate allowed={["admin"]}>
      <EditorBody docId={docId} />
    </RoleGate>
  );
}

type Loaded = { company: CompanyProfile | null; facts: IsoFacts | null; metas: IsoVersionMeta[] | null; latest: IsoVersion | null };

function EditorBody({ docId }: { docId: string }) {
  const { hiddenNav, loaded } = useOrgSettings();
  const on = isoTemplatesEnabled(hiddenNav);
  const available = !DEMO_MODE && Boolean(supabase);
  const doc = ISO_DOCUMENTS.find((d) => d.id === docId) ?? null;
  const { profile: sharedCompany } = useCompanyProfile();
  const { profile: me } = useUser();
  const [state, setState] = useState<"idle" | "loading" | "ready">("idle");
  const [data, setData] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<"edit" | "history">("edit");
  const [draft, setDraft] = useState<IsoBody | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<IsoVersionMeta | null>(null);
  const [approverName, setApproverName] = useState("");
  const [dialogError, setDialogError] = useState("");

  useEffect(() => {
    if (!loaded || !on || !available || !doc) return;
    let cancelled = false;
    setState("loading");
    void (async () => {
      const [company, evidence, metas] = await Promise.all([settleWithin(loadCompanyProfile(), ISO_LOAD_LIMIT_MS, null), loadIsoEvidenceSafe(), loadIsoVersionMetas()]);
      const mine = metas.ok ? versionsOf(metas.versions, doc.id) : null;
      const top = mine ? latestSaved(mine) : null;
      const latest = top ? await loadIsoVersion(doc.id, top.version) : null;
      if (cancelled) return;
      setData({ company, facts: evidence.facts, metas: mine, latest: latest?.ok ? latest.version : null });
      setDraft(null);
      setNote("");
      setState("ready");
    })();
    return () => { cancelled = true; };
  }, [loaded, on, available, doc, attempt]);

  const company = data?.company ?? sharedCompany;
  const generated = useMemo(() => (doc ? fillDocument(doc, { company, facts: data?.facts ?? null }) : null), [doc, company, data]);
  const tables = useCallback((heading: string) => Boolean(generated?.sections.find((s) => s.heading === heading)?.blankTable), [generated]);

  if (!loaded) return <Skeleton className="h-80" />;
  if (!on) return <div className="space-y-4"><p className="text-sm text-slate-500">{ISO_OFF_NOTICE}</p><IsoSwitchCard /></div>;
  if (!available) return <p className="text-sm text-slate-500">The ISO templates are not available in this mode.</p>;
  if (!doc || !generated) {
    return <div className={`${premiumTokens} space-y-4`}><EmptyState title="Document not found" detail="That is not one of the nine ISO documents." action={<Link className="text-sm font-medium underline" href="/admin/iso">Back to ISO templates</Link>} /></div>;
  }

  const metas = data?.metas ?? null;          // null: the saved versions could not be read
  const editable = metas !== null;
  const generatedBody = bodyFromFilled(generated);
  const latestVersion = data?.latest ?? null;
  const start = editable ? editorStart(latestVersion ? [latestVersion] : [], generatedBody) : null;
  const working = draft ?? start?.body ?? generatedBody;
  const dirty = Boolean(start) && !sameBody(working, start!.body);
  const baseVersion = metas && metas.length ? metas[0].version : 0;
  const latestMeta = metas && metas.length ? metas[0] : null;
  const choice = metas ? whichVersionPrints(metas) : { kind: "generated" as const, version: null };
  const gaps = countGaps(working);
  const lockedStart = Boolean(latestMeta && isLocked(latestMeta));

  async function reload() { setAttempt((n) => n + 1); }

  async function save(restoredFrom: number | null, body: IsoBody, savedNote: string) {
    const problem = validateBody(body) ?? validateChangeNote(savedNote);
    if (problem) { toast.error(problem); return false; }
    setBusy(true);
    const result = await saveIsoVersion({ docId: doc!.id, body, note: savedNote, baseVersion, restoredFrom });
    setBusy(false);
    if (!result.ok) { toast.error(result.message); return false; }
    toast.success(`Saved as version ${result.version}.`);
    await reload();
    return true;
  }

  async function download() {
    setBusy(true);
    try {
      let chosen: { kind: "approved" | "draft"; version: IsoVersion } | null = null;
      if (choice.kind !== "generated") {
        const v = latestVersion && latestVersion.version === choice.version.version ? latestVersion : await loadIsoVersion(doc!.id, choice.version.version).then((r) => (r.ok ? r.version : null));
        if (!v) throw new Error("version unreadable");
        chosen = { kind: choice.kind, version: v };
      }
      downloadFile(`${doc!.filename}.pdf`, (await isoDocumentPdfBytes(effectiveDocument(generated!, chosen), company?.logoSrc)) as BlobPart, "application/pdf");
    } catch { toast.error("Couldn't make the PDF. Try again."); }
    setBusy(false);
  }

  async function confirmApprove() {
    if (!approving) return;
    const problem = validateApproverName(approverName);
    if (problem) { setDialogError(problem); return; }
    setBusy(true);
    const result = await approveIsoVersion({ docId: doc!.id, version: approving.version, approverName });
    setBusy(false);
    if (!result.ok) { setDialogError(result.message); return; }
    toast.success(`Version ${result.version} approved.`);
    setApproving(null);
    setDialogError("");
    await reload();
  }

  function openApprove(v: IsoVersionMeta) {
    setApproverName(me?.full_name?.trim() ?? "");
    setDialogError("");
    setApproving(v);
  }

  const status = (
    <StatusBadge tone={choice.kind === "approved" ? "ok" : "neutral"}>{`PDF prints: ${printChoiceLabel(choice)}`}</StatusBadge>
  );
  const header = (
    <PageHeader title={doc.title} description={`ISO 9001:2015 clause ${doc.clause}. The company's own record. Template and self-check aid. Needs company review. Not certification evidence.`}
      actions={<Link href="/admin/iso" className="inline-flex min-h-12 items-center text-sm font-medium underline">Back to ISO templates</Link>} />
  );

  if (state !== "ready") return <div className={`${premiumTokens} space-y-4`}>{header}<LoadingState label={`Loading ${doc.title}`} /></div>;

  // Versions exist but the newest one's text could not be read: never start from the generated draft over it.
  if (metas && metas.length > 0 && !latestVersion) {
    return <div className={`${premiumTokens} space-y-4`}>{header}<FailedState title="Couldn't load the latest saved version" detail="Nothing was changed. Try again." onRetry={() => void reload()} retryLabel="Try again" /></div>;
  }

  if (!editable) {
    return (
      <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="iso-editor-unavailable">
        {header}
        <Callout tone="info" lead="Editing is not available yet" role="status">Today&apos;s generated draft is shown below and can still be downloaded. Saving and approving will appear here once editing is switched on for your company.</Callout>
        <div className="flex flex-wrap gap-3">
          <Button size="lg" variant="primary" loading={busy} onClick={() => void download()}>Download PDF</Button>
          <Button size="lg" variant="secondary" onClick={() => void reload()}>Check again</Button>
        </div>
        <IsoBodyReadOnly body={generatedBody} hasTable={tables} />
      </div>
    );
  }

  return (
    <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="iso-editor">
      {header}
      <div className="flex flex-wrap items-center gap-3">{status}{latestMeta ? <span className="text-sm text-slate-600">{`Latest saved: version ${latestMeta.version}${latestMeta.status === "approved" ? " (approved)" : " (draft)"}`}</span> : <span className="text-sm text-slate-600">Nothing saved yet. You are looking at today&apos;s generated draft.</span>}</div>
      <Tabs label="Document views" value={tab} onChange={setTab} tabs={[{ value: "edit", label: "Edit", id: "iso-tab-edit" }, { value: "history", label: "History", id: "iso-tab-history", count: metas.length }]} />
      <TabPanel id="iso-panel-edit" tabId="iso-tab-edit" hidden={tab !== "edit"}>
        <div className="space-y-4 pt-2">
          {lockedStart ? <Callout tone="info" lead="Approved">Version {latestMeta!.version} is approved by {latestMeta!.approved_by_name ?? "unknown"} on {latestMeta!.approved_at ? fmtDate(latestMeta!.approved_at) : "an unknown date"} and is locked. Saving your changes starts a new draft version; the approved one stays as it is.</Callout> : null}
          {gaps > 0 ? <Callout tone="warn" lead="To complete">{gaps === 1 ? "1 gap" : `${gaps} gaps`} left in this document. A gap prints as "[to complete]".</Callout> : <Callout tone="neutral" lead="">No gaps left in this text.</Callout>}
          <IsoSectionFields body={working} tables={tables} disabled={busy} onChange={setDraft} />
          <Field label="Change note" optional hint="A short reason for this version, shown in the history."><Input value={note} maxLength={500} disabled={busy} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" variant="primary" loading={busy} disabled={start!.from === "saved" && !dirty} onClick={() => void save(null, working, note)}>Save as new version</Button>
            <Button size="lg" variant="secondary" disabled={busy || dirty || !latestMeta || latestMeta.status === "approved"} onClick={() => latestMeta && openApprove(latestMeta)}>Approve latest saved version</Button>
            <Button size="lg" variant="secondary" disabled={busy} onClick={() => void download()}>Download PDF</Button>
          </div>
          <p className="text-xs text-slate-500">{dirty ? "You have unsaved changes: save them before approving. The PDF uses saved text only." : "The PDF uses the latest approved version; if none is approved, the latest saved draft."}</p>
        </div>
      </TabPanel>
      <TabPanel id="iso-panel-history" tabId="iso-tab-history" hidden={tab !== "history"}>
        <div className="pt-2">
          <IsoVersionHistory docTitle={doc.title} versions={metas} tables={tables} busy={busy} onApprove={openApprove}
            onRestore={(v) => { void save(v.version, v.body, `Restored from version ${v.version}`).then((ok) => { if (ok) setTab("edit"); }); }} />
        </div>
      </TabPanel>
      <Dialog open={approving !== null} title={approving ? `Approve version ${approving.version}?` : "Approve"} confirmLabel="Approve version" busy={busy} error={dialogError}
        confirmDisabled={!approverName.trim()} onConfirm={() => void confirmApprove()} onClose={() => { if (!busy) { setApproving(null); setDialogError(""); } }}
        description={`Approving locks this version: it cannot be edited, and the PDF will print it. Date approved: ${fmtDate(toDateInput(new Date()))} (recorded when you confirm).${approving && gaps > 0 && approving.version === latestMeta?.version ? `\nThis text still has gaps ("[to complete]").` : ""}`}>
        <Field label="Approver name" required hint="Type or confirm the name of the person approving."><Input value={approverName} maxLength={200} autoComplete="name" onChange={(e) => setApproverName(e.target.value)} /></Field>
      </Dialog>
    </div>
  );
}
