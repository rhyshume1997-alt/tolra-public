// @vitest-environment jsdom
/**
 * W-F4: the guided Admin > Integrations page. The composition is real (page, overview, panel, the four setup cards); only the browser's
 * fetch and the Supabase client are stood in. Four cards in order (AI, Xero, Microsoft 365, Resend); every activation Off by default with
 * its switch not on; the e-mail guide above Microsoft and Resend; "More" keeps what the page offered before; non-admins get the same refusal.
 */
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ activeRole: "admin" as string }));
vi.mock("@/lib/use-user", () => ({
  useUser: () => ({
    profile: { id: "u-1", role: user.activeRole }, loading: false, activeRole: user.activeRole,
    organizations: [{ organization_id: "o-1", name: "Example Co", slug: "ex", role: user.activeRole, is_current: true }],
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }), useSearchParams: () => new URLSearchParams() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const notConnected = (provider: string) => ({ provider, status: "not_connected", tenant_name: null, connected_at: null, status_reason: null, unmapped: [], counts: {} });
// Any select/filter/order chain resolves to an empty list.
const chain = (): unknown => new Proxy(() => undefined, { get: (_t, key) => (key === "then" ? (ok: (v: unknown) => unknown) => ok({ data: [], error: null }) : chain), apply: () => chain() });
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: async (fn: string, args: { p_provider?: string }) => ({ data: fn === "integration_overview" ? notConnected(args?.p_provider ?? "xero") : [], error: null }),
    auth: { getUser: async () => ({ data: { user: { email: "admin@example.test" } } }) },
    from: () => chain(),
  },
}));
vi.mock("@/lib/db-features", async (original) => ({ ...(await original<object>()), databaseHas084: async () => true }));
vi.mock("@/components/authenticator-code-dialog", () => ({ useCodePrompt: () => ({ requestCode: async () => true, codeDialog: null }) }));

import AdminIntegrationsPage from "@/app/(dashboard)/admin/integrations/page";

const ANSWERS: Record<string, unknown> = {
  "/api/integrations/status": { db107: true, xero: { configured: true }, microsoft: { configured: true } },
  "/api/integrations/resend": { state: "not_configured", message: "Not set up on this server", sender: null },
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  user.activeRole = "admin";
  globalThis.fetch = (async (url: string) => {
    const path = String(url).split("?")[0];
    const body = ANSWERS[path] ?? {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;
});
afterEach(() => { document.body.innerHTML = ""; });

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(AdminIntegrationsPage)));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return host;
}
const cardIds = (host: Element) => [...host.querySelectorAll('[data-testid^="setup-card-"]')].map((el) => el.getAttribute("data-testid")!.replace("setup-card-", ""));

describe("the guided Integrations page", () => {
  it("shows the four cards in order: AI, Xero, Microsoft 365, Resend", async () => {
    const host = await mount();
    expect(cardIds(host)).toEqual(["ai", "xero", "microsoft", "resend"]);
    const titles = [...host.querySelectorAll('[id^="setup-title-"]')].map((el) => el.textContent);
    expect(titles).toEqual(["AI", "Xero", "Microsoft 365", "Resend"]);
  });

  it("every activation is Off by default and no switch is on", async () => {
    const host = await mount();
    for (const id of ["ai", "xero", "microsoft", "resend"]) {
      const badge = host.querySelector(`[data-testid="activation-badge-${id}"]`)?.textContent ?? "";
      expect(badge, id).toMatch(/: Off$/);
      const sw = host.querySelector(`[data-testid="activation-${id}"] [role="switch"]`);
      expect(sw, id).not.toBeNull();
      expect(sw?.getAttribute("aria-checked"), id).toBe("false");
    }
    expect(host.querySelectorAll('[role="switch"][aria-checked="true"]').length).toBe(0);
  });

  it("Microsoft 365 and Resend have no switch the page could turn on: the control stays disabled even when the server reports them ready", async () => {
    ANSWERS["/api/integrations/resend"] = { state: "connected", message: "Key accepted", sender: "noreply@example.test" };
    const host = await mount();
    for (const id of ["microsoft", "resend"]) {
      const sw = host.querySelector(`[data-testid="activation-${id}"] [role="switch"]`) as HTMLButtonElement;
      expect(sw.disabled, id).toBe(true);
      expect(host.querySelector(`[data-testid="activation-why-${id}"]`)?.textContent, id).toMatch(/no separate switch/i);
    }
    ANSWERS["/api/integrations/resend"] = { state: "not_configured", message: "Not set up on this server", sender: null };
  });

  it("puts the e-mail guide above the Microsoft 365 and Resend cards, after AI and Xero", async () => {
    const host = await mount();
    const order = (id: string) => host.innerHTML.indexOf(`data-testid="${id}"`);
    expect(order("email-choice-guide")).toBeGreaterThan(order("setup-card-xero"));
    expect(order("email-choice-guide")).toBeLessThan(order("setup-card-microsoft"));
    expect(order("email-choice-guide")).toBeLessThan(order("setup-card-resend"));
  });

  it("has a More section after the cards that keeps the earlier cards", async () => {
    const host = await mount();
    const more = host.querySelector('[data-testid="integrations-more"]');
    expect(more).not.toBeNull();
    expect(more?.querySelector("h2")?.textContent).toBe("More");
    expect(host.innerHTML.indexOf('data-testid="integrations-more"')).toBeGreaterThan(host.innerHTML.indexOf('data-testid="setup-card-resend"'));
    const text = more?.textContent ?? "";
    expect(text).toContain("Xero: send now and the accountant's link");
    expect(text).toMatch(/accountant/i);
    // the four guided cards are not repeated inside More, and nothing in More duplicates the Connect buttons
    expect(more?.querySelector('[data-testid^="setup-card-"]')).toBeNull();
    expect(more?.querySelector('[data-testid="microsoft-card"]')).toBeNull();
    expect([...more!.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Connect to Xero");
    expect(host.querySelector('[data-testid="integrations-company"]')?.textContent).toContain("Example Co");
  });

  it("has ONE AI on/off: the AI card's switch; More has no AI master switch, feature boxes or Tolra button, only a pointer to /ai-helper", async () => {
    const host = await mount();
    expect([...host.querySelectorAll('[role="switch"]')].filter((el) => el.getAttribute("aria-labelledby") === "activation-label-ai").length).toBe(1);
    expect(host.querySelector('[data-testid="ai-master-switch"]')).toBeNull();
    expect(host.textContent).not.toContain("Turn Tolra AI");
    expect(host.textContent).not.toContain("AI on for this company");
    expect(host.textContent).not.toMatch(/Round-up|RFQ email to draft quote|finance check/i);
    const note = host.querySelector('[data-testid="ai-more-note"]');
    expect(note?.closest('[data-testid="integrations-more"]')).not.toBeNull();
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/ai-helper");
  });

  it("renders no secret-shaped text", async () => {
    const host = await mount();
    expect(host.innerHTML).not.toMatch(/sk-ant-|client_secret|refresh_token|access_token|re_[A-Za-z0-9]{10,}/);
    expect(host.querySelectorAll('input[type="text"][value]').length).toBe(0);
  });

  it.each(["office", "workshop", "viewer"])("%s gets Access Denied and nothing of the page", (role) => {
    user.activeRole = role;
    const html = renderToStaticMarkup(createElement(AdminIntegrationsPage));
    expect(html).toContain("Access Denied");
    expect(html).not.toContain("setup-card-");
    expect(html).not.toContain("Xero");
    expect(html).not.toContain("More");
  });
});
