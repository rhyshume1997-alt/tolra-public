// @vitest-environment jsdom
/**
 * BOUNDARY (Admin > Integrations, PREVIEW ONLY; route ownership assumed Module 6 by the coordinator, to be confirmed by the owner). Inputs: the exports of
 * components/integrations/preview/IntegrationsPreview.tsx, the REAL pure functions it uses (integrations/overview, xero-setup-state, accounting-status) and the SOURCE of
 * app/(dashboard)/admin/integrations/page.tsx, components/integrations/*.tsx and lib/integrations/ai-setup.ts. Output: pass/fail. Pins wording and the off-by-default rule to the real source,
 * and checks by rendering that no state is ever drawn as connected, authorised, On or successful, that every action only toasts, and that the preview imports no network, OAuth, e-mail,
 * AI or database code. Must not change: never loosen these. No network. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import IntegrationsPreview, * as P from "@/components/integrations/preview/IntegrationsPreview";
import { activationFor } from "@/lib/integrations/xero-setup-state";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE = read("app/(dashboard)/admin/integrations/page.tsx");
const OVERVIEW = read("components/integrations/integrations-overview.tsx");
const AI = read("components/integrations/ai-setup-card.tsx");
const AILIB = read("lib/integrations/ai-setup.ts");
const XERO = read("components/integrations/xero-setup-card.tsx");
const MS = read("components/integrations/microsoft-setup-card.tsx");
const RESEND = read("components/integrations/resend-setup-card.tsx");
const PANEL = read("components/integrations-panel.tsx");
const STATUS = read("components/integrations/accounting-status-card.tsx");
const SRC = read("components/integrations/preview/IntegrationsPreview.tsx");
const ROUTE = read("app/(dashboard)/admin/integrations/preview/page.tsx");
const ALL = read("components/email-choice-guide.tsx") + PAGE + OVERVIEW + AI + AILIB + XERO + MS + RESEND + PANEL + STATUS + read("lib/integrations/xero-setup-state.ts");
const OVERALLS: P.Overall[] = ["default", "checking", "unreadable", "not-set-up", "reconnect"];

describe("pinned to the real source", () => {
  it("wording", () => {
    for (const w of [P.SUBTITLE, P.AI_SUMMARY, P.XERO_SUMMARY, P.MS_SUMMARY, P.RESEND_SUMMARY, P.NO_KEY_REASON, P.SERVER_OFF_REASON, P.STATUS_ERROR_REASON, P.AI_FOOTNOTE, P.AI_HELP, P.MS_FOOTNOTE,
      P.RESEND_HELP, P.RESEND_FOOTNOTE, P.MS_HELP, P.XERO_DISCONNECT_TITLE, P.XERO_DISCONNECT_TEXT, P.MS_DISCONNECT_TITLE, P.MS_DISCONNECT_TEXT, P.ANTHROPIC_KEYS_URL, "Connect Microsoft 365", "Get the link for your Microsoft admin",
      "Check domain", "Send a test e-mail to me", "E-mail the accountant a connect link", "The accountant does the Xero sign-in?", "Which e-mail should Tolra send from?", "Anthropic, with your company&apos;s own key", "Save key", "Save limit",
      "Status unavailable. No readiness is confirmed.", "Xero: send now and the accountant&apos;s link", "Accounting status", "Needs reconnecting", "Not set up on this server", "No key saved", "Couldn't read the AI status",
      "Each company connects its own Xero organisation. Documents issued before the company connects are never sent.", "Sending: paused until you reconnect", "Sending: not set up"]) {
      expect(ALL.replace(/&apos;/g, "'"), w).toContain(w.replace(/&apos;/g, "'"));
    }
    expect(PAGE).toContain('<h1 className="page-title">Integrations</h1>');
    expect(PAGE).toContain('allowed={["admin"]}');
    expect(OVERVIEW).toContain("moreCards");
    expect(OVERVIEW).toContain("Everything else on this page: the accountant&apos;s tools, the accounting clouds, and the send log.");
    expect(OVERVIEW).toContain("For <strong>{company}</strong>. Each company has its own page: switch company to set up the other.");
    expect(AI).toContain("SHARED_TOLRA_AI_ACTIVE ? <label");
    expect(read("lib/ai-helper/shared-ai-deactivation.ts")).toContain("SHARED_TOLRA_AI_ACTIVE = false");
  });
  it("card order", () => {
    expect(OVERVIEW.indexOf("<AiSetupCard />")).toBeLessThan(OVERVIEW.indexOf("<XeroSetupCard />"));
    expect(OVERVIEW.indexOf("<XeroSetupCard />")).toBeLessThan(OVERVIEW.indexOf("<EmailChoiceGuide />"));
    expect(OVERVIEW.indexOf("<EmailChoiceGuide />")).toBeLessThan(OVERVIEW.indexOf("<MicrosoftSetupCard"));
    expect(OVERVIEW.indexOf("<MicrosoftSetupCard")).toBeLessThan(OVERVIEW.indexOf("<ResendSetupCard"));
    expect(P.CARDS("default").map((c) => c.id)).toEqual(["ai", "xero", "microsoft", "resend"]);
  });
  it("accounting status uses the real columns and function", () => {
    for (const h of ["Provider", "Available", "Setup", "Connection", "Mapping", "Transfers", "Ready", "Last transfer", "Failures"]) expect(STATUS).toContain(`'${h}'`);
    const rows = P.statusRows("default");
    expect(Array.isArray(rows) && rows[0].transfers).toBe("Off");
    expect(Array.isArray(rows) && rows[0].readiness).toBe("Transfers OFF");
    expect(P.statusRows("checking")).toBeNull();
    expect(P.statusRows("unreadable")).toBe("unavailable");
  });
  it("Xero words come from the real functions and the switch is never on", () => {
    for (const o of OVERALLS) { const a = activationFor(P.xeroInputs(o)); expect(a.on).not.toBe(true); }
    expect(P.xeroCard("default").steps[0]).toEqual({ label: "Connect to Xero", state: "next" });
    expect(P.xeroCard("default").connection.label).toBe("Not signed in to Xero");
  });
  it("admin only", () => { expect(P.canUseIntegrations("admin")).toBe(true); for (const r of ["office", "workshop", "viewer"] as const) expect(P.canUseIntegrations(r)).toBe(false); });
});

describe("nothing is ever drawn as connected, on or successful", () => {
  it("no model says so", () => {
    for (const o of OVERALLS) for (const c of P.CARDS(o)) {
      const text = JSON.stringify(c);
      expect(c.activation.on, `${o}/${c.id}`).not.toBe(true);
      expect(text).not.toMatch(/Signed in to Xero|Signed in as|Key saved|All connected|Sending: ready|Connected\b(?! is not)|ready \(Tolra/);
      expect(P.badgeFor(c)).not.toMatch(/: On$/);
    }
    const ai = P.aiCard("default").steps.filter((s) => s.state === "done").map((s) => s.label);
    expect(ai).toEqual(["Choose Anthropic with your own key"]);
  });
  it("the source has no success or authorised wording", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of ["Test e-mail sent", "All connected", "is on.", "Key saved.", "Monthly limit saved", "emerald", "green", "success"]) expect(code, bad).not.toContain(bad);
    for (const bad of ["supabase", "fetch(", "oauth", "localStorage", "use-user", "sonner", "XMLHttpRequest", "sendBeacon", "window.location", "/api/", "post-with-code", "mfa-step-up", "authenticator-code-dialog"]) expect(code.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    expect(SRC).toContain("PREVIEW ONLY");
    expect(SRC).toContain("OWNERSHIP ASSUMPTION");
    expect(ROUTE).toContain("OWNERSHIP ASSUMPTION");
    expect(ROUTE).toContain("robots: { index: false, follow: false }");
  });
  it("sample data carries no secret, token or real id", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8,}/);
    expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const m of code.match(/[\w.-]+@[\w.-]+\.\w+/g) ?? []) expect(m.endsWith(".example"), m).toBe(true);
  });
});

describe("rendering", () => {
  let host: HTMLDivElement;
  beforeAll(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const d = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
    d.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
    d.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  });
  afterEach(() => { host?.remove(); });
  const mount = async () => { host = document.createElement("div"); document.body.appendChild(host); await act(async () => { createRoot(host).render(createElement(IntegrationsPreview)); }); };
  it("default: four cards, all off, every switch disabled and unchecked, actions only toast", async () => {
    await mount();
    for (const id of ["ai", "xero", "microsoft", "resend"]) expect(host.querySelector(`[data-testid="setup-card-${id}"]`)).toBeTruthy();
    for (const sw of host.querySelectorAll('[role="switch"]')) { expect(sw.getAttribute("aria-checked")).toBe("false"); expect((sw as HTMLButtonElement).disabled).toBe(true); }
    expect(host.querySelector('[data-testid="connection-xero"]')?.textContent).toContain("Not signed in to Xero");
    await act(async () => { (host.querySelector('[data-testid="xero-connect"]') as HTMLButtonElement).click(); });
    const t = document.body.textContent ?? "";
    expect(t).toContain("Preview only");
    expect(t).toContain("Nothing was connected.");
    expect(t).not.toMatch(/All connected|Signed in to Xero/);
  });
});
