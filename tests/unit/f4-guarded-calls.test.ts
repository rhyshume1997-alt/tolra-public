// @vitest-environment jsdom
/**
 * W-F4: the legacy Integrations components wrap their guarded calls in the code prompt. For each call: the first answer is the server's
 * 403 mfa_recent_required, so the prompt is asked ONCE and the same request is sent ONCE more (no loop); a cancelled prompt sends nothing more;
 * the prompt's dialog is mounted. Calls: Microsoft connect, disconnect and admin-consent (MicrosoftConnectCard), Xero connect and disconnect
 * (IntegrationsPanel, /api/accounting/xero/*), and the mapping save (XeroMappings). fetch and the Supabase client are stood in.
 */
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let search = "";
let overviewStatus = "not_connected";
const requestCode = vi.fn(async () => true);
vi.mock("@/components/authenticator-code-dialog", () => ({ useCodePrompt: () => ({ requestCode, codeDialog: createElement("div", { "data-testid": "code-dialog-mounted" }) }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const chain = (rows: unknown): unknown => new Proxy(() => undefined, { get: (_t, k) => (k === "then" ? (ok: (v: unknown) => unknown) => ok({ data: rows, error: null }) : chain(rows)), apply: () => chain(rows) });
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: async (fn: string, args: { p_provider?: string }) => ({
      data: fn === "integration_overview"
        ? { provider: args?.p_provider, status: overviewStatus, tenant_name: "Example", connected_at: "2026-11-01T10:00:00Z", status_reason: null, unmapped: [], counts: {} }
        : fn === "mailbox_sync_status" ? null : [],
      error: null,
    }),
    from: () => chain([]),
    auth: { getUser: async () => ({ data: { user: null } }) },
  },
}));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ profile: { id: "u-1", role: "admin" }, loading: false, activeRole: "admin", organizations: [{ organization_id: "o-1", name: "Example Co", slug: "ex", role: "admin", is_current: true }] }) }));
vi.mock("@/lib/db-features", async (original) => ({ ...(await original<object>()), databaseHas084: async () => true }));

import { IntegrationsPanel } from "@/components/integrations-panel";
import { MicrosoftConnectCard } from "@/components/microsoft-connect-card";
import { XeroMappings } from "@/components/xero-mappings";

const RECENT = { error: "Enter a fresh code.", code: "mfa_recent_required" };
type Call = { url: string; method: string };
let calls: Call[];
let script: Record<string, Array<{ status: number; body: unknown }>>;
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  search = ""; overviewStatus = "not_connected"; calls = []; script = {};
  requestCode.mockReset(); requestCode.mockImplementation(async () => true);
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).split("?")[0];
    calls.push({ url: path, method: init?.method ?? "GET" });
    if (path === "/api/integrations/status") return json(200, { db107: true, xero: { configured: true }, microsoft: { configured: true } });
    if (path === "/api/integrations/xero/mappings" && (init?.method ?? "GET") === "GET") return json(200, { accounts: [{ code: "200", name: "Sales", type: "REVENUE", revenue: true }], taxRates: [] });
    const next = script[path]?.shift();
    return next ? json(next.status, next.body) : json(200, {});
  }) as typeof fetch;
});
afterEach(() => { document.body.innerHTML = ""; });

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div"); document.body.append(host);
  await act(async () => createRoot(host).render(el));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return host;
}
const button = (name: string | RegExp, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent === name : name.test(b.textContent ?? ""))) as HTMLButtonElement;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 20)); }); };
const posts = (path: string) => calls.filter((c) => c.url === path && c.method === "POST").length;
const ms = (a: string) => `/api/integrations/microsoft/${a}`;
const recentThenOk = (path: string) => { script[path] = [{ status: 403, body: RECENT }, { status: 200, body: {} }]; };

