"use client";

/**
 * Module J: Settings > Document designs (admins). Pick one design for each of quotes, invoices, purchase orders and delivery notes, see it
 * live on sample data, and save. Also the place the new-company setup's "Logo and colours" step points to (#setup-designs).
 * Inputs: the signed-in company's profile (logo, brand colour) and stored choices. Outputs: a saved change to company_profile.documentTemplates only.
 * OFF by default: nothing changes on any document until an admin switches "Use these designs" on. Documents already issued keep the design in
 * force when they were issued (lib/document-templates). Must not change: it must not touch any other setting or any document.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LayoutTemplate } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auditEvent } from "@/lib/audit";
import { type CompanyProfile, loadCompanyProfile } from "@/lib/company";
import {
  currentDesignId, DEFAULT_DESIGN_ID, DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES, type DocumentTemplateSettings, type DocumentType,
  setDesignChoice, withBrandColour, withTemplatesEnabled,
} from "@/lib/document-templates/document-template-settings";
import { loadDocumentTemplates, saveDocumentTemplates } from "@/lib/document-templates/document-template-store";
import { sampleDocument } from "@/lib/document-templates/sample-documents";
import { friendlyError } from "@/lib/friendly-error";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

type Design = { id: string; label: string; description: string };

/** Builds the sample PDF of one type in one design. The PDF code and the design list load here, not with the Settings page. */
async function sampleBlob(type: DocumentType, company: CompanyProfile, design: string): Promise<Blob> {
  const [{ pdf }, { createElement }, sample] = await Promise.all([import("@react-pdf/renderer"), import("react"), Promise.resolve(sampleDocument(type, company, design))]);
  const [{ QuotePDF }, { InvoicePDF }, { PurchaseOrderPDF }, { DeliveryNotePDF }] = await Promise.all([
    import("@/components/pdf/QuotePDF"), import("@/components/pdf/InvoicePDF"), import("@/components/pdf/PurchaseOrderPDF"), import("@/components/pdf/DeliveryNotePDF"),
  ]);
  const element =
    sample.type === "quote" ? createElement(QuotePDF, { data: sample.data })
    : sample.type === "invoice" ? createElement(InvoicePDF, { data: sample.data })
    : sample.type === "purchase_order" ? createElement(PurchaseOrderPDF, { data: sample.data })
    : createElement(DeliveryNotePDF, { data: sample.data });
  return pdf(element as never).toBlob();
}

