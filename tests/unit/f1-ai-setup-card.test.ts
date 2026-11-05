// @vitest-environment jsdom
/**
 * F1: the AI card on Admin > Integrations, in every state. Real component, real helper, fetch stood in (no network, no provider).
 *   no key / key saved / switch off / switch on / server flag off / Tolra off / not an admin / assistant line / monthly cap shown from the server /
 *   a fresh authenticator code needed (asked once, same request sent once more, cancel sends nothing) / errors /
 *   the key is never in the page after Save (not while sending, not after success, not after a failure) / replacement /
 *   saving a key never turns AI on.
 */
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiSetupPanel } from "@/components/integrations/ai-setup-card";
import type { AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import {
  ANTHROPIC_KEYS_URL, NO_KEY_REASON, NOT_ADMIN_REASON, SERVER_OFF_REASON, TOLRA_OFF_REASON, buildAiSetup, poundsAndPence,
} from "@/lib/integrations/ai-setup";

vi.mock("@/components/authenticator-code-dialog", () => ({ useCodePrompt: () => ({ requestCode: async () => true, codeDialog: null }) }));

const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ-1234";
const KEY2 = "sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA-9876";
const MFA = { code: "mfa_recent_required", error: "For your security, enter a fresh code from your authenticator app to save the AI key." };

const base = (over: Partial<AiHelperStatus> = {}): AiHelperStatus => ({
  roundup_enabled: false, rfq_enabled: false, monthly_cap_pence: 500, key_set: false, key_last4: null, month_spent_pence: 0, month_reserved_pence: 0, can_manage: true,
  tolra_available: true, tolra_enabled: false, tolra_cap_pence: 1000, finance_check_available: true, finance_check_enabled: false, assistant_available: true, assistant_enabled: false, ...over,
});

type Reply = { status: number; body: unknown };
let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; body: Record<string, unknown> }>;
let replies: Reply[];
const fetchFn = (async (url: string, init?: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
  const next = replies.shift() ?? { status: 200, body: {} };
  return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
}) as unknown as typeof fetch;

