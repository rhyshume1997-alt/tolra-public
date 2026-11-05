// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const getUser = vi.fn(async () => ({ data: { user: { email: "admin@a.test" } } }));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), auth: { getUser: () => getUser() } } }));
let search = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const requestCode = vi.fn(async () => true);
vi.mock("@/components/authenticator-code-dialog", () => ({ useCodePrompt: () => ({ requestCode, codeDialog: null }) }));

import { MicrosoftSetupCard } from "@/components/integrations/microsoft-setup-card";
import { ResendSetupCard } from "@/components/integrations/resend-setup-card";

type Route = (url: string, init?: RequestInit) => { status: number; body: unknown } | "network";
let route: Route;
const calls: Array<{ url: string; method: string }> = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls.length = 0; search = ""; rpc.mockReset(); rpc.mockImplementation(async () => ({ data: { provider: "microsoft", status: "not_connected", tenant_name: null, connected_at: null, status_reason: null, unmapped: [], counts: {}, contact_problems: 0 }, error: null })); requestCode.mockClear(); requestCode.mockImplementation(async () => true);
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const r = route(String(url), init);
    if (r === "network") throw new Error("offline");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  }) as typeof fetch;
});
afterEach(() => { document.body.innerHTML = ""; });

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(el));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}
const text = (host: Element, id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined) => { await act(async () => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); }); };

const okStatus = { db107: true, xero: { configured: false }, microsoft: { configured: true } };
const overview = (o: Record<string, unknown>) => rpc.mockImplementation(async () => ({ data: { provider: "microsoft", status: "not_connected", tenant_name: null, connected_at: null, status_reason: null, unmapped: [], counts: {}, contact_problems: 0, ...o }, error: null }));

describe("MicrosoftSetupCard: every connection state", () => {
  it("loading while the status is unknown", async () => {
    const h = await mount(createElement(MicrosoftSetupCard, { status: null }));
    expect(text(h, "connection-microsoft")).toContain("Checking");
    expect(h.querySelector('[data-testid="activation-badge-microsoft"]')?.textContent).toBe("Sending: Unknown");
  });
  it("database update missing", async () => {
    const h = await mount(createElement(MicrosoftSetupCard, { status: { ...okStatus, db107: false } }));
    expect(text(h, "connection-microsoft")).toContain("database update 107");
    expect(button("Connect Microsoft 365")).toBeUndefined();
  });
  it("not set up on this server: Connect not offered, no approval link offered", async () => {
    const h = await mount(createElement(MicrosoftSetupCard, { status: { ...okStatus, microsoft: { configured: false } } }));
    expect(text(h, "connection-microsoft")).toContain("Not set up on this server");
    expect(button("Connect Microsoft 365")?.disabled).toBe(true);
    expect(h.querySelector('[data-testid="microsoft-admin-approval"]')).toBeNull();
  });
  it("not connected: step 1 is next, Connect works, Sending is Off", async () => {
    overview({});
    const h = await mount(createElement(MicrosoftSetupCard, { status: okStatus }));
    expect(text(h, "connection-microsoft")).toContain("Not connected");
    expect(h.querySelector('li[data-state="next"]')?.textContent).toContain("Connect with your Microsoft work account");
    expect(button("Connect Microsoft 365")?.disabled).toBe(false);
    expect(button("Test")).toBeUndefined();
    expect(h.querySelector('[data-testid="activation-badge-microsoft"]')?.textContent).toBe("Sending: Off");
  });
  it("connected: signed in as the mailbox; Test runs and moves on; nothing says sending is automatic", async () => {
    overview({ status: "connected", tenant_name: "office@a.test", connected_at: "2026-11-01T10:00:00Z" });
    route = (url) => url.endsWith("/microsoft/test") ? { status: 200, body: { message: "Working: office@a.test" } } : { status: 404, body: {} };
    const h = await mount(createElement(MicrosoftSetupCard, { status: okStatus }));
    expect(text(h, "connection-microsoft")).toContain("Signed in as office@a.test");
    await click(button("Test"));
    expect(text(h, "microsoft-test-result")).toBe("Working: office@a.test");
    expect(calls.map((c) => c.url)).toEqual(["/api/integrations/microsoft/test"]);
    expect(h.textContent).toContain("every customer e-mail still needs approval");
  });
  it("needs reconnect", async () => {
    overview({ status: "needs_reconnect", tenant_name: "office@a.test", status_reason: "Microsoft 365 needs to be connected again." });
    const h = await mount(createElement(MicrosoftSetupCard, { status: okStatus }));
    expect(text(h, "connection-microsoft")).toContain("Needs reconnecting");
    expect(button("Reconnect")).toBeDefined();
    expect(button("Test")).toBeUndefined();
  });
  it("Disconnect asks first, then posts", async () => {
    overview({ status: "connected", tenant_name: "office@a.test" });
    route = () => ({ status: 200, body: { status: "disconnected" } });
    await mount(createElement(MicrosoftSetupCard, { status: okStatus }));
    await click(button("Disconnect"));
    expect(calls).toHaveLength(0);
    await click([...document.querySelectorAll("button")].filter((b) => b.textContent === "Disconnect").pop());
    expect(calls.map((c) => c.url)).toEqual(["/api/integrations/microsoft/disconnect"]);
  });
});

