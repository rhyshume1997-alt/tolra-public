// @vitest-environment jsdom
/**
 * BOUNDARY (PREVIEW ONLY; Settings treated as Module 1 for this preview). Inputs: the exports of components/settings/preview/DocumentDesignsPreview.tsx and the SOURCE (read only) of the real
 * Module J card and section, the real design registry and the real pure lib functions. Output: pass/fail. Pins the picker options, labels, the off-by-default switches, the tabs, the lead sentences,
 * the closed/open and #setup-designs behaviour, the admin gate and the preview technique (real sampleDocument + real PDF components + pdf().toBlob() in an iframe blob) to the real code, proves every
 * control is reachable, that nothing reports success or saves, and that the preview CSS never scrolls sideways at 1024 px and under.
 * Must not change: never loosen these to make a change pass; the real card is the source of truth. No network, no Supabase. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ built: [] as Array<{ type: string; design?: string; colour?: boolean }> }));
vi.mock("@react-pdf/renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@react-pdf/renderer")>()),
  pdf: (element: { type: { name?: string }; props: { data: { design?: string; company?: { documentTemplates?: { colour?: boolean } } } } }) => {
    state.built.push({ type: element.type.name ?? "?", design: element.props.data.design, colour: element.props.data.company?.documentTemplates?.colour });
    return { toBlob: async () => new Blob(["%PDF"]) };
  },
}));

import DocumentDesignsPreview, {
  CARD_LEAD, CLOSED_LEAD, COLOUR_LABEL, COLOUR_OFF_NOTE, COLOUR_ON_NOTE, ENABLED_LABEL, NOT_SAVED, PREVIEW_FAILED, PREVIEW_LOADING, SAMPLE_NOTE, SWITCHED_OFF_NOTE,
  DocumentDesignsPanel, canUseSettings, sampleCompany, seedSettings,
} from "@/components/settings/preview/DocumentDesignsPreview";
import { DOCUMENT_DESIGNS } from "@/components/pdf/templates/registry";
import { currentDesignId, DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES } from "@/lib/document-templates/document-template-settings";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const REAL_CARD = read("components/document-templates/document-designs-card.tsx");
const REAL_SECTION = read("components/document-templates/document-designs-section.tsx");
const SRC = read("components/settings/preview/DocumentDesignsPreview.tsx");
const CSS = read("components/settings/preview/DocumentDesignsPreview.module.css");
const PAGE = read("app/(dashboard)/settings/documents-preview/page.tsx");
const plain = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

let host: HTMLDivElement; let root: Root;
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const mount = async (el = createElement(DocumentDesignsPreview)) => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root.render(el); }); };
const click = async (el: Element | null | undefined) => { expect(el, "element to click").toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const byText = (sel: string, text: string) => [...host.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));
const open = async () => { await click(byText("button", "Open document designs")); for (let i = 0; i < 100 && !host.querySelector('[data-testid="designs-open"]'); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); for (let i = 0; i < 100 && !state.built.length; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); await settle(); };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.built = []; window.location.hash = "";
  URL.createObjectURL = () => "blob:preview"; URL.revokeObjectURL = () => undefined;
});
afterEach(async () => { if (root) await act(async () => { root.unmount(); }); host?.remove(); root = undefined as never; host = undefined as never; });

describe("pinned to the real card and section", () => {
  it("the sentences are the real ones", () => {
    expect(plain(REAL_CARD)).toContain(CARD_LEAD);
    expect(plain(REAL_SECTION)).toContain(CLOSED_LEAD);
    for (const t of [ENABLED_LABEL, COLOUR_LABEL, COLOUR_ON_NOTE, COLOUR_OFF_NOTE, PREVIEW_FAILED, PREVIEW_LOADING.replace("…", "…"), SAMPLE_NOTE]) expect(plain(REAL_CARD)).toContain(t);
    expect(REAL_CARD).toContain("Switched off: every document prints the {DEFAULT_DESIGN_ID} design, as it always has. You can still try the designs below.");
    expect(SWITCHED_OFF_NOTE).toBe("Switched off: every document prints the classic design, as it always has. You can still try the designs below.");
    expect(REAL_SECTION).toContain('DOCUMENT_DESIGNS_HASH = "#setup-designs"');
    expect(REAL_SECTION).toContain("Open document designs");
  });
  it("the preview is built the real way: real sampleDocument, real PDF components, pdf().toBlob(), a blob in an iframe", () => {
    for (const needle of ['import("@react-pdf/renderer")', "sampleDocument(type, company, design)", 'import("@/components/pdf/QuotePDF")', 'import("@/components/pdf/InvoicePDF")', 'import("@/components/pdf/PurchaseOrderPDF")', 'import("@/components/pdf/DeliveryNotePDF")', "pdf(element as never).toBlob()", "URL.createObjectURL(blob)", "<iframe"]) {
      expect(REAL_CARD, needle).toContain(needle); expect(SRC, needle).toContain(needle);
    }
    expect(SRC).toContain("documentTemplates: { enabled: true, colour: colour || undefined }");
    expect(REAL_CARD).toContain("documentTemplates: { enabled: true, colour: colour || undefined }");
  });
  it("the registry lists the designs the picker shows", () => {
    expect(DOCUMENT_DESIGNS.map((d) => [d.id, d.label])).toEqual([["classic", "Classic"], ["modern", "Modern"], ["minimal", "Minimal"]]);
    expect(DOCUMENT_TYPES.map((t) => DOCUMENT_TYPE_LABELS[t])).toEqual(["Quotes", "Invoices", "Purchase orders", "Delivery notes"]);
  });
  it("admin only, as the real page and middleware; the real page has no open-in-new-tab link so there is none", () => {
    expect(read("middleware.ts")).toContain('["/settings", ["admin"]]');
    expect(canUseSettings("admin")).toBe(true);
    for (const r of ["office", "workshop", "viewer"] as const) expect(canUseSettings(r)).toBe(false);
    expect(REAL_CARD).not.toMatch(/target="_blank"|window\.open/);
    expect(SRC).not.toMatch(/target="_blank"|window\.open/);
  });
  it("imports no auth, storage, network or database code", () => {
    const imports = [...SRC.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    for (const bad of ["@/lib/supabase", "@/lib/supabase-business", "@/lib/audit", "@/lib/document-templates/document-template-store", "sonner", "@/lib/use-user"]) expect(imports).not.toContain(bad);
    expect(SRC).not.toMatch(/\bfetch\(|localStorage|sessionStorage|XMLHttpRequest/);
    expect(PAGE).toContain("DocumentDesignsPreview");
  });
  it("the sample company is made up", () => {
    const c = sampleCompany();
    expect(c.documentName).toBe("Fernhill Engineering Ltd");
    expect(c.email.endsWith(".example")).toBe(true);
  });
});

describe("the card", () => {
  it("is closed by default and loads no PDF code until opened", async () => {
    await mount(); await settle();
    expect(host.querySelector("#setup-designs")?.textContent).toContain("Document designs");
    expect(byText("button", "Open document designs")).toBeTruthy();
    expect(host.querySelector('[data-testid="designs-open"]')).toBeNull();
    expect(state.built).toHaveLength(0);
  });
  it("opens on #setup-designs and on a later hash change", async () => {
    window.location.hash = "#setup-designs";
    await mount(); await settle();
    expect(host.querySelector('[data-testid="designs-open"]')).not.toBeNull();
  });
  it("shows the tabs, every design, both switches off, Classic current, and builds the quote preview in an iframe", async () => {
    await mount(); await open();
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Quotes", "Invoices", "Purchase orders", "Delivery notes"]);
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(3);
    expect(host.querySelector('[data-testid="design-classic"]')?.textContent).toContain("(current)");
    expect(host.querySelector('[data-testid="design-modern"]')?.textContent).toContain(DOCUMENT_DESIGNS[1].description);
    for (const id of ["switch-enabled", "switch-colour"]) expect(host.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain(SWITCHED_OFF_NOTE);
    expect(state.built.at(-1)).toMatchObject({ type: "QuotePDF", design: "classic" });
    const frame = host.querySelector("iframe");
    expect(frame?.getAttribute("title")).toBe("Preview of Quotes in the classic design");
    expect(frame?.getAttribute("src")?.startsWith("blob:preview")).toBe(true);
  });
  it("picking a design redraws the preview; each type has its own document; Save and the switches answer Preview only and save nothing", async () => {
    await mount(); await open();
    await click(host.querySelector('[data-testid="design-modern"]'));
    expect(state.built.at(-1)?.design).toBe("modern");
    expect(byText("button", "Save design for quotes")?.hasAttribute("disabled")).toBe(false);
    await click(byText("button", "Save design for quotes"));
    expect(document.body.textContent).toContain("Preview only");
    expect(document.body.textContent).toContain(NOT_SAVED);
    expect(host.querySelector('[data-testid="design-classic"]')?.textContent).toContain("(current)");
    expect(host.querySelector('[data-testid="design-modern"]')?.textContent).not.toContain("(current)");
    for (const [tab, type] of [["Invoices", "InvoicePDF"], ["Purchase orders", "PurchaseOrderPDF"], ["Delivery notes", "DeliveryNotePDF"]] as const) {
      await click(byText('[role="tab"]', tab)); expect(state.built.at(-1)?.type).toBe(type);
    }
    await click(host.querySelector('[data-testid="switch-colour"]'));
    expect(state.built.at(-1)?.colour).toBe(true);
    await click(host.querySelector('[data-testid="switch-enabled"]'));
    expect(host.querySelector('[data-testid="switch-enabled"]')?.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).not.toContain(SWITCHED_OFF_NOTE);
  });
  it("Save is off until a different design is picked", async () => {
    await mount(); await open();
    expect(byText("button", "Save design for quotes")?.hasAttribute("disabled")).toBe(true);
  });
  it("stored choices mark the saved design current per type (real functions)", () => {
    const s = seedSettings("chosen");
    expect(currentDesignId(s, "quote")).toBe("modern");
    expect(currentDesignId(s, "invoice")).toBe("minimal");
    expect(currentDesignId(s, "delivery_note")).toBe("classic");
    expect(seedSettings("default").enabled).toBe(false);
  });
  it("a preview that cannot load says so in the real words", async () => {
    await mount();
    await act(async () => { root.render(createElement(() => null)); });
    await act(async () => { root.render(createElement(DocumentDesignsPanel, { preview: () => undefined, open: true, states: { data: "ready", preview: "failed", saved: "default" } })); });
    for (let i = 0; i < 100 && !host.querySelector('[data-testid="preview-failed"]'); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(host.querySelector('[data-testid="preview-failed"]')?.textContent).toBe(PREVIEW_FAILED);
  });
  it("Office, Workshop and Viewer see Access Denied (via the exported gate)", () => {
    expect(SRC).toContain('denied ? "Access Denied"');
  });
});

describe("no sideways scrolling in the preview CSS", () => {
  it("has no overflow auto or scroll, and no fixed min-width, outside @media (min-width: 1025px)", () => {
    const outside = CSS.replace(/@media \(min-width: ?1025px\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(outside).not.toMatch(/overflow(-x)?\s*:\s*(auto|scroll)/);
    expect(outside).not.toMatch(/min-width\s*:\s*[1-9]\d*px/);
    expect(SRC).not.toMatch(/overflowX\s*:\s*["'](auto|scroll)/);
  });
});
