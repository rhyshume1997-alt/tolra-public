// @vitest-environment jsdom
/**
 * BOUNDARY (AI section, Integrations module 6 by the coordinator's decision, PREVIEW ONLY). Inputs: the exports of components/integrations/preview/AiHelperPreview.tsx, the REAL constants it uses
 * (lib/ai-helper/limits, lib/ai-helper/rfq, components/tooly/poses) and the SOURCE TEXT of app/(dashboard)/ai-helper/page.tsx and components/ai-helper/{what-it-shows,roundup-panel,rfq-panel,assistant-panel,
 * use-ai-helper-status}.tsx (read as files, never run). Output: pass/fail. Pins the preview to today's AI page: wording, which panels show, the notices, the labels and the local checks before Approve. Also
 * checks that the preview imports nothing that could call a model or a server, that every action answers with the neutral Preview-only toast, and that a generated answer is NEVER shown: result areas hold
 * only "Sample answer, not generated".
 * Must not change: never loosen these to make a change pass. No network, no Supabase, no model. Written with createElement (no JSX) so it runs under the existing vitest.config.ts include pattern.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import AiHelperPreview, * as P from "@/components/integrations/preview/AiHelperPreview";
import { RFQ_MAX_CHARS } from "@/lib/ai-helper/limits";
import { ATTACHMENTS_REFUSED } from "@/lib/ai-helper/rfq";

const root = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(root, p), "utf8");
const PAGE = rd("app/(dashboard)/ai-helper/page.tsx");
const WHAT = rd("components/ai-helper/what-it-shows.tsx");
const ROUNDUP = rd("components/ai-helper/roundup-panel.tsx");
const RFQ = rd("components/ai-helper/rfq-panel.tsx");
const ASSISTANT = rd("components/ai-helper/assistant-panel.tsx");
const STATUS = rd("components/ai-helper/use-ai-helper-status.ts");
const SRC = rd("components/integrations/preview/AiHelperPreview.tsx");
const ROUTE = rd("app/(dashboard)/ai-helper/preview/page.tsx");
const CSS = rd("components/integrations/preview/AiHelperPreview.module.css");
const esc = (t: string) => t.replace(/'/g, "&apos;").replace(/>/g, "&gt;");

describe("ai preview: pinned to the real page's source text", () => {
  it("the header, the states and the notices are the real words", () => {
    expect(PAGE).toContain(`<h1 className="page-title">${P.PAGE_TITLE}</h1>`);
    expect(PAGE).toContain(P.PAGE_SUBTITLE);
    expect(PAGE).toContain(P.LOADING);
    expect(PAGE).toContain(P.UNAVAILABLE);
    expect(PAGE).toContain(P.LOAD_ERROR);
    expect(PAGE).toContain(P.OFF_BASE);
    expect(PAGE).toContain(`"${P.OFF_MANAGE}"`);
    expect(PAGE).toContain(`"${P.OFF_NO_MANAGE}"`);
    expect(PAGE).toContain("AI is set up in one place now, the AI card on Admin &gt; Integrations: your key, the on/off switch and the monthly limit.");
    expect(PAGE).toContain("Open Admin &gt; Integrations");
    expect(PAGE).toContain("Only an admin sets up AI or turns it on or off. They do it in the AI card on Admin &gt; Integrations.");
    expect(PAGE).toContain(`const AI_SETUP_HREF = "${P.AI_SETUP_HREF}"`);
    expect(PAGE).toContain('<RoleGate allowed={["admin", "office"]}>');
  });
  it("which panels show follows the real page, and anyFeatureOn is the real rule", () => {
    expect(PAGE).toContain("status.roundup_enabled ? <AiRoundupPanel");
    expect(PAGE).toContain("status.rfq_enabled ? <AiRfqPanel");
    expect(PAGE).toContain("status.assistant_available && status.assistant_enabled ? <AiAssistantPanel");
    expect(STATUS).toContain("Boolean(status && (status.roundup_enabled || status.rfq_enabled || (status.assistant_available && status.assistant_enabled)))");
    const base = { roundup_enabled: false, rfq_enabled: false, can_manage: true, assistant_available: false, assistant_enabled: false };
    expect(P.anyFeatureOn(base)).toBe(false);
    expect(P.anyFeatureOn({ ...base, rfq_enabled: true })).toBe(true);
    expect(P.anyFeatureOn({ ...base, assistant_available: true, assistant_enabled: false })).toBe(false);
    expect(P.anyFeatureOn({ ...base, assistant_available: true, assistant_enabled: true })).toBe(true);
    expect(P.anyFeatureOn(null)).toBe(false);
    expect(P.offNotice(true)).toBe("AI is off for this company. Turn it on in Admin > Integrations.");
    expect(P.offNotice(false)).toBe("AI is off for this company. An admin can turn it on in Admin > Integrations.");
    expect([P.canUseAi("admin"), P.canUseAi("office"), P.canUseAi("workshop"), P.canUseAi("viewer")]).toEqual([true, true, false, false]);
  });
  it("What this shows is the real static text", () => {
    expect(WHAT).toContain(`<CardTitle>${P.WHAT_TITLE}</CardTitle>`);
    expect(WHAT).toContain(P.WHAT_INTRO);
    for (const i of P.WHAT_ITEMS) { expect(WHAT).toContain(i.name); expect(WHAT).toContain(esc(i.text).replace("Needs human review", "Needs human review").slice(0, 60)); }
    expect(P.WHAT_ITEMS).toHaveLength(4);
  });
  it("the Round-up panel's words and choices are the real ones", () => {
    expect(ROUNDUP).toContain(P.ROUNDUP.text);
    expect(ROUNDUP).toContain(`<CardTitle>${P.ROUNDUP.title}</CardTitle>`);
    expect(ROUNDUP).toContain(`aria-label="${P.ROUNDUP.periodLabel}"`);
    expect(ROUNDUP).toContain('<option value="daily">Daily</option>');
    expect(ROUNDUP).toContain('<option value="weekly">Weekly</option>');
    expect(ROUNDUP).toContain(P.ROUNDUP.make);
  });
  it("the RFQ panel's words, limits, review labels and local checks are the real ones", () => {
    expect(RFQ).toContain(`<CardTitle>${P.RFQ.title}</CardTitle>`);
    expect(RFQ).toContain("Paste the customer&apos;s email text. Attachments and drawings are not read yet (a later version).");
    expect(RFQ).toContain(P.RFQ.approve);
    expect(RFQ).toContain(P.RFQ.read);
    expect(RFQ).toContain(`aria-label="${P.RFQ.textLabel}"`);
    expect(RFQ).toContain(P.RFQ.noPrice);
    expect(RFQ).toContain("Enter the customer before approving.");
    expect(RFQ).toContain("There are no lines to quote.");
    expect(RFQ).toContain("fill in the description and a whole-number quantity (or remove the line) before approving.");
    expect(RFQ).toContain("!/^\\d+$/.test(l.quantity.trim()) || !(Number(l.quantity) > 0)");
    expect(RFQ).toContain('description: "description", part_number: "part number", material: "material", finish: "finish", quantity: "quantity", due_date: "due date", price: "price"');
    expect(RFQ).toContain("Remove line");
    expect(RFQ).toContain("Reject");
    expect(RFQ_MAX_CHARS).toBe(20_000);
    expect(ATTACHMENTS_REFUSED).toBe("Attachments aren't read yet: paste the email text only. Reading drawings comes in a later version.");
    expect(P.approveBlock("", [])).toBe("Enter the customer before approving.");
    expect(P.approveBlock("Acme", [])).toBe("There are no lines to quote.");
    expect(P.approveBlock("Acme", [{ description: "Bracket", quantity: "4" }, { description: "", quantity: "2" }])).toBe("Line 2: fill in the description and a whole-number quantity (or remove the line) before approving.");
    expect(P.approveBlock("Acme", [{ description: "Bracket", quantity: "4.5" }])).toContain("Line 1:");
    expect(P.approveBlock("Acme", [{ description: "Bracket", quantity: "4" }])).toBeNull();
  });
  it("the assistant panel's words and choices are the real ones, and it has no Send or Save", () => {
    expect(ASSISTANT).toContain(`<CardTitle>${P.ASSISTANT.title}</CardTitle>`);
    expect(ASSISTANT).toContain(P.ASSISTANT.tag);
    expect(ASSISTANT).toContain(P.ASSISTANT.text);
    expect(ASSISTANT).toContain('<option value="quotes">Quotes</option>');
    expect(ASSISTANT).toContain('<option value="jobs">Jobs</option>');
    expect(ASSISTANT).toContain(P.ASSISTANT.placeholder);
    expect(ASSISTANT).toContain("Copy draft");
    expect(ASSISTANT).toContain("check it before you use it. Nothing has been sent.");
    expect(ASSISTANT).toContain('aria-label="Your question"');
    expect(ASSISTANT).toContain("maxLength={1000}");
    expect(ASSISTANT).toContain('<ToolyFace pose={pose} size={72} />');
    expect(ASSISTANT).toContain(': "wave"');
  });
});

describe("ai preview: safety of the files", () => {
  it("imports nothing that could call a model, a key, a server or a mailbox", () => {
    const imports = [...SRC.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./AiHelperPreview.module.css", "@/components/tooly/poses", "@/components/ui/premium", "@/lib/ai-helper/limits", "@/lib/ai-helper/rfq", "react"].sort());
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/supabase|fetch\(|XMLHttpRequest|openai|anthropic|claude|AI_HELPER_MODELS|api\/ai|navigator\.clipboard|fetchCostingParts|calculatePartCost|lib\/costing|localStorage|sessionStorage/i);
    expect(ROUTE.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/supabase|fetch\(|"use server"/);
  });
  it("the CSS has no gradient, blur or global selector, and each file carries a boundary comment naming the assumption", () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/gradient|backdrop-filter|blur\(/i);
    expect(css).not.toMatch(/^\s*(html|body|\*|:root)\b/m);
    for (const src of [SRC, ROUTE, CSS]) expect(src).toMatch(/BOUNDARY/);
    for (const src of [SRC, ROUTE]) expect(src).toMatch(/module 6/i);
  });
  it("the only answer text in the file is the placeholder, and it says it is not generated", () => {
    expect(P.PLACEHOLDER_ANSWER).toBe("Sample answer, not generated");
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/Dear |Hello |Kind regards|Best regards|your quotes are|we recommend/i);
  });
});

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let host: HTMLDivElement | null = null;
let rootEl: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => rootEl?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; rootEl = null; vi.restoreAllMocks(); });
function mount() { host = document.createElement("div"); document.body.appendChild(host); rootEl = createRoot(host); act(() => rootEl!.render(createElement(AiHelperPreview))); return host; }
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
const dock = () => { const b = byText(document.body, "button", /Preview controls/); if (b?.getAttribute("aria-expanded") !== "true") click(b); };
const radio = (group: string, label: string) => { dock(); click(byText(document.body, `[role="radiogroup"][aria-label="${group}"] [role="radio"]`, label)); };
const sw = (label: string) => { dock(); click(byText(document.body, "label", new RegExp(label))?.querySelector('[role="switch"]')); };
const byLabel = (label: string) => { const l = byText(document.body, "label", label) as HTMLLabelElement | undefined; return document.getElementById(l?.htmlFor ?? "") as HTMLTextAreaElement | HTMLInputElement; };
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
};

describe("ai preview: rendered behaviour", () => {
  it("labels itself and shows the header, the manage notice, What this shows and the three panels, and calls nothing", () => {
    const fetchSpy = vi.fn(() => { throw new Error("no network"); });
    vi.stubGlobal("fetch", fetchSpy);
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector("h1")?.textContent).toBe("AI");
    expect(h.querySelector('[data-testid="ai-helper-manage-link"]')?.textContent).toBe("Open Admin > Integrations");
    for (const id of ["ai-what-it-shows", "ai-roundup-panel", "ai-rfq-panel", "ai-assistant-panel"]) expect(h.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    expect(h.querySelector('[data-testid="ai-helper-off"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("shows no result area and no answer until placeholders are switched on, and then only the placeholder", () => {
    const h = mount();
    expect(h.querySelector('[data-testid="ai-roundup-summary"]')).toBeNull();
    expect(h.querySelector('[data-testid="ai-assistant-answer"]')).toBeNull();
    expect(h.querySelector('[data-testid="ai-rfq-suggestion"]')).toBeNull();
    sw("Show result areas");
    expect(h.querySelector('[data-testid="ai-roundup-summary"]')?.textContent).toBe("Sample answer, not generated");
    expect(h.querySelector('[data-testid="ai-assistant-answer"]')?.textContent).toBe("Sample answer, not generated");
    expect(h.querySelector('[data-testid="ai-assistant-draft"]')?.textContent).toContain("Sample answer, not generated");
    expect(h.querySelector('[data-testid="ai-rfq-suggestion"]')?.textContent).toContain("Sample answer, not generated");
  });
  it("Make round-up, Read email, Ask and Copy draft answer only with the neutral Preview-only toast", () => {
    const h = mount();
    click(byText(h, "button", "Make round-up"));
    let text = document.body.textContent ?? "";
    expect(text).toContain("Preview only");
    expect(text).toContain("Nothing was saved.");
    expect(text).toContain("No AI request was sent.");
    expect(byText(h, "button", "Read email")?.hasAttribute("disabled")).toBe(true);
    type(byLabel("RFQ email text"), "Sample pasted text");
    expect(byText(h, "button", "Read email")?.hasAttribute("disabled")).toBe(false);
    click(byText(h, "button", "Read email"));
    expect(document.body.textContent).toContain("The email was not read.");
    expect(byText(h, "button", "Ask")?.hasAttribute("disabled")).toBe(true);
    type(h.querySelector<HTMLTextAreaElement>('[aria-label="Your question"]')!, "Sample question");
    click(byText(h, "button", "Ask"));
    text = document.body.textContent ?? "";
    expect(text).toContain("Nothing was asked about quotes.");
    expect(text).not.toMatch(/answer:|generated for you|Here is|Here are/);
  });
  it("Approve runs the real local checks first and then answers with the Preview-only toast; Reject and Copy draft too", () => {
    const h = mount();
    sw("Show result areas");
    click(byText(h, "button", "Approve and create draft quote"));
    expect(h.querySelector('[data-testid="ai-rfq-error"]')?.textContent).toContain("Enter the customer before approving.");
    type(h.querySelector<HTMLInputElement>('input[aria-label="Customer"]')!, "Sample Customer Ltd");
    click(byText(h, "button", "Approve and create draft quote"));
    expect(h.querySelector('[data-testid="ai-rfq-error"]')?.textContent).toContain("Line 1: fill in the description");
    type(h.querySelector<HTMLInputElement>('input[aria-label="Line 1 description"]')!, "Sample part");
    type(h.querySelector<HTMLInputElement>('input[aria-label="Line 1 quantity"]')!, "12");
    click(byText(h, "button", "Approve and create draft quote"));
    expect(h.querySelector('[data-testid="ai-rfq-error"]')).toBeNull();
    expect(document.body.textContent).toContain("No draft quote was created.");
    expect(document.body.textContent).not.toMatch(/Draft quote .* created/);
    click(byText(h, "button", "Reject"));
    expect(document.body.textContent).toContain("The suggestion was not rejected or recorded.");
    click(byText(h, "button", "Copy draft"));
    expect(document.body.textContent).toContain("Nothing was copied.");
  });
  it("Remove line leaves the real empty-lines sentence and the real Approve check", () => {
    const h = mount();
    sw("Show result areas");
    click(byText(h, "button", "Remove line"));
    expect(h.textContent).toContain("Needs human review: no items were found in this email.");
    type(h.querySelector<HTMLInputElement>('input[aria-label="Customer"]')!, "Sample Customer Ltd");
    click(byText(h, "button", "Approve and create draft quote"));
    expect(h.querySelector('[data-testid="ai-rfq-error"]')?.textContent).toBe("There are no lines to quote.");
  });
  it("server off, status not loaded, loading, and AI off for the company (admin and office) show the real sentences", () => {
    const h = mount();
    radio("Server switch", "Off (default)");
    expect(h.querySelector('[data-testid="ai-helper-unavailable"]')?.textContent).toBe(P.UNAVAILABLE);
    radio("Server switch", "On");
    radio("Status read", "Could not be loaded");
    expect(h.querySelector('[data-testid="ai-helper-error"]')?.textContent).toBe(P.LOAD_ERROR);
    radio("Status read", "Loading");
    expect(h.querySelector('[data-testid="loading"]')?.textContent).toBe("Loading...");
    radio("Status read", "Read");
    sw("Round-up");
    sw("RFQ email to draft quote");
    radio("Assistant", "Off");
    expect(h.querySelector('[data-testid="ai-helper-off"]')?.textContent).toBe("AI is off for this company. Turn it on in Admin > Integrations.");
    sw("This person can manage AI");
    expect(h.querySelector('[data-testid="ai-helper-off"]')?.textContent).toBe("AI is off for this company. An admin can turn it on in Admin > Integrations.");
    expect(h.querySelector('[data-testid="ai-helper-manage-notice"]')?.textContent).toContain("Only an admin sets up AI");
    expect(h.querySelector('[data-testid="ai-helper-manage-link"]')).toBeNull();
  });
  it("the assistant shows only when the server offers it and the company has it on", () => {
    const h = mount();
    radio("Assistant", "Not offered");
    expect(h.querySelector('[data-testid="ai-assistant-panel"]')).toBeNull();
    radio("Assistant", "Off");
    expect(h.querySelector('[data-testid="ai-assistant-panel"]')).toBeNull();
    radio("Assistant", "On");
    expect(h.querySelector('[data-testid="ai-assistant-panel"]')).not.toBeNull();
  });
  it("the manage link goes nowhere: it answers with the Preview-only toast", () => {
    const h = mount();
    click(h.querySelector('[data-testid="ai-helper-manage-link"]'));
    expect(document.body.textContent).toContain("This opens Admin > Integrations.");
    expect(document.body.textContent).toContain("Nothing was saved.");
  });
  it("Workshop and Viewer get Access Denied", () => {
    const h = mount();
    radio("Role", "Workshop");
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
    expect(h.querySelector('[data-testid="ai-roundup-panel"]')).toBeNull();
  });
});
