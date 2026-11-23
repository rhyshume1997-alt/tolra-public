// @vitest-environment jsdom
/**
 * Module J: the real Settings > Document designs card, mounted with the real design list and sample documents (only the database and the PDF
 * renderer are stood in for). Checks what an admin sees and does: four document tabs, every registered design listed, the live preview built for
 * the picked design with the company's choices, saving a design, the on/off switch and the brand-colour switch, and a failed save.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type DocumentTemplateSettings, parseDocumentTemplates } from "@/lib/document-templates/document-template-settings";

const state = vi.hoisted(() => ({ stored: { enabled: false } as { enabled: boolean }, saves: [] as unknown[], failSave: false, previews: [] as Array<{ design?: string; colour?: boolean; type: string }> }));

vi.mock("@react-pdf/renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@react-pdf/renderer")>()),
  pdf: (element: { type: { name?: string }; props: { data: { design?: string; company?: { documentTemplates?: { colour?: boolean } } } } }) => {
    state.previews.push({ type: element.type.name ?? "?", design: element.props.data.design, colour: element.props.data.company?.documentTemplates?.colour });
    return { toBlob: async () => new Blob(["%PDF"]) };
  },
}));
vi.mock("@/lib/document-templates/document-template-store", () => ({
  loadDocumentTemplates: async () => parseDocumentTemplates(state.stored),
  saveDocumentTemplates: async (_org: string, change: (c: DocumentTemplateSettings) => DocumentTemplateSettings) => {
    if (state.failSave) throw new Error("boom");
    const next = change(parseDocumentTemplates(state.stored));
    state.stored = next as never;
    state.saves.push(next);
    return next;
  },
}));
vi.mock("@/lib/company", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/company")>()), loadCompanyProfile: async () => (await import("../support/document-template-fixtures")).FIXTURE_COMPANY }));
vi.mock("@/lib/supabase-business", () => ({ getCurrentOrganizationId: async () => "org-1" }));
vi.mock("@/lib/audit", () => ({ auditEvent: async () => undefined }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { DocumentDesignsCard } from "@/components/document-templates/document-designs-card";

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
const byText = (selector: string, text: string) => [...host.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.includes(text));
const click = async (el: Element | null | undefined) => { expect(el, "element to click").toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const radio = (design: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.querySelector('input[type="radio"]') && l.textContent?.startsWith(design))!.querySelector("input")!;
const checkbox = (label: string) => byText("label", label)!.querySelector("input") as HTMLInputElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.stored = { enabled: false }; state.saves = []; state.failSave = false; state.previews = []; toast.success.mockClear(); toast.error.mockClear();
  URL.createObjectURL = () => "blob:preview"; URL.revokeObjectURL = () => undefined;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(createElement(DocumentDesignsCard)); });
  // The design list and the PDF code load on demand: wait until the card has drawn its tabs and the first preview has been asked for.
  for (let i = 0; i < 100 && !(host.querySelector('[role="tab"]') && state.previews.length); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await settle();
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("Document designs card", () => {
  it("shows the four document types and every registered design, with the switches off and Classic current", () => {
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Quotes", "Invoices", "Purchase orders", "Delivery notes"]);
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(3);
    expect(radio("Classic").closest("label")?.textContent).toContain("(current)");
    expect(radio("Modern")).toBeTruthy();
    expect(radio("Minimal")).toBeTruthy();
    expect(checkbox("Use these designs").checked).toBe(false);
    expect(checkbox("brand colours").checked).toBe(false);
    expect(byText("p", "Switched off")).toBeTruthy();
  });

  it("builds a live preview of the quote in the current design, using the real quote document", () => {
    expect(state.previews.at(-1)).toMatchObject({ type: "QuotePDF", design: "classic" });
    expect(host.querySelector("iframe")?.getAttribute("title")).toContain("Quotes");
  });

  it("picking a design re-draws the preview with it but saves nothing until Save", async () => {
    await click(host.querySelector('input[name="design-quote"][type="radio"]:not(:checked)'));
    expect(state.saves).toHaveLength(0);
    expect(state.previews.at(-1)?.design).not.toBe("classic");
  });

  it("Save stores the pick for that document type only", async () => {
    await click(radio("Modern"));
    await click(byText("button", "Save design for quotes"));
    const saved = state.saves.at(-1) as DocumentTemplateSettings;
    expect(saved.quote?.map((c) => c.design)).toEqual(["modern"]);
    expect(saved.invoice).toBeUndefined();
    expect(toast.success).toHaveBeenCalled();
    expect(radio("Modern").closest("label")?.textContent).toContain("(current)");
  });

  it("each document type has its own choice and preview", async () => {
    await click(radio("Minimal"));
    await click(byText("button", "Save design for quotes"));
    await click(byText('[role="tab"]', "Invoices"));
    expect(radio("Classic").closest("label")?.textContent).toContain("(current)");
    expect(state.previews.at(-1)).toMatchObject({ type: "InvoicePDF", design: "classic" });
    for (const [tab, type] of [["Purchase orders", "PurchaseOrderPDF"], ["Delivery notes", "DeliveryNotePDF"]] as const) {
      await click(byText('[role="tab"]', tab));
      expect(state.previews.at(-1)?.type).toBe(type);
    }
  });

  // Regression: the switches once read the box's state after an await, when React had already put it back, so ticking saved "off".
  it("the on/off switch and the brand-colour switch save on their own and keep each other and the designs", async () => {
    await click(radio("Modern"));
    await click(byText("button", "Save design for quotes"));
    await click(checkbox("Use these designs"));
    await click(checkbox("brand colours"));
    const saved = state.saves.at(-1) as DocumentTemplateSettings;
    expect(saved).toMatchObject({ enabled: true, colour: true });
    expect(saved.quote).toHaveLength(1);
    expect(state.previews.at(-1)?.colour).toBe(true);
    await click(checkbox("brand colours"));
    expect((state.saves.at(-1) as DocumentTemplateSettings).colour).toBeUndefined();
    expect(state.previews.at(-1)?.colour).toBeUndefined();
  });

  it("a failed save says so and leaves the pick unsaved", async () => {
    state.failSave = true;
    await click(radio("Modern"));
    await click(byText("button", "Save design for quotes"));
    expect(toast.error).toHaveBeenCalled();
    expect(state.saves).toHaveLength(0);
    expect(radio("Classic").closest("label")?.textContent).toContain("(current)");
  });
});