describe("Microsoft 365 card (components/microsoft-connect-card.tsx)", () => {
  it("connect: recent code needed -> one prompt, the same request once more", async () => {
    recentThenOk(ms("connect"));
    const host = await mount(createElement(MicrosoftConnectCard, { status: { db107: true, xero: { configured: true }, microsoft: { configured: true } } }));
    expect(host.querySelector('[data-testid="code-dialog-mounted"]')).not.toBeNull();
    await click(button("Connect Microsoft 365", host));
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts(ms("connect"))).toBe(2);
  });

  it("connect: a cancelled prompt sends nothing more", async () => {
    recentThenOk(ms("connect")); requestCode.mockImplementation(async () => false);
    const host = await mount(createElement(MicrosoftConnectCard, { status: { db107: true, xero: { configured: true }, microsoft: { configured: true } } }));
    await click(button("Connect Microsoft 365", host));
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts(ms("connect"))).toBe(1);
  });

  it("connect: still refused after the code is final (no second prompt)", async () => {
    script[ms("connect")] = [{ status: 403, body: RECENT }, { status: 403, body: RECENT }];
    const host = await mount(createElement(MicrosoftConnectCard, { status: { db107: true, xero: { configured: true }, microsoft: { configured: true } } }));
    await click(button("Connect Microsoft 365", host));
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts(ms("connect"))).toBe(2);
  });

  it("disconnect (after the confirmation): one prompt, the same request once more", async () => {
    overviewStatus = "connected"; recentThenOk(ms("disconnect"));
    const host = await mount(createElement(MicrosoftConnectCard, { status: { db107: true, xero: { configured: true }, microsoft: { configured: true } } }));
    await click(button("Disconnect", host));
    const confirmButtons = [...document.querySelectorAll("button")].filter((b) => b.textContent === "Disconnect");
    await click(confirmButtons[confirmButtons.length - 1]);
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts(ms("disconnect"))).toBe(2);
  });

  it("admin-consent link: one prompt, the same request once more", async () => {
    search = "microsoft=consent_blocked";
    script[ms("admin-consent")] = [{ status: 403, body: RECENT }, { status: 200, body: { url: "https://login.example.test/adminconsent", mailto: "mailto:x@example.test", permissions: [], expiresAt: "" } }];
    const host = await mount(createElement(MicrosoftConnectCard, { status: { db107: true, xero: { configured: true }, microsoft: { configured: true } } }));
    await click(button("Get the link for your Microsoft admin", host));
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts(ms("admin-consent"))).toBe(2);
    expect((host.querySelector('input[aria-label="Link for your Microsoft admin"]') as HTMLInputElement | null)?.value).toBe("https://login.example.test/adminconsent");
  });
});

describe("Xero on the panel (components/integrations-panel.tsx, /api/accounting/xero/*)", () => {
  it("connect: one prompt, the same request once more", async () => {
    recentThenOk("/api/accounting/xero/connect");
    const host = await mount(createElement(IntegrationsPanel));
    expect(host.querySelector('[data-testid="code-dialog-mounted"]')).not.toBeNull();
    await click(button("Connect to Xero", host));
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts("/api/accounting/xero/connect")).toBe(2);
  });

  it("connect: a cancelled prompt sends nothing more", async () => {
    recentThenOk("/api/accounting/xero/connect"); requestCode.mockImplementation(async () => false);
    const host = await mount(createElement(IntegrationsPanel));
    await click(button("Connect to Xero", host));
    expect(posts("/api/accounting/xero/connect")).toBe(1);
  });

  it("disconnect (after the confirmation): one prompt, the same request once more", async () => {
    overviewStatus = "connected"; recentThenOk("/api/accounting/xero/disconnect");
    const host = await mount(createElement(IntegrationsPanel));
    await click(button("Disconnect", host));
    const confirmButtons = [...document.querySelectorAll("button")].filter((b) => b.textContent === "Disconnect");
    await click(confirmButtons[confirmButtons.length - 1]);
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts("/api/accounting/xero/disconnect")).toBe(2);
  });
});

describe("Xero mappings save (components/xero-mappings.tsx)", () => {
  const choose = async (host: Element) => {
    const select = host.querySelector('select[aria-label="Sales account"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "200");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
  };

  it("recent code needed -> one prompt, the same save once more, with the same body", async () => {
    recentThenOk("/api/integrations/xero/mappings");
    const bodies: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => { if (init?.method === "POST") bodies.push(String(init.body)); return inner(url, init); }) as typeof fetch;
    const host = await mount(createElement(XeroMappings, { connected: true, unmapped: [], onChanged: () => undefined }));
    expect(host.querySelector('[data-testid="code-dialog-mounted"]')).not.toBeNull();
    await choose(host);
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts("/api/integrations/xero/mappings")).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0])).toEqual({ kind: "sales_account", tolraKey: "", code: "200" });
  });

  it("a cancelled prompt sends nothing more", async () => {
    recentThenOk("/api/integrations/xero/mappings"); requestCode.mockImplementation(async () => false);
    const host = await mount(createElement(XeroMappings, { connected: true, unmapped: [], onChanged: () => undefined }));
    await choose(host);
    expect(posts("/api/integrations/xero/mappings")).toBe(1);
  });
});