export function DocumentDesignsCard() {
  const [settings, setSettings] = useState<DocumentTemplateSettings | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [type, setType] = useState<DocumentType>("quote");
  const [picked, setPicked] = useState<Partial<Record<DocumentType, string>>>({});
  const [saving, setSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([loadDocumentTemplates(), loadCompanyProfile(), import("@/components/pdf/templates/registry")]).then(([stored, profile, registry]) => {
      if (!active) return;
      setSettings(stored);
      setCompany(profile);
      setDesigns(registry.DOCUMENT_DESIGNS.map(({ id, label, description }) => ({ id, label, description })));
    });
    return () => { active = false; };
  }, []);

  const saved = currentDesignId(settings, type);
  const selected = picked[type] ?? saved;
  const colour = settings?.colour === true;

  useEffect(() => {
    if (!company) return;
    let active = true;
    setPreviewError(false);
    // The preview follows the saved colour choice, so ticking the box shows the brand colour straight away.
    void sampleBlob(type, { ...company, documentTemplates: { enabled: true, colour: colour || undefined } }, selected).then(
      (blob) => {
        if (!active) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPreviewUrl(url);
      },
      () => { if (active) setPreviewError(true); },
    );
    return () => { active = false; };
  }, [company, type, selected, colour]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const persist = useCallback(async (change: (current: DocumentTemplateSettings) => DocumentTemplateSettings, what: string) => {
    setSaving(true);
    try {
      const before = settings;
      const next = await saveDocumentTemplates(await getCurrentOrganizationId(), change);
      setSettings(next);
      void loadCompanyProfile(true); // documents made next read the new choice
      void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", oldData: { documentTemplates: before }, newData: { documentTemplates: next }, metadata: { section: "document_templates", change: what } });
      toast.success("Document designs saved");
      return true;
    } catch (error) {
      toast.error(friendlyError(error, "Couldn't save the document designs. Try again."));
      return false;
    } finally {
      setSaving(false);
    }
  }, [settings]);

  async function savePick() {
    if (await persist((current) => setDesignChoice(current, type, selected), `${type}:${selected}`)) setPicked((p) => ({ ...p, [type]: undefined }));
  }

  return (
    <Card id="setup-designs">
      <CardHeader><CardTitle className="flex items-center gap-2"><LayoutTemplate className="size-5" aria-hidden /> Document designs</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-slate-600">Choose how your quotes, invoices, purchase orders and delivery notes look. Every design uses your logo and brand colour from Company details, and the same figures, VAT, totals, bank details and numbering. Documents already issued keep the design they were issued with; only new documents use a new choice.</p>
        {!settings ? <p>Loading…</p> : (
          <>
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={settings.enabled} disabled={saving} onChange={(e) => void persist((current) => withTemplatesEnabled(current, e.target.checked), e.target.checked ? "on" : "off")} />
              Use these designs on my documents
            </label>
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={colour} disabled={saving} onChange={(e) => void persist((current) => withBrandColour(current, e.target.checked), e.target.checked ? "colour on" : "colour off")} />
              Use my brand colours on the Modern and Minimal designs
            </label>
            <p className="text-slate-500">{colour ? "Modern and Minimal use the brand colour from Company details (a neutral navy if none is set)." : "Off: every design prints in black and white. Classic is always black and white."}</p>
            {!settings.enabled ? <p className="text-slate-500">Switched off: every document prints the {DEFAULT_DESIGN_ID} design, as it always has. You can still try the designs below.</p> : null}
            <div role="tablist" aria-label="Document type" className="flex flex-wrap gap-2">
              {DOCUMENT_TYPES.map((t) => (
                <Button key={t} role="tab" aria-selected={t === type} variant={t === type ? "default" : "outline"} size="sm" onClick={() => setType(t)}>{DOCUMENT_TYPE_LABELS[t]}</Button>
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
              <fieldset className="space-y-2">
                <legend className="sr-only">Design for {DOCUMENT_TYPE_LABELS[type]}</legend>
                {designs.map((design) => (
                  <label key={design.id} className={`block rounded border p-3 ${selected === design.id ? "border-slate-900" : "border-slate-200"}`}>
                    <span className="flex items-center gap-2 font-medium"><input type="radio" name={`design-${type}`} checked={selected === design.id} onChange={() => setPicked((p) => ({ ...p, [type]: design.id }))} />{design.label}{saved === design.id ? <span className="text-xs font-normal text-slate-500">(current)</span> : null}</span>
                    <span className="mt-1 block text-slate-600">{design.description}</span>
                  </label>
                ))}
                <Button disabled={saving || selected === saved} onClick={() => void savePick()}>Save design for {DOCUMENT_TYPE_LABELS[type].toLowerCase()}</Button>
              </fieldset>
              <div className="min-h-[480px] rounded border bg-slate-50">
                {previewError ? <p className="p-4 text-slate-600">The preview couldn&apos;t load. Check your connection and try again.</p>
                  : previewUrl ? <iframe title={`Preview of ${DOCUMENT_TYPE_LABELS[type]} in the ${selected} design`} src={previewUrl} className="h-[560px] w-full rounded" />
                  : <p className="p-4 text-slate-600">Loading preview…</p>}
              </div>
            </div>
            <p className="text-xs text-slate-500">The preview uses made-up sample data with your own logo, brand colour, terms and bank details.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
