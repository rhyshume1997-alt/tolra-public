// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/components/xero-mappings", () => ({ XeroMappings: (p: { connected: boolean; unmapped: string[] }) => createElement("div", { "data-testid": "mappings", "data-connected": String(p.connected), "data-unmapped": p.unmapped.length }) }));

import { XeroSetupCard, XeroSetupCardView, type XeroSetupCardViewProps } from "@/components/integrations/xero-setup-card";
import type { IntegrationOverview } from "@/lib/integrations/overview";
import { HOLD_NOT_APPROVED, NOT_SET_UP, SENDS_AUTOMATICALLY, TRANSFERS_ON_TEXT, activationFor, serverBehaviour, type LaunchHold } from "@/lib/integrations/xero-setup-state";

const ov = (o: Partial<IntegrationOverview> = {}): IntegrationOverview => ({ provider: "xero", status: "connected", tenant_name: "Marpet Ltd (Xero)", connected_at: "2026-11-01T10:00:00Z", status_reason: null, unmapped: [], counts: {}, contact_problems: 0, ...o });

async function render(node: ReturnType<typeof createElement>, settle = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(node));
  if (settle) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const view = (p: XeroSetupCardViewProps, settle = false) => render(createElement(XeroSetupCardView, p), settle);
const t = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const sw = (host: HTMLElement) => host.querySelector('[role="switch"]') as HTMLButtonElement;
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe("Xero setup card: every state says what the server really does", () => {
  it("loading: nothing is claimed", async () => {
    const { host, done } = await view({ configured: null, overview: null });
    expect(t(host, "xero-behaviour")).toContain("Checking");
    expect(host.querySelector('[data-testid="activation-badge-xero"]')?.textContent).toBe("transfers: Unknown");
    expect(button(host, "Connect to Xero")?.disabled).toBe(true);
    await done();
  });

  it("not set up on this server: 'nothing is sent', Connect is disabled", async () => {
    const { host, done } = await view({ configured: false, overview: ov({ status: "not_connected", tenant_name: null }), onConnect: vi.fn() });
    expect(t(host, "xero-behaviour")).toBe(NOT_SET_UP);
    expect(NOT_SET_UP).toBe("Xero is not set up on this server: nothing is sent.");
    expect(button(host, "Connect to Xero")?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="activation-badge-xero"]')?.textContent).toBe("transfers: Off");
    await done();
  });

  it("not connected: Connect works; nothing is sent; no tenant, no mappings", async () => {
    const onConnect = vi.fn();
    const { host, done } = await view({ configured: true, overview: ov({ status: "not_connected", tenant_name: null }), onConnect });
    expect(t(host, "xero-behaviour")).toBe("This company is not connected to Xero: nothing is sent.");
    expect(t(host, "connection-xero")).toContain("Not signed in to Xero");
    expect(host.querySelector('[data-testid="mappings"]')).toBeNull();
    expect(host.querySelector('[data-testid="xero-tenant"]')).toBeNull();
    await act(async () => button(host, "Connect to Xero")!.click());
    expect(onConnect).toHaveBeenCalledOnce();
    await done();
  });

  it("connected but unmapped: shows the count, says nothing is sent, and that transfers cannot be turned on while any is unmapped", async () => {
    const { host, done } = await view({ configured: true, overview: ov({ unmapped: ["account:sales", "account:credit", "vat:20"] }) });
    expect(t(host, "xero-behaviour")).toBe("This company is connected but 3 items are not mapped: nothing is sent until every one is mapped.");
    expect(t(host, "xero-unmapped")).toContain("3 unmapped. Transfers cannot be turned on while any is unmapped.");
    expect(host.querySelector('[data-testid="mappings"]')?.getAttribute("data-unmapped")).toBe("3");
    expect(host.querySelector('[data-testid="mappings"]')?.getAttribute("data-connected")).toBe("true");
    expect(host.querySelector('[data-testid="activation-badge-xero"]')?.textContent).toBe("transfers: Off");
    await done();
  });

  it("connected and mapped (server has credentials): says plainly that transfers happen automatically; the switch cannot change it", async () => {
    const onSwitch = vi.fn();
    const { host, done } = await view({ configured: true, overview: ov(), onSwitch });
    expect(t(host, "xero-behaviour")).toBe("This company is connected and mapped: transfers happen automatically when invoices are issued.");
    expect(host.querySelector('[data-testid="activation-badge-xero"]')?.textContent).toBe("transfers: On");
    expect(sw(host).disabled).toBe(true);
    await act(async () => sw(host).click());
    expect(onSwitch).not.toHaveBeenCalled();
    expect(t(host, "xero-tenant")).toContain("Marpet Ltd (Xero)");
    expect(t(host, "xero-tenant")).toContain("Bound to this Tolra company only");
    await done();
  });

  it("connected and mapped but the server has NO Xero credentials: nothing is sent (never the 'automatic' sentence)", async () => {
    const { host, done } = await view({ configured: false, overview: ov() });
    expect(t(host, "xero-behaviour")).toBe(NOT_SET_UP);
    expect(host.textContent).not.toContain("transfers happen automatically");
    await done();
  });

  it("needs_reconnect: nothing is sent, Connect again is offered, the old organisation is named", async () => {
    const onConnect = vi.fn();
    const { host, done } = await view({ configured: true, overview: ov({ status: "needs_reconnect" }), onConnect });
    expect(t(host, "xero-behaviour")).toContain("connect again");
    expect(t(host, "connection-xero")).toContain("Needs connecting again (was Marpet Ltd (Xero))");
    await act(async () => button(host, "Connect again")!.click());
    expect(onConnect).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="activation-badge-xero"]')?.textContent).toBe("transfers: Off");
    await done();
  });

  it("error reading the status: the card says it does not know; never 'On' and never 'automatically'", async () => {
    const { host, done } = await view({ configured: true, overview: null, loadError: true, actionError: "Could not start the connection to Xero." });
    expect(t(host, "xero-behaviour")).toContain("not known here");
    expect(host.querySelector('[data-testid="activation-badge-xero"]')?.textContent).toBe("transfers: Unknown");
    expect(t(host, "xero-action-error")).toBe("Could not start the connection to Xero.");
    expect(host.textContent).not.toContain("transfers happen automatically");
    await done();
  });

  it("tenant held by another company: a plain error", async () => {
    const { host, done } = await view({ configured: true, overview: ov({ status: "not_connected", tenant_name: null }), outcome: "tenant_in_use" });
    const text = t(host, "xero-outcome")!;
    expect(text).toContain("That Xero organisation is already connected to another company in Tolra.");
    expect(host.querySelector('[data-testid="xero-outcome"]')?.getAttribute("role")).toBe("alert");
    await done();
  });

  it("a successful return says so, other failures are alerts", async () => {
    const a = await view({ configured: true, overview: ov(), outcome: "connected" });
    expect(t(a.host, "xero-outcome")).toBe("All connected: Xero.");
    await a.done();
    const b = await view({ configured: true, overview: ov({ status: "not_connected" }), outcome: "forbidden" });
    expect(t(b.host, "xero-outcome")).toContain("authenticator code");
    await b.done();
  });

  it("the switch is disabled with the plain reason by default (no launch hold), and a click changes nothing", async () => {
    const onSwitch = vi.fn();
    const { host, done } = await view({ configured: true, overview: ov(), onSwitch });
    expect(sw(host).disabled).toBe(true);
    expect(t(host, "activation-why-xero")).toBe(HOLD_NOT_APPROVED);
    expect(HOLD_NOT_APPROVED).toBe("Transfers cannot be switched on from here yet: the Xero launch hold (release 149) has not been approved.");
    await act(async () => sw(host).click());
    expect(onSwitch).not.toHaveBeenCalled();
    expect(t(host, "setup-card-xero")).toContain("Server emergency disable");
    await done();
  });

  it("Disconnect and Check are offered only when connected", async () => {
    const { host, done } = await view({ configured: true, overview: ov(), check: { ok: true, text: "Working: Marpet Ltd (Xero)" }, onDisconnect: vi.fn(), onCheck: vi.fn() });
    expect(button(host, "Disconnect")).toBeTruthy();
    expect(button(host, "Check with Xero")).toBeTruthy();
    expect(t(host, "xero-check-result")).toBe("Working: Marpet Ltd (Xero)");
    await done();
    const n = await view({ configured: true, overview: ov({ status: "not_connected" }) });
    expect(button(n.host, "Disconnect")).toBeUndefined();
    expect(button(n.host, "Check with Xero")).toBeUndefined();
    await n.done();
  });
});