describe("MicrosoftSetupCard: the rules it states", () => {
  it("Sending is never a working switch, says why, and states one mailbox per company and no Resend fallback", async () => {
    overview({ status: "connected", tenant_name: "office@a.test" });
    const h = await mount(createElement(MicrosoftSetupCard, { status: okStatus }));
    const sw = h.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(h.querySelector('[data-testid="activation-badge-microsoft"]')?.textContent).toBe("Sending: On");
    expect(text(h, "activation-why-microsoft")).toContain("There is no separate switch");
    expect(h.textContent).toContain("Uses this mailbox once connected; every customer e-mail still needs approval.");
    expect(text(h, "microsoft-one-mailbox")).toBe("One mailbox per company: this company's mailbox is never shared with another company.");
    expect(h.textContent).toContain("does not switch to Resend by itself");
  });
  it("the admin-approval explanation has no link until asked; then shows the one-time link", async () => {
    overview({});
    route = () => ({ status: 200, body: { url: "https://login.microsoftonline.com/adminconsent?x=1", mailto: "mailto:a@b.test", permissions: [{ scope: "Mail.Send", text: "Send mail" }], expiresAt: "2026-11-06T00:00:00Z" } });
    const h = await mount(createElement(MicrosoftSetupCard, { status: okStatus }));
    expect(text(h, "microsoft-admin-approval")).toContain("an administrator must approve first");
    expect(h.querySelector("a, input")).toBeNull();
    await click(button("Get the link for your Microsoft admin"));
    expect((h.querySelector('input[aria-label="Link for your Microsoft admin"]') as HTMLInputElement).value).toContain("adminconsent");
    expect(text(h, "microsoft-approve-link")).toContain("Send mail");
  });
  it("after a blocked sign-in (?microsoft=consent_blocked) the card says an administrator must approve", async () => {
    overview({}); search = "microsoft=consent_blocked";
    const h = await mount(createElement(MicrosoftSetupCard, { status: okStatus }));
    expect(text(h, "microsoft-consent-blocked")).toContain("needs an administrator to approve");
  });
});

const rs = (state: string, extra: Record<string, unknown> = {}) => ({ state, message: `msg-${state}`, sender: "orders@mail.test", ...extra });
const statusRoute = (s: unknown, test?: Route): Route => (url, init) => url === "/api/integrations/resend" ? { status: 200, body: s } : (test ?? (() => ({ status: 404, body: {} })))(url, init);

