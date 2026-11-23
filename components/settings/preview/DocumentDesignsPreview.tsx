"use client";

/**
 * BOUNDARY (PREVIEW ONLY). OWNERSHIP ASSUMPTION, TO BE CONFIRMED BY THE OWNER: Settings is treated as Module 1 for the previews, as in SettingsPreview; the real Document designs section is
 * Module J (components/document-templates/document-designs-section.tsx and document-designs-card.tsx, read only). This is the redesign (execution only) of that section, new files only.
 * Inputs: none from the server. One made-up company ("Fernhill Engineering Ltd", addresses on reserved ".example" domains, a navy monogram drawn on a canvas as its logo) held in this file, plus clicks.
 * Outputs: the same card the real page shows: a closed card until opened (or until the page is reached on #setup-designs), then the lead sentence, the two switches (both off by default, with the real
 * explanations), one tab per document type (Quotes, Invoices, Purchase orders, Delivery notes), the design picker (one radio card per design in the real registry, "(current)" on the saved one), Save design
 * for <type>, and the LIVE PDF PREVIEW. The preview is built exactly as the real card builds it: the real pure sampleDocument() (lib/document-templates/sample-documents) gives made-up data, the real
 * QuotePDF / InvoicePDF / PurchaseOrderPDF / DeliveryNotePDF components with the real design registry draw it, @react-pdf/renderer pdf().toBlob() turns it into a Blob in the browser, and the Blob is
 * shown in an <iframe src="blob:...">. No network, no storage, no auth, no Supabase. The frame is sized by aspect-ratio (A4) to the container width, so nothing scrolls sideways at any width.
 * Nothing is saved: Save and both switches answer with the neutral "Preview only ... Nothing was saved." toast; the switches and the picked design are LOCAL draft state (so the preview can follow
 * them, as on the real page), the "(current)" design never moves, and "Reset preview" in Preview controls puts everything back. Admin only, as the real Settings page (RoleGate and middleware).
 * Exports: DocumentDesignsPanel (the card, for mounting inside the Settings preview at #setup-designs) and the default export (the standalone page with its own PreviewBar and toast layer).
 * MUST NOT CHANGE: wording, controls, defaults (switches off, classic everywhere), the preview technique and the admin-only rule mirror the real card; do not wire this to real data, a session or an
 * action, do not add a control the real card lacks (the real page has no open-in-new-tab link, so there is none here), keep every control at a 48 px hit area and nothing scrolling sideways. Delete the
 * four preview files (this component and its .module.css, app/(dashboard)/settings/documents-preview/page.tsx, tests/unit/documentDesignsPreview.test.ts) to remove it completely.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Button, LoadingState, PageHeader, Panel, Popover, PreviewBar, SegmentedControl, Select, Switch, ToastProvider, cx, premiumTokens, useToast,
} from "@/components/ui/premium";
import { JNR_PROFILE, type CompanyProfile } from "@/lib/company";
import {
  currentDesignId, DEFAULT_DESIGN_ID, DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES, parseDocumentTemplates, setDesignChoice, withBrandColour, withTemplatesEnabled,
  type DocumentTemplateSettings, type DocumentType,
} from "@/lib/document-templates/document-template-settings";
import { sampleDocument } from "@/lib/document-templates/sample-documents";
import { PRODUCT } from "@/lib/product";

import s from "./DocumentDesignsPreview.module.css";

/* ------------------------------------------------------------------ words (pinned to the real card by tests/unit/documentDesignsPreview.test.ts) ------------------------------------------------------------------ */

export const PREVIEW_TAG = "Preview, sample data, nothing is saved";
/** The one sentence that ends every toast: no action here ever persists anything. */
export const NOT_SAVED = "Nothing was saved.";
export const DOCUMENT_DESIGNS_HASH = "#setup-designs";
export const CLOSED_LEAD = "Choose how your quotes, invoices, purchase orders and delivery notes look, with a live preview. Off until you switch it on.";
export const CARD_LEAD = "Choose how your quotes, invoices, purchase orders and delivery notes look. Every design uses your logo and brand colour from Company details, and the same figures, VAT, totals, bank details and numbering. Documents already issued keep the design they were issued with; only new documents use a new choice.";
export const ENABLED_LABEL = "Use these designs on my documents";
export const COLOUR_LABEL = "Use my brand colours on the Modern and Minimal designs";
export const COLOUR_ON_NOTE = "Modern and Minimal use the brand colour from Company details (a neutral navy if none is set).";
export const COLOUR_OFF_NOTE = "Off: every design prints in black and white. Classic is always black and white.";
export const SWITCHED_OFF_NOTE = `Switched off: every document prints the ${DEFAULT_DESIGN_ID} design, as it always has. You can still try the designs below.`;
export const PREVIEW_FAILED = "The preview couldn't load. Check your connection and try again.";
export const PREVIEW_LOADING = "Loading preview…";
export const SAMPLE_NOTE = "The preview uses made-up sample data with your own logo, brand colour, terms and bank details.";

