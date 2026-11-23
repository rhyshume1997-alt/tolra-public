// @vitest-environment jsdom
/**
 * The Companies panel (components/platform/companies-panel.tsx) with the two routes faked. Proves: nothing renders while loading or when the route
 * answers 404 (the panel is off); counts show per company; Close needs the exact name and a reason before it can be sent, shows the plain warning
 * that nothing is deleted, sends one POST and refreshes; a stale authenticator code is asked for once and the same request is sent again; a refusal
 * is shown in the route's words and changes the list not at all; Reopen needs only a reason; a failed load shows Retry. Must not change: this file proves.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestCode = vi.fn(async () => true);
vi.mock("@/components/authenticator-code-dialog", () => ({ useCodePrompt: () => ({ requestCode, codeDialog: null }) }));

import { CompaniesPanel } from "@/components/platform/companies-panel";

type Route = (url: string, init?: RequestInit) => { status: number; body: unknown };
let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; init?: RequestInit }>;
const ALPHA = { organizationId: "a", name: "Alpha Ltd", slug: "alpha", status: "active", people: 4, jobs: 12, invoices: 9, issuedInvoices: 7 };
const BETA = { organizationId: "b", name: "Beta Ltd", slug: "beta", status: "closed", people: 1, jobs: 0, invoices: 0, issuedInvoices: 0 };

function route(handler: Route) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }));
}
async function mount() { await act(async () => { root.render(createElement(CompaniesPanel)); }); await act(async () => { await Promise.resolve(); }); }
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const button = (label: RegExp) => Array.from(host.querySelectorAll("button")).find((b) => label.test(b.textContent ?? "") || label.test(b.getAttribute("aria-label") ?? "")) as HTMLButtonElement;
async function type(label: string, value: string) {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await Promise.resolve(); }); await act(async () => { await Promise.resolve(); }); };

beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); requestCode.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("off, loading and error", () => {
  it("renders nothing when the route answers 404 (the panel is off)", async () => {
    route(() => ({ status: 404, body: { error: "Not found" } }));
    await mount();
    expect(host.innerHTML).toBe("");
  });
  it("when off, its only request is one GET of the companies list (answered 404 before any release 164 call): no POST, no other URL, no retry loop", async () => {
    route(() => ({ status: 404, body: { error: "Not found" } }));
    await mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([["/api/platform/companies", "GET"]]);
    expect(host.innerHTML).toBe("");
  });
  it("shows Retry when the list cannot be loaded, and loads on Retry", async () => {
    let n = 0;
    route(() => (++n === 1 ? { status: 500, body: {} } : { status: 200, body: { companies: [ALPHA] } }));
    await mount();
    expect(host.textContent).toContain("Couldn't load the company counts.");
    await click(button(/Retry/));
    expect(q('[data-testid="company-counts"]')?.textContent).toContain("4 people");
  });
});

describe("the list", () => {
  it("shows people, jobs, invoices and issued invoices per company, and a status badge only for a closed one", async () => {
    route(() => ({ status: 200, body: { companies: [ALPHA, BETA] } }));
    await mount();
    const alpha = q('[data-company="alpha"]')!;
    expect(alpha.textContent).toContain("4 people, 12 jobs, 9 invoices (7 issued)");
    expect(alpha.querySelector('[data-testid="company-status"]')).toBeNull();
    expect(q('[data-company="beta"]')?.querySelector('[data-testid="company-status"]')?.textContent).toBe("closed");
    expect(q('[data-company="beta"]')?.textContent).toContain("1 person, 0 jobs, 0 invoices (0 issued)");
  });
});

describe("Close", () => {
  it("cannot be sent until the exact name is typed and a reason of 5 characters is given, warns that nothing is deleted, then sends once and refreshes", async () => {
    let status = "active";
    route((url, init) => url.endsWith("/status") ? (status = "closed", { status: 200, body: { ok: true, organizationId: "a", status: "closed", changed: true } }) : { status: 200, body: { companies: [{ ...ALPHA, status }] } });
    await mount();
    await click(button(/Close Alpha Ltd/));
    expect(q('[data-testid="close-warning"]')?.textContent).toContain("Nothing is deleted");
    const submit = () => button(/^Close company$/);
    expect(submit().disabled).toBe(true);
    await type("Confirm company name", "Alpha Ltd");
    expect(submit().disabled).toBe(true);
    await type("Confirm company name", "");
    await type("Reason", "Test company no longer needed");
    expect(submit().disabled).toBe(true); // a reason alone is not enough: the typed name is required to close
    await type("Confirm company name", "Alpha Ltd");
    expect(submit().disabled).toBe(false);
    await click(submit());
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({ organizationId: "a", status: "closed", confirmName: "Alpha Ltd", reason: "Test company no longer needed" });
    expect(host.textContent).toContain("Alpha Ltd is closed. Nothing was deleted. Reopen it here any time.");
    expect(q('[data-company="alpha"]')?.querySelector('[data-testid="company-status"]')?.textContent).toBe("closed");
  });
  it("asks for a fresh authenticator code once when the server says the code is too old, then sends the same request again", async () => {
    let posts = 0;
    route((url) => url.endsWith("/status") ? (++posts === 1 ? { status: 403, body: { error: "fresh code", code: "mfa_recent_required" } } : { status: 200, body: { ok: true, status: "closed", changed: true } }) : { status: 200, body: { companies: [ALPHA] } });
    await mount();
    await click(button(/Close Alpha Ltd/));
    await type("Confirm company name", "Alpha Ltd");
    await type("Reason", "Test company no longer needed");
    await click(button(/^Close company$/));
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(2);
  });
  it("shows a refusal in the route's words and leaves the company as it was", async () => {
    route((url) => url.endsWith("/status") ? { status: 400, body: { error: "The name you typed does not match this company. Nothing was changed." } } : { status: 200, body: { companies: [ALPHA] } });
    await mount();
    await click(button(/Close Alpha Ltd/));
    await type("Confirm company name", "Alpha");
    await type("Reason", "Wrong name on purpose");
    await click(button(/^Close company$/));
    expect(q('[role="alert"]')?.textContent).toContain("does not match this company");
    expect(q('[data-company="alpha"]')?.querySelector('[data-testid="company-status"]')).toBeNull();
  });
  it("stops at once when the authenticator code step is cancelled: nothing more is sent", async () => {
    requestCode.mockResolvedValueOnce(false);
    route((url) => url.endsWith("/status") ? { status: 403, body: { error: "fresh code", code: "mfa_recent_required" } } : { status: 200, body: { companies: [ALPHA] } });
    await mount();
    await click(button(/Close Alpha Ltd/));
    await type("Confirm company name", "Alpha Ltd");
    await type("Reason", "Test company no longer needed");
    await click(button(/^Close company$/));
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    expect(host.textContent).toContain("Cancelled. Nothing was changed.");
  });
});

describe("Reopen", () => {
  it("needs only a reason (no name), and sends status active", async () => {
    route((url) => url.endsWith("/status") ? { status: 200, body: { ok: true, status: "active", changed: true } } : { status: 200, body: { companies: [BETA] } });
    await mount();
    await click(button(/Reopen Beta Ltd/));
    expect(q('[data-testid="close-warning"]')).toBeNull();
    expect(host.querySelector('input[aria-label="Confirm company name"]')).toBeNull();
    await type("Reason", "Closed by mistake");
    await click(button(/^Reopen company$/));
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init?.body))).toMatchObject({ organizationId: "b", status: "active", reason: "Closed by mistake" });
    expect(host.textContent).toContain("Beta Ltd is open again.");
  });
});