async function draw(props: Partial<Parameters<typeof AiSetupPanel>[0]> = {}) {
  const full = { serverOn: true, loaded: true, status: base(), reload: vi.fn(), requestCode: vi.fn(async () => true), fetchFn, ...props };
  await act(async () => root.render(createElement(AiSetupPanel, full)));
  return full;
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T | null;
const text = () => host.textContent ?? "";
const sw = () => q<HTMLButtonElement>('[role="switch"]')!;
const keyInput = () => q<HTMLInputElement>("#ai-key");
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function save(value: string) {
  await type(keyInput()!, value);
  await act(async () => { q<HTMLButtonElement>('form button[type="submit"]')!.click(); });
}
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  replies = [];
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("AI card: setup states", () => {
  it("no key: AI is Off, the switch is disabled with a plain reason, and the key form is there (password type, official link in a new tab)", async () => {
    await draw();
    expect(q('[data-testid="connection-ai"]')!.textContent).toContain("No key saved");
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Off");
    expect(sw().disabled).toBe(true);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(q('[data-testid="activation-why-ai"]')!.textContent).toBe(NO_KEY_REASON);
    expect(keyInput()!.type).toBe("password");
    expect(keyInput()!.autocomplete).toBe("off");
    const link = q<HTMLAnchorElement>(`a[href="${ANTHROPIC_KEYS_URL}"]`)!;
    expect(link.textContent).toBe(ANTHROPIC_KEYS_URL);
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(ANTHROPIC_KEYS_URL).toMatch(/^https:\/\/console\.anthropic\.com\//);
  });

  it("only the two real providers are offered", async () => {
    await draw();
    const values = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map((r) => r.value);
    expect(values).toEqual(["anthropic", "tolra"]);
  });

  it("key saved: shows saved and the last four characters only; the switch can be used but is still Off", async () => {
    await draw({ status: base({ key_set: true, key_last4: "wxyz" }) });
    expect(q('[data-testid="connection-ai"]')!.textContent).toContain("Key saved (ending wxyz)");
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Off");
    expect(sw().disabled).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(q('[data-testid="activation-why-ai"]')).toBeNull();
    expect(q('form button[type="submit"]')!.textContent).toBe("Replace key");
  });

  it("switch on: shown On, and it can always be turned off (even if the key were gone)", async () => {
    await draw({ status: base({ key_set: false, roundup_enabled: true }) });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: On");
    expect(sw().disabled).toBe(false);
    expect(text()).toContain("Turn AI off to change who provides it.");
  });

  it("server flag off: says so, cannot be switched on, no key form, nothing is sent", async () => {
    await draw({ serverOn: false, status: null });
    expect(q('[data-testid="connection-ai"]')!.textContent).toContain("switched off on this server");
    expect(q('[data-testid="activation-why-ai"]')!.textContent).toBe(SERVER_OFF_REASON);
    expect(sw().disabled).toBe(true);
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Off");
    expect(keyInput()).toBeNull();
    await click(sw());
    expect(calls).toEqual([]);
  });

  it("loading and unreadable status: the switch shows Unknown (never On) and cannot be used", async () => {
    await draw({ loaded: false, status: null });
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Unknown");
    expect(sw().disabled).toBe(true);
    await draw({ loaded: true, status: null });
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Unknown");
    expect(text()).toContain("Couldn't read the AI status");
    expect(sw().disabled).toBe(true);
  });

  it("not an admin: read only, no key form, switch disabled with the reason", async () => {
    await draw({ status: base({ can_manage: false, key_set: true, key_last4: null }) });
    expect(q('[data-testid="activation-why-ai"]')!.textContent).toBe(NOT_ADMIN_REASON);
    expect(sw().disabled).toBe(true);
    expect(keyInput()).toBeNull();
    expect(q('[data-testid="connection-ai"]')!.textContent).toContain("Key saved");
  });
});

describe("AI card: Tolra-provided mode and the monthly cap (the number comes from the server)", () => {
  it("shows the server's allowance as pounds and pence: 1000p is £10.00, and a different server number is shown as it is", async () => {
    await draw({ status: base({ tolra_enabled: true, roundup_enabled: true, tolra_cap_pence: 1000 }) });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).toContain("£10.00 a month");
    await draw({ status: base({ tolra_enabled: true, roundup_enabled: true, tolra_cap_pence: 1234 }) });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).toContain("£12.34 a month");
    expect(q('[data-testid="ai-cap-line"]')!.textContent).not.toContain("£10.00");
    await draw({ status: base({ tolra_enabled: true, roundup_enabled: true, tolra_cap_pence: 0 }) });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).toContain("£0.00 a month");
  });

  it("never invents a number: no cap from the server means no figure", async () => {
    await draw({ status: base({ tolra_enabled: true, roundup_enabled: true, tolra_cap_pence: undefined }) });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).not.toMatch(/£\d/);
  });

  it("own-key mode with the 500p default (migration 122) shows what the server says: £5.00 a month, labelled as the own-key limit", async () => {
    await draw({ status: base({ key_set: true, key_last4: "wxyz", monthly_cap_pence: 500 }) });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).toBe("Monthly limit (your own key): £5.00 a month. Used this month: £0.00.");
  });

  it("choosing Tolra before it is on: a platform-off Tolra cannot be switched on and says why; an available one can", async () => {
    await draw({ status: base({ tolra_available: false }) });
    await click(host.querySelector<HTMLInputElement>('input[value="tolra"]')!);
    expect(q('[data-testid="activation-why-ai"]')!.textContent).toBe(TOLRA_OFF_REASON);
    expect(sw().disabled).toBe(true);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    await draw({ status: base({ tolra_available: true }) });
    expect(sw().disabled).toBe(false);
    expect(q('[data-testid="connection-ai"]')!.textContent).toContain("Tolra-provided AI is available");
    expect(keyInput()).toBeNull(); // no key is asked for in Tolra mode
  });

  it("Tolra on while Tolra's platform switch is off: shown On, and can still be turned off", async () => {
    await draw({ status: base({ tolra_available: false, tolra_enabled: true, roundup_enabled: true }) });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(sw().disabled).toBe(false);
  });

  it("turning Tolra on sends only {enabled:true} to tolra-mode", async () => {
    replies = [{ status: 200, body: { ok: true } }];
    const props = await draw();
    await click(host.querySelector<HTMLInputElement>('input[value="tolra"]')!);
    await click(sw());
    expect(calls).toEqual([{ url: "/api/ai-helper/tolra-mode", body: { enabled: true } }]);
    expect(props.reload).toHaveBeenCalledTimes(1);
  });
});