/** The real page is wrapped in <RoleGate allowed={["admin"]}> (and middleware.ts: ["/settings", ["admin"]]). */
export type Role = "admin" | "office" | "workshop" | "viewer";
export const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" },
];
export const canUseSettings = (role: Role) => role === "admin";

export type Design = { id: string; label: string; description: string };
export type DesignsStates = { data: "ready" | "loading"; preview: "live" | "loading" | "failed"; saved: "default" | "chosen" };
export const INITIAL_STATES: DesignsStates = { data: "ready", preview: "live", saved: "default" };

/** The stored choices the card starts from. "default" is a company that never chose (off, classic everywhere); "chosen" has Modern for quotes and Minimal for invoices, so "(current)" has something to show. */
export function seedSettings(kind: DesignsStates["saved"]): DocumentTemplateSettings {
  if (kind === "default") return parseDocumentTemplates({ enabled: false });
  return setDesignChoice(setDesignChoice(parseDocumentTemplates({ enabled: true }), "quote", "modern", new Date("2026-10-01T09:00:00Z")), "invoice", "minimal", new Date("2026-10-01T09:05:00Z"));
}

/** The made-up company the sample documents print: a real CompanyProfile, so the real PDF components take it unchanged. */
export function sampleCompany(logoSrc?: string): CompanyProfile {
  return {
    ...JNR_PROFILE,
    key: "fernhill",
    name: "Fernhill Engineering",
    documentName: "Fernhill Engineering Ltd",
    addressLines: ["Unit 4, Brookside Works", "Fernhill Industrial Estate", "Hamilton", "ML3 6AB"],
    phone: "01632 960123",
    fax: "",
    email: "office@fernhill.example",
    website: "www.fernhill.example",
    vatNumber: "GB000000000",
    brandPrimary: "#1e3472",
    brandAccent: "#2e52b8",
    defaultQuoteTerms: "Valid for 30 days",
    defaultInvoiceTerms: "30 days",
    defaultCustomerMessage: ["Thank you for the opportunity to quote.", "Prices exclude carriage unless stated."],
    bankDetails: { accountName: "Fernhill Engineering Ltd", bankName: "Example Bank plc", sortCode: "20-00-00", accountNumber: "12345678", iban: "", bic: "" },
    logoSrc,
  };
}

/** A small navy monogram as a PNG data URL (react-pdf cannot draw SVG). Browser only; anything that fails means "no logo", and the documents then print the company name, as on the real page. */
export function monogramLogo(): string | undefined {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 240; canvas.height = 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = "#1e3472"; ctx.fillRect(0, 0, 240, 240);
    ctx.fillStyle = "#ffffff"; ctx.font = "700 150px Arial, Helvetica, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("F", 120, 128);
    return canvas.toDataURL("image/png");
  } catch { return undefined; }
}

/** Builds the sample PDF of one type in one design. The PDF code and the design list load here, not with the Settings page (the same function as the real card's sampleBlob). */
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

type Preview = (detail: string) => void;

/* ------------------------------------------------------------------ the card ------------------------------------------------------------------ */

export interface DocumentDesignsPanelProps {
  /** The neutral toast: "Preview only", the detail and "Nothing was saved." */
  preview: Preview;
  /** Forced states from Preview controls; the default is the real card's normal state. */
  states?: DesignsStates;
  /** Controlled open flag (Preview controls); leave out and the card keeps its own, closed until opened or until the page is on #setup-designs. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Bumped by Reset preview so local draft state starts again. */
  resetKey?: number;
}