describe("ResendSetupCard: every state", () => {
  it("not configured: says so, nothing can be checked or sent, platform-owner wording", async () => {
    route = statusRoute(rs("not_configured", { sender: null }));
    const h = await mount(createElement(ResendSetupCard, {}));
    expect(text(h, "connection-resend")).toContain("Not set up on this server");
    expect(button("Check domain")?.disabled).toBe(true);
    expect(button("Send a test e-mail to me")?.disabled).toBe(true);
    expect(h.textContent).toContain("not per company");
    expect(h.textContent).toContain("not a mailbox");
    expect(h.querySelector('[data-testid="activation-badge-resend"]')?.textContent).toBe("Sending: Off");
  });
  it("configured: domain not checked yet; Check domain posts the read-only test and moves to connected", async () => {
    route = (url, init) => url === "/api/integrations/resend" ? { status: 200, body: init?.method === "POST" ? rs("connected") : rs("configured") } : { status: 404, body: {} };
    const h = await mount(createElement(ResendSetupCard, {}));
    expect(text(h, "connection-resend")).toContain("domain has not been checked yet");
    await click(button("Check domain"));
    expect(text(h, "connection-resend")).toContain("sender domain verified");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/integrations/resend"]);
  });
  it("error shows the server's message; connected shows the sender and Sending On; the switch is always disabled with the approval wording", async () => {
    route = statusRoute(rs("error"));
    let h = await mount(createElement(ResendSetupCard, {}));
    expect(text(h, "connection-resend")).toContain("msg-error");
    document.body.innerHTML = "";
    route = statusRoute(rs("connected"));
    h = await mount(createElement(ResendSetupCard, {}));
    expect(text(h, "connection-resend")).toContain("orders@mail.test");
    expect(h.querySelector('[data-testid="activation-badge-resend"]')?.textContent).toBe("Sending: On");
    expect((h.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
    expect(h.textContent).toContain("Customer e-mails still need approval; there is no separate switch.");
    expect(h.textContent).toContain("never used automatically after a Microsoft 365 failure");
  });
  it("on Microsoft 365 the company does not use Resend: Off and a note", async () => {
    route = statusRoute(rs("connected"));
    const h = await mount(createElement(ResendSetupCard, { microsoftConnected: true }));
    expect(h.querySelector('[data-testid="activation-badge-resend"]')?.textContent).toBe("Sending: Off");
    expect(text(h, "resend-ms-note")).toContain("not used for it");
  });
  it("status call fails: an error state, never 'connected'", async () => {
    route = () => "network";
    const h = await mount(createElement(ResendSetupCard, {}));
    expect(text(h, "connection-resend")).toContain("Couldn't check Resend");
  });
});

describe("ResendSetupCard: the test send", () => {
  const testRoute = (answer: { status: number; body: unknown } | "network"): Route => statusRoute(rs("connected"), (url) => url === "/api/integrations/resend/test-send" ? answer : { status: 404, body: {} });
  const posts = () => calls.filter((c) => c.url.endsWith("/test-send"));

  it("nothing is sent until the dialog is confirmed; the dialog names recipient and sender; cancel sends nothing", async () => {
    route = testRoute({ status: 200, body: { ok: true, message: "Test e-mail sent to admin@a.test." } });
    const h = await mount(createElement(ResendSetupCard, {}));
    await click(button("Send a test e-mail to me"));
    const dlg = document.querySelector('[data-testid="resend-confirm-text"]')?.textContent ?? "";
    expect(dlg).toContain("admin@a.test");
    expect(dlg).toContain("orders@mail.test");
    expect(posts()).toHaveLength(0);
    await click(button("Cancel"));
    expect(posts()).toHaveLength(0);
    expect(h.querySelector('[data-testid="resend-test-result"]')).toBeNull();
  });
  it("confirm sends ONE request with no body and shows the server's answer", async () => {
    let init: RequestInit | undefined;
    route = statusRoute(rs("connected"), (url, i) => { if (url.endsWith("/test-send")) { init = i; return { status: 200, body: { ok: true, message: "Test e-mail sent to admin@a.test. Check your inbox." } }; } return { status: 404, body: {} }; });
    const h = await mount(createElement(ResendSetupCard, {}));
    await click(button("Send a test e-mail to me"));
    await click(button("Send test e-mail"));
    expect(posts()).toHaveLength(1);
    expect(init?.body).toBeUndefined();
    expect(text(h, "resend-test-result")).toContain("sent to admin@a.test");
  });
  it("the address can come from the page (prop) instead of the browser session", async () => {
    route = testRoute({ status: 200, body: { ok: true } });
    getUser.mockClear();
    await mount(createElement(ResendSetupCard, { adminEmail: "boss@a.test" }));
    await click(button("Send a test e-mail to me"));
    expect(document.querySelector('[data-testid="resend-confirm-text"]')?.textContent).toContain("boss@a.test");
    expect(getUser).not.toHaveBeenCalled();
  });
  it("a stale authenticator code: asks for one and sends the same request once more; cancelling sends nothing more", async () => {
    let n = 0;
    route = statusRoute(rs("connected"), (url) => url.endsWith("/test-send") ? (n++ === 0 ? { status: 403, body: { code: "mfa_recent_required", error: "fresh code" } } : { status: 200, body: { ok: true, message: "Test e-mail sent to admin@a.test." } }) : { status: 404, body: {} });
    let h = await mount(createElement(ResendSetupCard, {}));
    await click(button("Send a test e-mail to me")); await click(button("Send test e-mail"));
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(2);
    expect(text(h, "resend-test-result")).toContain("sent");
    document.body.innerHTML = ""; calls.length = 0; n = 0; requestCode.mockImplementation(async () => false);
    h = await mount(createElement(ResendSetupCard, {}));
    await click(button("Send a test e-mail to me")); await click(button("Send test e-mail"));
    expect(posts()).toHaveLength(1);
    expect(text(h, "resend-test-result")).toContain("Nothing was sent");
  });
  it.each([
    ["rate limited", { status: 429, body: { ok: false, code: "rate_limited", message: "One test e-mail a minute. Try again in 40 seconds. Nothing was sent." } }, "One test e-mail a minute"],
    ["not configured", { status: 409, body: { ok: false, code: "not_configured", message: "Resend isn't set up on this server. Nothing was sent." } }, "isn't set up"],
    ["provider refused", { status: 502, body: { ok: false, code: "refused", message: "Resend refused the test e-mail. Nothing was sent." } }, "refused"],
    ["uncertain", { status: 502, body: { ok: false, code: "uncertain", message: "We could not confirm whether the test e-mail was sent: check your inbox before trying again. Nothing was retried." } }, "check your inbox before trying again"],
  ] as const)("%s: the server's message, no automatic retry", async (_n, answer, expected) => {
    route = testRoute(answer);
    const h = await mount(createElement(ResendSetupCard, {}));
    await click(button("Send a test e-mail to me")); await click(button("Send test e-mail"));
    expect(text(h, "resend-test-result")).toContain(expected);
    expect(posts()).toHaveLength(1);
  });
  it("no answer at all (network): says we could not confirm, never 'nothing was sent'", async () => {
    route = testRoute("network");
    const h = await mount(createElement(ResendSetupCard, {}));
    await click(button("Send a test e-mail to me")); await click(button("Send test e-mail"));
    expect(text(h, "resend-test-result")).toContain("could not confirm");
    expect(text(h, "resend-test-result")).not.toContain("Nothing was sent");
    expect(posts()).toHaveLength(1);
  });
});