describe("launchHold prop (the wiring point for #403): both modes", () => {
  const hold = (p: Partial<LaunchHold> = {}): LaunchHold => ({ available: true, on: false, set: vi.fn(), ...p });

  it("hold not available: disabled, with its own reason", async () => {
    const { host, done } = await view({ configured: true, overview: ov(), launchHold: hold({ available: false }), onSwitch: vi.fn() });
    expect(sw(host).disabled).toBe(true);
    expect(t(host, "activation-why-xero")).toContain("launch hold is not available");
    await done();
  });

  it("hold available, off, connected and mapped: the switch is enabled and turns ON only when clicked", async () => {
    const onSwitch = vi.fn();
    const { host, done } = await view({ configured: true, overview: ov(), launchHold: hold(), onSwitch });
    expect(host.querySelector('[data-testid="activation-badge-xero"]')?.textContent).toBe("transfers: Off");
    expect(sw(host).disabled).toBe(false);
    expect(host.querySelector('[data-testid="activation-why-xero"]')).toBeNull();
    await act(async () => sw(host).click());
    expect(onSwitch).toHaveBeenCalledWith(true);
    await done();
  });

  it("hold available, off, but unmapped: stays disabled and says transfers cannot be turned on while anything is unmapped", async () => {
    const onSwitch = vi.fn();
    const { host, done } = await view({ configured: true, overview: ov({ unmapped: ["vat:20"] }), launchHold: hold(), onSwitch });
    expect(sw(host).disabled).toBe(true);
    expect(t(host, "activation-why-xero")).toBe("Transfers cannot be turned on while anything is unmapped.");
    await act(async () => sw(host).click());
    expect(onSwitch).not.toHaveBeenCalled();
    await done();
  });

  it("hold available, on: may be turned off even when something later became unmapped", async () => {
    const onSwitch = vi.fn();
    const { host, done } = await view({ configured: true, overview: ov({ unmapped: ["vat:5"] }), launchHold: hold({ on: true }), onSwitch });
    expect(host.querySelector('[data-testid="activation-badge-xero"]')?.textContent).toBe("transfers: On");
    expect(sw(host).disabled).toBe(false);
    await act(async () => sw(host).click());
    expect(onSwitch).toHaveBeenCalledWith(false);
    await done();
  });

  it("hold unknown (on null) is Unknown, not on", () => {
    expect(activationFor({ configured: true, overview: ov(), launchHold: hold({ on: null }) }).on).toBeNull();
  });

  it("not connected / needs_reconnect with a hold: cannot turn on, says to connect first", () => {
    expect(activationFor({ configured: true, overview: ov({ status: "not_connected" }), launchHold: hold() }, false, vi.fn()).disabledReason).toBe("Connect to Xero first.");
    expect(activationFor({ configured: true, overview: ov({ status: "needs_reconnect" }), launchHold: hold() }, false, vi.fn()).disabledReason).toBe("Connect to Xero again first.");
  });
});