export function DocumentDesignsPanel({ preview, states = INITIAL_STATES, open: openProp, onOpenChange, resetKey = 0 }: DocumentDesignsPanelProps) {
  const [openOwn, setOpenOwn] = useState(false);
  const open = openProp ?? openOwn;
  const setOpen = useCallback((next: boolean) => { setOpenOwn(next); onOpenChange?.(next); }, [onOpenChange]);
  // The real section opens when the page is reached on #setup-designs (the company setup's "Logo and colours" step) and on a later hash change.
  useEffect(() => {
    const check = () => { if (window.location.hash === DOCUMENT_DESIGNS_HASH) setOpen(true); };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [setOpen]);

  return (
    <div id="setup-designs" data-testid="document-designs">
      <Panel title="Document designs" busy={open && states.data === "loading"}>
        {!open ? (
          <div className={s.stack}>
            <p className={s.lead}>{CLOSED_LEAD}</p>
            <div className={s.row}><Button variant="secondary" onClick={() => setOpen(true)} data-testid="open-designs">Open document designs</Button></div>
          </div>
        ) : <OpenCard key={`${states.saved}-${resetKey}`} preview={preview} states={states} />}
      </Panel>
    </div>
  );
}

function OpenCard({ preview, states }: { preview: Preview; states: DesignsStates }) {
  const [settings, setSettings] = useState<DocumentTemplateSettings>(() => seedSettings(states.saved));
  const [designs, setDesigns] = useState<Design[]>([]);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [type, setType] = useState<DocumentType>("quote");
  const [picked, setPicked] = useState<Partial<Record<DocumentType, string>>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const urlRef = useRef<string | null>(null);
  const panelId = useId();

  // The design list and the company's sample profile load together, as in the real card (it reads the store, the profile and the registry).
  useEffect(() => {
    let active = true;
    void import("@/components/pdf/templates/registry").then((registry) => {
      if (!active) return;
      setCompany(sampleCompany(monogramLogo()));
      setDesigns(registry.DOCUMENT_DESIGNS.map(({ id, label, description }) => ({ id, label, description })));
    });
    return () => { active = false; };
  }, []);

  const saved = currentDesignId(settings, type);
  const selected = picked[type] ?? saved;
  const colour = settings.colour === true;

  useEffect(() => {
    if (!company || states.preview === "loading") return;
    let active = true;
    setPreviewError(false);
    if (states.preview === "failed") { setPreviewError(true); return; }
    // The preview follows the colour choice, so ticking the box shows the brand colour straight away.
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
  }, [company, type, selected, colour, states.preview]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const label = (id: string) => designs.find((d) => d.id === id)?.label ?? id;
  const typeLabel = DOCUMENT_TYPE_LABELS[type];
  const ready = states.data === "ready" && designs.length > 0 && company !== null;
  if (!ready) return <LoadingState label="Loading…" rows={3} />;

  const frame = previewError || states.preview === "failed"
    ? <p className={s.frameMsg} role="status" data-testid="preview-failed">{PREVIEW_FAILED}</p>
    : previewUrl && states.preview === "live"
      ? <iframe key={type} title={`Preview of ${typeLabel} in the ${selected} design`} src={`${previewUrl}#view=FitH&navpanes=0`} className={s.iframe} data-testid="pdf-frame" />
      : <p className={s.frameMsg} role="status" data-testid="preview-loading">{PREVIEW_LOADING}</p>;

  return (
    <div className={s.stack} data-testid="designs-open">
      <p className={s.lead}>{CARD_LEAD}</p>

      <div className={s.switchList}>
        <div className={s.switchBox}>
          <Switch
            label={ENABLED_LABEL}
            hint={settings.enabled ? undefined : SWITCHED_OFF_NOTE}
            checked={settings.enabled}
            data-testid="switch-enabled"
            onChange={(on) => { setSettings((c) => withTemplatesEnabled(c, on)); preview(on ? "Your documents would use these designs." : `Every document would print the ${DEFAULT_DESIGN_ID} design again.`); }}
          />
        </div>
        <div className={s.switchBox}>
          <Switch
            label={COLOUR_LABEL}
            hint={colour ? COLOUR_ON_NOTE : COLOUR_OFF_NOTE}
            checked={colour}
            data-testid="switch-colour"
            onChange={(on) => { setSettings((c) => withBrandColour(c, on)); preview(`Brand colours would be ${on ? "used" : "left off"} on the Modern and Minimal designs.`); }}
          />
        </div>
      </div>

      <SegmentedControl
        kind="tabs"
        label="Document type"
        value={type}
        onChange={setType}
        options={DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t], controls: panelId, testId: `type-${t}` }))}
        data-testid="type-tabs"
      />

      <div className={s.layout} role="tabpanel" id={panelId} aria-label={typeLabel} data-testid="type-panel">
        <fieldset className={s.picker}>
          <legend className={s.srOnly}>Design for {typeLabel}</legend>
          <div className={s.cards}>
            {designs.map((design) => (
              <label key={design.id} className={s.card} data-selected={selected === design.id ? "true" : undefined} data-testid={`design-${design.id}`}>
                <input type="radio" className={s.radio} name={`design-${type}`} checked={selected === design.id} onChange={() => setPicked((p) => ({ ...p, [type]: design.id }))} />
                <span className={s.dot} aria-hidden="true" />
                <span className={s.cardText}>
                  <span className={s.cardTitle}>{design.label}{saved === design.id ? <span className={s.current}>(current)</span> : null}</span>
                  <span className={s.cardDesc}>{design.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div className={s.row}>
            <Button
              variant="primary"
              disabled={selected === saved}
              data-testid="save-design"
              onClick={() => preview(`The ${label(selected)} design would be saved for ${typeLabel.toLowerCase()}.`)}
            >
              Save design for {typeLabel.toLowerCase()}
            </Button>
          </div>
        </fieldset>

        <div className={s.previewCol}>
          <div className={s.frame} data-testid="pdf-preview" data-state={previewError || states.preview === "failed" ? "failed" : previewUrl && states.preview === "live" ? "live" : "loading"}>{frame}</div>
          <p className={s.note}>{SAMPLE_NOTE}</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the page ------------------------------------------------------------------ */

function Dock({ role, setRole, states, setStates, open, setOpen, reset }: { role: Role; setRole: (r: Role) => void; states: DesignsStates; setStates: (s: DesignsStates) => void; open: boolean; setOpen: (o: boolean) => void; reset: () => void }) {
  return (
    <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
      <div className={s.dock}>
        <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated, nothing is granted and no request is made.</p>
        <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
        <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={setRole} />
        <p className={s.dockLabel}>Card and preview states</p>
        <label className={s.dockSelect}><span>Section</span>
          <Select value={open ? "open" : "closed"} onChange={(e) => setOpen(e.target.value === "open")}><option value="closed">Closed (the real default)</option><option value="open">Open</option></Select>
        </label>
        <label className={s.dockSelect}><span>Card</span>
          <Select value={states.data} onChange={(e) => setStates({ ...states, data: e.target.value as DesignsStates["data"] })}><option value="ready">Ready</option><option value="loading">Loading</option></Select>
        </label>
        <label className={s.dockSelect}><span>PDF preview</span>
          <Select value={states.preview} onChange={(e) => setStates({ ...states, preview: e.target.value as DesignsStates["preview"] })}><option value="live">Built live</option><option value="loading">Still loading</option><option value="failed">Could not load</option></Select>
        </label>
        <label className={s.dockSelect}><span>Stored choices</span>
          <Select value={states.saved} onChange={(e) => setStates({ ...states, saved: e.target.value as DesignsStates["saved"] })}><option value="default">None yet (Classic everywhere)</option><option value="chosen">Modern for quotes, Minimal for invoices</option></Select>
        </label>
        <Button size="sm" variant="secondary" onClick={reset}>Reset preview</Button>
      </div>
    </Popover>
  );
}

function DocumentDesignsScreen() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [states, setStatesRaw] = useState<DesignsStates>(INITIAL_STATES);
  const [open, setOpen] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const preview: Preview = useCallback((detail) => toast.show({ title: "Preview only", detail: `${detail} ${NOT_SAVED}` }), [toast]);
  const denied = !canUseSettings(role);

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="document-designs-preview" data-role={role}>
      <PreviewBar
        data-testid="preview-bar"
        label={PREVIEW_TAG}
        controls={
          <Dock
            role={role} setRole={(r) => { toast.clear(); setRole(r); }}
            states={states} setStates={(next) => { toast.clear(); setStatesRaw(next); }}
            open={open} setOpen={(o) => { toast.clear(); setOpen(o); }}
            reset={() => { toast.clear(); setRole("admin"); setStatesRaw(INITIAL_STATES); setOpen(false); setResetKey((k) => k + 1); }}
          />
        }
      />
      <PageHeader title={denied ? "Access Denied" : "Settings"} description={denied ? "Redirecting you back to the dashboard." : `Company-wide settings for ${PRODUCT.name}. Only admins can change them.`} />
      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <p className={s.deniedNote}>Preview only: no redirect happens here. Settings is for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : (
        <DocumentDesignsPanel preview={preview} states={states} open={open} onOpenChange={setOpen} resetKey={resetKey} />
      )}
    </div>
  );
}

export default function DocumentDesignsPreview() {
  return (
    <ToastProvider placement="bottom-right">
      <DocumentDesignsScreen />
    </ToastProvider>
  );
}