describe("AI card: the assistant is its own line, not one button", () => {
  it("unavailable, off and on are three different lines; the one switch is not the assistant", async () => {
    await draw({ status: base({ assistant_available: false }) });
    expect(q('[data-testid="ai-assistant-line"]')!.getAttribute("data-state")).toBe("unavailable");
    expect(q('[data-testid="ai-assistant-line"]')!.textContent).toContain("not available on this server");
    await draw({ status: base({ assistant_available: true, assistant_enabled: false, key_set: true }) });
    expect(q('[data-testid="ai-assistant-line"]')!.getAttribute("data-state")).toBe("off");
    await draw({ status: base({ assistant_available: true, assistant_enabled: true, key_set: true }) });
    expect(q('[data-testid="ai-assistant-line"]')!.getAttribute("data-state")).toBe("on");
    expect(host.querySelectorAll('[role="switch"]')).toHaveLength(1);
  });

  it("the assistant alone on counts as AI on; the assistant unavailable on this server is not counted", async () => {
    await draw({ status: base({ key_set: true, assistant_enabled: true, assistant_available: true }) });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    await draw({ status: base({ key_set: true, assistant_enabled: true, assistant_available: false }) });
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });
});

describe("AI card: turning AI on needs a fresh authenticator code", () => {
  it("the server asks, the code is requested once, and the SAME request is sent once more", async () => {
    replies = [{ status: 403, body: MFA }, { status: 200, body: {} }];
    const props = await draw({ status: base({ key_set: true, key_last4: "wxyz" }) });
    await click(sw());
    expect(props.requestCode).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0].url).toBe("/api/ai-helper/settings");
    expect(calls[0].body).toMatchObject({ roundupEnabled: true, rfqEnabled: true, assistantEnabled: true, financeCheckEnabled: true, monthlyCapPence: 500 });
    expect(props.reload).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("AI is on.");
  });

  it("cancelling the code sends nothing more and changes nothing", async () => {
    replies = [{ status: 403, body: MFA }];
    const props = await draw({ status: base({ key_set: true, key_last4: "wxyz" }), requestCode: vi.fn(async () => false) });
    await click(sw());
    expect(calls).toHaveLength(1);
    expect(props.reload).not.toHaveBeenCalled();
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("Cancelled. Nothing was changed.");
  });

  it("a second refusal after the code is the outcome: no loop, no second prompt", async () => {
    replies = [{ status: 403, body: MFA }, { status: 403, body: MFA }];
    const props = await draw({ status: base({ key_set: true, key_last4: "wxyz" }) });
    await click(sw());
    expect(props.requestCode).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(q('[data-testid="ai-notice"]')!.textContent).toContain("fresh code");
  });

  it("turning AI off sends the off request (the server never asks for a code to turn off)", async () => {
    replies = [{ status: 200, body: {} }];
    await draw({ status: base({ key_set: true, roundup_enabled: true, rfq_enabled: true }) });
    await click(sw());
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ roundupEnabled: false, rfqEnabled: false, assistantEnabled: false });
  });

  it("a plain error from the server is shown in words and nothing is claimed", async () => {
    replies = [{ status: 503, body: { error: "The AI helper settings could not be saved." } }];
    const props = await draw({ status: base({ key_set: true, key_last4: "wxyz" }) });
    await click(sw());
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("The AI helper settings could not be saved.");
    expect(props.reload).not.toHaveBeenCalled();
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Off");
  });
});