describe("serverBehaviour (pure)", () => {
  it("the only 'sends' state is credentials + connected + nothing unmapped", () => {
    const kinds = [
      [{ configured: false, overview: ov() }, "not_set_up"], [{ configured: true, overview: ov({ status: "disconnected" }) }, "not_connected"],
      [{ configured: true, overview: ov({ status: "needs_reconnect" }) }, "needs_reconnect"], [{ configured: true, overview: ov({ unmapped: ["account:sales"] }) }, "unmapped"],
      [{ configured: true, overview: ov() }, "sends"], [{ configured: null, overview: null }, "loading"], [{ configured: true, overview: null, loadError: true }, "unknown"],
    ] as const;
    for (const [input, kind] of kinds) expect(serverBehaviour(input).kind).toBe(kind);
    expect(serverBehaviour({ configured: true, overview: ov() }).text).toBe(SENDS_AUTOMATICALLY);
  });
});

describe("XeroSetupCard (container): reads the real status and uses the existing routes", () => {
  beforeEach(() => { rpc.mockReset(); });
  function mockFetch(handlers: Record<string, () => { status?: number; body: unknown }>) {
    const calls: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET" });
      const h = handlers[path];
      const r = h ? h() : { status: 404, body: {} };
      return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
    }));
    return calls;
  }

  it("connected and mapped on a server with credentials, and the server's transfer switch (release 149) reads ON: says so from what the server reported", async () => {
    rpc.mockResolvedValue({ data: ov(), error: null });
    mockFetch({
      "/api/integrations/status": () => ({ body: { db107: true, xero: { configured: true }, microsoft: { configured: false } } }),
      "/api/integrations/xero/launch": () => ({ body: { enabled: true, connected: true, mapped: true, status: "connected" } }),
    });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }), true);
    expect(rpc).toHaveBeenCalledWith("integration_overview", { p_provider: "xero" });
    expect(t(host, "xero-behaviour")).toBe(TRANSFERS_ON_TEXT);
    expect(sw(host).disabled).toBe(false);
    await done();
  });

  it("no credentials on the server: 'not set up'", async () => {
    rpc.mockResolvedValue({ data: ov(), error: null });
    mockFetch({ "/api/integrations/status": () => ({ body: { db107: true, xero: { configured: false }, microsoft: { configured: false } } }) });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }), true);
    expect(t(host, "xero-behaviour")).toBe(NOT_SET_UP);
    await done();
  });

  it("a failed status read or overview read is shown as unknown, never as set up", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "x" } });
    mockFetch({ "/api/integrations/status": () => ({ status: 500, body: {} }) });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }), true);
    expect(host.querySelector('[data-testid="xero-behaviour"]')?.getAttribute("data-kind")).toBe("unknown");
    await done();
  });

  it("Check with Xero reads the organisation name through the existing test route; a Xero error is shown as it came", async () => {
    rpc.mockResolvedValue({ data: ov(), error: null });
    let ok = true;
    const calls = mockFetch({
      "/api/integrations/status": () => ({ body: { db107: true, xero: { configured: true }, microsoft: { configured: false } } }),
      "/api/integrations/xero/test": () => (ok ? { body: { ok: true, name: "Marpet Ltd (Xero)", message: "Working: Marpet Ltd (Xero)" } } : { status: 502, body: { error: "Xero refused the sign-in." } }),
    });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }), true);
    await act(async () => { button(host, "Check with Xero")!.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(t(host, "xero-check-result")).toBe("Working: Marpet Ltd (Xero)");
    ok = false;
    await act(async () => { button(host, "Check with Xero")!.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(t(host, "xero-check-result")).toBe("Xero refused the sign-in.");
    expect(calls.filter((c) => c.path === "/api/integrations/xero/test").every((c) => c.method === "POST")).toBe(true);
    await done();
  });

  it("Connect posts to the existing connect route and shows a refusal (e.g. the second step of sign-in) plainly", async () => {
    rpc.mockResolvedValue({ data: ov({ status: "not_connected", tenant_name: null }), error: null });
    const calls = mockFetch({
      "/api/integrations/status": () => ({ body: { db107: true, xero: { configured: true }, microsoft: { configured: false } } }),
      "/api/integrations/xero/connect": () => ({ status: 403, body: { error: "Confirm your authenticator code first." } }),
    });
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null }), true);
    await act(async () => { button(host, "Connect to Xero")!.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toContainEqual({ path: "/api/integrations/xero/connect", method: "POST" });
    expect(t(host, "xero-action-error")).toBe("Confirm your authenticator code first.");
    await done();
  });

  it("with a launchHold wired in, flipping the switch calls set(true) and re-reads the overview", async () => {
    rpc.mockResolvedValue({ data: ov(), error: null });
    mockFetch({ "/api/integrations/status": () => ({ body: { db107: true, xero: { configured: true }, microsoft: { configured: false } } }) });
    const set = vi.fn(async () => undefined);
    const { host, done } = await render(createElement(XeroSetupCard, { outcome: null, launchHold: { available: true, on: false, set } }), true);
    const before = rpc.mock.calls.length;
    await act(async () => { sw(host).click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(set).toHaveBeenCalledWith(true);
    expect(rpc.mock.calls.length).toBeGreaterThan(before);
    await done();
  });
});
