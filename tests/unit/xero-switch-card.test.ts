// @vitest-environment jsdom
// The Xero card's "Turn on transfers" switch is the real, server-held transfer switch (release 149): read from /api/integrations/xero/launch,
// OFF by default, enabled only when connected and mapped, turned on with the recent-code prompt, and the card never confuses Connected with On.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const requestCode = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/components/authenticator-code-dialog", () => ({ useCodePrompt: () => ({ requestCode, codeDialog: null }) }));
vi.mock("@/components/xero-mappings", () => ({ XeroMappings: () => createElement("div", { "data-testid": "mappings" }) }));

import { XeroSetupCard } from "@/components/integrations/xero-setup-card";
import type { IntegrationOverview } from "@/lib/integrations/overview";
import { HELD_TEXT, HOLD_UNREADABLE, TRANSFERS_ON_TEXT, TRANSFERS_NEED_MAPPING } from "@/lib/integrations/xero-setup-state";

const ov = (o: Partial<IntegrationOverview> = {}): IntegrationOverview => ({ provider: "xero", status: "connected", tenant_name: "Marpet Ltd (Xero)", connected_at: "2026-11-01T10:00:00Z", status_reason: null, unmapped: [], counts: {}, contact_problems: 0, ...o });
async function render(node: ReturnType<typeof createElement>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(node));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const t = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const sw = (host: HTMLElement) => host.querySelector('[role="switch"]') as HTMLButtonElement;
const badge = (host: HTMLElement) => t(host, "activation-badge-xero");
const dialogButton = (label: string) => Array.from(document.body.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
/** Flip the switch ON: the confirm dialog names the organisation; confirming sends the request. */
const turnOn = async (host: HTMLElement) => {
  await act(async () => { sw(host).click(); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { dialogButton("Turn on transfers")!.click(); await new Promise((r) => setTimeout(r, 0)); });
};
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

type Posted = { enabled: boolean; confirmTenantId?: string };
/** A server with a transfer switch: GET reads it, POST sets it (or answers what the test says). */
function server(opts: { enabled?: boolean; readStatus?: number; post?: Array<{ status: number; body: unknown }> } = {}) {
  let enabled = opts.enabled ?? false;
  const posts: Posted[] = [];
  const queue = [...(opts.post ?? [])];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/integrations/status") return { ok: true, status: 200, json: async () => ({ db107: true, xero: { configured: true }, microsoft: { configured: false } }) };
    if (path === "/api/integrations/xero/launch" && (init?.method ?? "GET") === "GET") {
      const status = opts.readStatus ?? 200;
      return { ok: status < 400, status, json: async () => ({ enabled, connected: true, mapped: true, status: "connected", organisation: { tenantId: "t-a", name: "Org A Ltd" } }) };
    }
    if (path === "/api/integrations/xero/launch") {
      const body = JSON.parse(String(init?.body)) as Posted; posts.push(body);
      const next = queue.shift() ?? { status: 200, body: { enabled: body.enabled } };
      if (next.status < 400) enabled = body.enabled;
      return { ok: next.status < 400, status: next.status, json: async () => next.body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  return { posts };
}
beforeEach(() => { rpc.mockReset(); requestCode.mockReset(); rpc.mockResolvedValue({ data: ov(), error: null }); });

describe("Connected is not On", () => {
  it("connected and mapped, switch off: says so plainly, the badge is Off, the switch is enabled but not on", async () => {
    server({ enabled: false });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    expect(t(host, "xero-behaviour")).toBe(HELD_TEXT);
    expect(t(host, "connection-xero")).toContain("Signed in is not the same as allowed to transfer");
    expect(badge(host)).toBe("transfers: Off");
    expect(sw(host).disabled).toBe(false);
    expect(sw(host).getAttribute("aria-checked")).toBe("false");
    await done();
  });
  it("a server that has it ON shows On", async () => {
    server({ enabled: true });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    expect(t(host, "xero-behaviour")).toBe(TRANSFERS_ON_TEXT);
    expect(badge(host)).toBe("transfers: On");
    await done();
  });
  it("unmapped: the switch is disabled and says why", async () => {
    server({ enabled: false });
    rpc.mockResolvedValue({ data: ov({ unmapped: ["vat:20"] }), error: null });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    expect(sw(host).disabled).toBe(true);
    expect(t(host, "activation-why-xero")).toBe(TRANSFERS_NEED_MAPPING);
    await done();
  });
  it("not connected and needs_reconnect: the switch is disabled", async () => {
    for (const status of ["not_connected", "needs_reconnect"] as const) {
      server({ enabled: false });
      rpc.mockResolvedValue({ data: ov({ status }), error: null });
      const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
      expect(sw(host).disabled).toBe(true);
      expect(badge(host)).toBe("transfers: Off");
      await done();
    }
  });
  it("the switch cannot be read: Off, disabled, and the card says nothing is sent (never On, never 'automatically')", async () => {
    server({ readStatus: 503 });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    expect(t(host, "xero-behaviour")).toBe(HOLD_UNREADABLE);
    expect(badge(host)).toBe("transfers: Off");
    expect(sw(host).disabled).toBe(true);
    expect(host.textContent).not.toContain("transfers happen automatically");
    await done();
  });
});

describe("turning it on and off", () => {
  it("ON asks for a code when the server says so, then sends the same request once more; the card re-reads the switch", async () => {
    const s = server({ enabled: false, post: [{ status: 403, body: { code: "mfa_recent_required", error: "fresh code" } }] });
    requestCode.mockResolvedValue(true);
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    await turnOn(host);
    await settle();
    expect(requestCode).toHaveBeenCalledOnce();
    expect(s.posts).toEqual([{ enabled: true, confirmTenantId: "t-a" }, { enabled: true, confirmTenantId: "t-a" }]);
    expect(badge(host)).toBe("transfers: On");
    expect(t(host, "xero-behaviour")).toBe(TRANSFERS_ON_TEXT);
    await done();
  });
  it("a cancelled code sends nothing more and the switch stays Off", async () => {
    const s = server({ enabled: false, post: [{ status: 403, body: { code: "mfa_recent_required" } }] });
    requestCode.mockResolvedValue(false);
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    await turnOn(host);
    await settle();
    expect(s.posts).toEqual([{ enabled: true, confirmTenantId: "t-a" }]);
    expect(badge(host)).toBe("transfers: Off");
    expect(t(host, "xero-action-error")).toBe("Cancelled. Nothing was changed.");
    await done();
  });
  it("the server's refusal is shown as it came and the switch stays Off", async () => {
    server({ enabled: false, post: [{ status: 409, body: { error: "Finish the Xero mapping first." } }] });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    await turnOn(host);
    await settle();
    expect(requestCode).not.toHaveBeenCalled();
    expect(t(host, "xero-action-error")).toBe("Finish the Xero mapping first.");
    expect(badge(host)).toBe("transfers: Off");
    await done();
  });
  it("ON opens a dialog naming the organisation first and sends nothing until it is confirmed; cancelling sends nothing and the switch stays Off", async () => {
    const s = server({ enabled: false });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    await act(async () => { sw(host).click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Turn on transfers to Xero organisation Org A Ltd?");
    expect(s.posts).toEqual([]);
    await act(async () => { dialogButton("Cancel")!.click(); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
    expect(s.posts).toEqual([]);
    expect(requestCode).not.toHaveBeenCalled();
    expect(badge(host)).toBe("transfers: Off");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await done();
  });
  it("OFF is one click, no code prompt", async () => {
    const s = server({ enabled: true });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }));
    await act(async () => { sw(host).click(); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
    expect(requestCode).not.toHaveBeenCalled();
    expect(s.posts).toEqual([{ enabled: false }]);
    expect(badge(host)).toBe("transfers: Off");
    await done();
  });
});
