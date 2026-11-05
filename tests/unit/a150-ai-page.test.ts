/**
 * A150: the old AI page (/ai-helper) in every state. Its management actions (key, switch, Tolra mode, monthly limit) are gone: each needs a fresh
 * authenticator code that only the AI card on Admin > Integrations asks for, so the page shows a notice and a link there and keeps the feature panels.
 * The page's hook is stood in for; the panels are stubs (they are not what is under test).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";

const state = vi.hoisted(() => ({ allowed: true, loaded: true, status: null as AiHelperStatus | null, reload: vi.fn(), setStatus: vi.fn() }));
vi.mock("@/components/ai-helper/use-ai-helper-status", async (original) => ({ ...(await original<object>()), useAiHelperStatus: () => state }));
vi.mock("@/components/role-gate", () => ({ RoleGate: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/ai-helper/roundup-panel", () => ({ AiRoundupPanel: () => createElement("section", { "data-testid": "stub-roundup" }) }));
vi.mock("@/components/ai-helper/rfq-panel", () => ({ AiRfqPanel: () => createElement("section", { "data-testid": "stub-rfq" }) }));
vi.mock("@/components/ai-helper/assistant-panel", () => ({ AiAssistantPanel: () => createElement("section", { "data-testid": "stub-assistant" }) }));

import AiHelperPage from "@/app/(dashboard)/ai-helper/page";

const status = (over: Partial<AiHelperStatus> = {}): AiHelperStatus => ({
  roundup_enabled: false, rfq_enabled: false, monthly_cap_pence: 1000, key_set: false, key_last4: null, month_spent_pence: 0, month_reserved_pence: 0, can_manage: true,
  tolra_available: true, tolra_enabled: false, tolra_cap_pence: 1000, finance_check_available: true, finance_check_enabled: false, assistant_available: true, assistant_enabled: false, ...over,
});
const html = () => renderToStaticMarkup(createElement(AiHelperPage));
/** Every control or card the page used to carry for managing AI. None may come back: the server would refuse them while a fresh code is required. */
const MANAGEMENT = ['data-testid="ai-helper-master"', 'data-testid="ai-master-switch"', 'data-testid="ai-helper-settings"', 'data-testid="tolra-ai-card"', "Save monthly limit", "Save key", "Remove key", 'type="password"', 'type="checkbox"'];

beforeEach(() => { state.allowed = true; state.loaded = true; state.status = status(); });

describe("the AI page keeps no management action", () => {
  it("admin, AI off: says it is off, points to Admin > Integrations with a working link, shows what it does, and has no management control", () => {
    const out = html();
    expect(out).toContain('data-testid="ai-helper-off"');
    expect(out).toContain("Turn it on in Admin &gt; Integrations.");
    expect(out).toMatch(/<a [^>]*href="\/admin\/integrations#ai"[^>]*data-testid="ai-helper-manage-link"|<a [^>]*data-testid="ai-helper-manage-link"[^>]*href="\/admin\/integrations#ai"/);
    expect(out).toContain('data-testid="ai-helper-manage-notice"');
    for (const control of MANAGEMENT) expect(out, control).not.toContain(control);
    expect(out).not.toContain("<button");
    expect(out).not.toContain("stub-");
  });

  it("office, AI off: told an admin does it, no link to a page office cannot open, no control", () => {
    state.status = status({ can_manage: false });
    const out = html();
    expect(out).toContain("An admin can turn it on in Admin &gt; Integrations.");
    expect(out).toContain("Only an admin sets up AI");
    expect(out).not.toContain('data-testid="ai-helper-manage-link"');
    expect(out).not.toContain("/admin/integrations");
    for (const control of MANAGEMENT) expect(out, control).not.toContain(control);
  });

  it("AI on with its own key: the feature panels still work and nothing to manage appears; the off line is gone", () => {
    state.status = status({ roundup_enabled: true, rfq_enabled: true, assistant_enabled: true, key_set: true, key_last4: "wxyz" });
    const out = html();
    for (const panel of ["stub-roundup", "stub-rfq", "stub-assistant"]) expect(out, panel).toContain(`data-testid="${panel}"`);
    expect(out).not.toContain('data-testid="ai-helper-off"');
    expect(out).toContain('data-testid="ai-helper-manage-notice"');
    for (const control of MANAGEMENT) expect(out, control).not.toContain(control);
  });

  it("AI on through Tolra-provided AI: the same page, no Tolra toggle", () => {
    state.status = status({ tolra_enabled: true, roundup_enabled: true, rfq_enabled: true });
    const out = html();
    expect(out).toContain('data-testid="stub-roundup"');
    expect(out).toContain('data-testid="stub-rfq"');
    expect(out).not.toContain('data-testid="stub-assistant"');
    for (const control of MANAGEMENT) expect(out, control).not.toContain(control);
  });

  it("only the features that are on get a panel", () => {
    state.status = status({ rfq_enabled: true });
    const out = html();
    expect(out).toContain('data-testid="stub-rfq"');
    expect(out).not.toContain('data-testid="stub-roundup"');
    expect(out).not.toContain('data-testid="stub-assistant"');
  });

  it("loading, server off and unreadable status keep their messages and show no notice, link or panel", () => {
    state.loaded = false;
    expect(html()).toContain("Loading...");
    state.loaded = true; state.allowed = false;
    expect(html()).toContain('data-testid="ai-helper-unavailable"');
    state.allowed = true; state.status = null;
    const out = html();
    expect(out).toContain('data-testid="ai-helper-error"');
    for (const hidden of ['data-testid="ai-helper-manage-notice"', 'data-testid="ai-helper-manage-link"', "stub-"]) expect(out, hidden).not.toContain(hidden);
  });

  it("the page no longer imports the cards whose buttons the server refuses without a fresh code", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/ai-helper/page.tsx"), "utf8");
    for (const gone of ["master-card", "customised-card", "tolra-ai-card", "AiMasterCard", "AiCustomisedCard", "TolraAiConnectionCard", "/api/ai-helper/key", "/api/ai-helper/settings", "/api/ai-helper/tolra-mode"]) expect(source, gone).not.toContain(gone);
    expect(source).toContain("/admin/integrations#ai");
  });
});