describe("AI card: the key", () => {
  it("a key that is not shaped like an Anthropic key sends nothing, says so without repeating it, and the field is emptied", async () => {
    await draw();
    await save("not-a-real-key-1234567890");
    expect(calls).toEqual([]);
    expect(q('[data-testid="ai-notice"]')!.textContent).toContain("starts with sk-ant-");
    expect(keyInput()!.value).toBe("");
    expect(host.innerHTML).not.toContain("not-a-real-key");
  });

  it("save: the key is sent once to the key route and nowhere else; the field is empty at once; the key is not in the page while sending, nor after", async () => {
    let release!: () => void;
    const slow = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, status: 200, json: async () => ({ key_set: true, key_last4: "1234" }) };
    }) as unknown as typeof fetch;
    const props = await draw({ fetchFn: slow });
    await type(keyInput()!, KEY);
    expect(keyInput()!.value).toBe(KEY);
    await act(async () => { q<HTMLButtonElement>('form button[type="submit"]')!.click(); });
    // in flight
    expect(keyInput()!.value).toBe("");
    expect(host.innerHTML).not.toContain(KEY);
    expect(host.innerHTML).not.toContain(KEY.slice(7));
    await act(async () => release());
    expect(calls).toEqual([{ url: "/api/ai-helper/key", body: { key: KEY } }]);
    expect(props.reload).toHaveBeenCalledTimes(1);
    expect(host.innerHTML).not.toContain(KEY);
    expect(keyInput()!.value).toBe("");
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("Key saved. AI is not turned on by saving a key.");
  });

  it("the key is never logged: no console output while saving, failing or replacing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    replies = [{ status: 503, body: { error: "The key could not be saved." } }, { status: 200, body: {} }];
    await draw();
    await save(KEY);
    await save(KEY2);
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("sk-ant");
  });

  it("a failed save: plain message, field still empty, key not in the page; a server message that contained the key is not shown", async () => {
    replies = [{ status: 503, body: { error: "The key could not be saved." } }, { status: 400, body: { error: `Rejected ${KEY}` } }];
    await draw();
    await save(KEY);
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("The key could not be saved.");
    expect(keyInput()!.value).toBe("");
    expect(host.innerHTML).not.toContain(KEY);
    await save(KEY);
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("The key could not be saved. Try again.");
    expect(host.innerHTML).not.toContain(KEY);
  });

  it("a fresh code is needed to save: the key is held in memory only, never put back in the page, and sent twice with the same body", async () => {
    replies = [{ status: 403, body: MFA }, { status: 200, body: {} }];
    let seenWhileAsking = "";
    const requestCode = vi.fn(async () => { seenWhileAsking = host.innerHTML + (keyInput()?.value ?? ""); return true; });
    await draw({ requestCode });
    await save(KEY);
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(seenWhileAsking).not.toContain(KEY);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(host.innerHTML).not.toContain(KEY);
  });

  it("cancelling the code on a key save sends the key once only and drops it", async () => {
    replies = [{ status: 403, body: MFA }];
    await draw({ requestCode: vi.fn(async () => false) });
    await save(KEY);
    expect(calls).toHaveLength(1);
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("Cancelled. Nothing was changed.");
    expect(keyInput()!.value).toBe("");
    expect(host.innerHTML).not.toContain(KEY);
  });

  it("saving a key never turns AI on: only the key route is called, and the switch is still Off afterwards", async () => {
    replies = [{ status: 200, body: { key_set: true } }];
    const status = base();
    const props = await draw({ status });
    await save(KEY);
    expect(calls.map((c) => c.url)).toEqual(["/api/ai-helper/key"]);
    // the server answers the reload with the key saved and every switch still off
    await draw({ status: base({ key_set: true, key_last4: "1234" }), reload: props.reload });
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Off");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(calls).toHaveLength(1);
  });

  it("replacement: a new key goes through the same route, says the old key is no longer used, still does not turn AI on", async () => {
    replies = [{ status: 200, body: { key_set: true } }];
    const props = await draw({ status: base({ key_set: true, key_last4: "1234" }) });
    expect(text()).toContain("New Anthropic API key (replaces the saved one)");
    await save(KEY2);
    expect(calls).toEqual([{ url: "/api/ai-helper/key", body: { key: KEY2 } }]);
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("New key saved. It replaces the old key, which is no longer used. AI is not turned on by saving a key.");
    expect(props.reload).toHaveBeenCalledTimes(1);
    expect(host.innerHTML).not.toContain(KEY2);
    expect(host.innerHTML).not.toContain(KEY);
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Off");
  });
});

describe("AI card: the pure model", () => {
  it("poundsAndPence", () => {
    expect([0, 5, 500, 1000, 1234, 100000].map(poundsAndPence)).toEqual(["£0.00", "£0.05", "£5.00", "£10.00", "£12.34", "£1000.00"]);
  });
  it("the reason to refuse only applies while AI is off", () => {
    const off = buildAiSetup({ serverOn: true, loaded: true, status: base(), chosen: "anthropic" });
    expect(off.disabledReason).toBe(NO_KEY_REASON);
    const on = buildAiSetup({ serverOn: true, loaded: true, status: base({ roundup_enabled: true }), chosen: "anthropic" });
    expect(on.disabledReason).toBeNull();
    expect(on.on).toBe(true);
  });
  it("what the server says is in use wins over the picker", () => {
    const m = buildAiSetup({ serverOn: true, loaded: true, status: base({ tolra_enabled: true, roundup_enabled: true }), chosen: "anthropic" });
    expect(m.provider).toBe("tolra");
  });
});
