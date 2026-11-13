// @vitest-environment jsdom
/**
 * A150: the AI card after release 150. The cap line comes from the server (1000p shows as £10.00 for both providers, no 500 anywhere in the
 * card's code); replacing or removing the key says AI was switched off because the key changed and that it must be turned on again; the switch
 * reads Off after the reload; a key change never calls a switch route; Remove key asks for the code like the other key actions and is only
 * offered to an admin with a saved key in own-key mode.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// AI-E (C4): the shared Tolra key is switched off by default; these tests keep the dormant Tolra code covered by turning the constant on.
vi.mock("@/lib/ai-helper/shared-ai-deactivation", () => ({ SHARED_TOLRA_AI_ACTIVE: true }));

import { AiSetupPanel } from "@/components/integrations/ai-setup-card";
import type { AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { keyChangeNotice } from "@/lib/integrations/ai-setup";

vi.mock("@/components/authenticator-code-dialog", () => ({ useCodePrompt: () => ({ requestCode: async () => true, codeDialog: null }) }));

const KEY2 = "sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA-9876";
const MFA = { code: "mfa_recent_required", error: "For your security, enter a fresh code from your authenticator app to save the AI key." };
const base = (over: Partial<AiHelperStatus> = {}): AiHelperStatus => ({
  roundup_enabled: false, rfq_enabled: false, monthly_cap_pence: 1000, key_set: false, key_last4: null, month_spent_pence: 0, month_reserved_pence: 0, can_manage: true,
  tolra_available: true, tolra_enabled: false, tolra_cap_pence: 1000, finance_check_available: true, finance_check_enabled: false, assistant_available: true, assistant_enabled: false, ...over,
});
const ON = { key_set: true, key_last4: "wxyz", roundup_enabled: true, rfq_enabled: true };

type Reply = { status: number; body: unknown };
let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string; body: unknown }>;
let replies: Reply[];
const fetchFn = (async (url: string, init?: RequestInit) => {
  calls.push({ url, method: String(init?.method), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
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
const removeButton = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Remove key") ?? null;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const replaceKey = async () => { await type(q<HTMLInputElement>("#ai-key")!, KEY2); await act(async () => { q<HTMLButtonElement>('form button[type="submit"]')!.click(); }); };
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

describe("A150: the limit shown comes from the server", () => {
  it("own key and Tolra-provided AI both show £10.00 when the server says 1000p", async () => {
    await draw({ status: base() });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).toBe("Monthly limit (your own key): £10.00 a month. Used this month: £0.00.");
    await draw({ status: base({ tolra_enabled: true, roundup_enabled: true }) });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).toBe("Monthly allowance (Tolra-provided): £10.00 a month, per company. Used this month: £0.00.");
  });

  it("an explicit limit the company set is shown as it is (the card does not round it up to the default)", async () => {
    await draw({ status: base({ monthly_cap_pence: 500, key_set: true }) });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).toContain("£5.00 a month");
    await draw({ status: base({ monthly_cap_pence: 12345, tolra_cap_pence: 100000, key_set: true }) });
    expect(q('[data-testid="ai-cap-line"]')!.textContent).toContain("£123.45 a month");
  });

  it("no number for the cap is written into the card's code (not 500, not 1000)", () => {
    for (const file of ["components/integrations/ai-setup-card.tsx", "lib/integrations/ai-setup.ts"]) {
      const source = readFileSync(path.resolve(__dirname, "../..", file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/(?<![-\w])(500|1000|1_000)(?![\w-])/);
      expect(source, file).not.toMatch(/£\s?(5|10)\b/);
    }
  });
});

describe("A150: a key change switches AI off and the card says so", () => {
  it("replacing the key while AI is on: the new key goes to the key route only, and the notice says AI was switched off and must be turned on again", async () => {
    const props = await draw({ status: base(ON) });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    replies = [{ status: 200, body: base({ key_set: true, key_last4: "9876" }) }];
    await replaceKey();
    expect(calls).toEqual([{ url: "/api/ai-helper/key", method: "POST", body: { key: KEY2 } }]);
    expect(props.reload).toHaveBeenCalledTimes(1);
    const notice = q('[data-testid="ai-notice"]')!.textContent!;
    expect(notice).toContain("AI was switched off because the key changed");
    expect(notice).toContain("Turn it on again");
    expect(notice).not.toContain(KEY2);
    expect(text()).not.toContain(KEY2);
  });

  it("after the reload the status is off: the switch reads Off, the badge says AI: Off and turning on is a separate, explicit step that still needs the code flow", async () => {
    await draw({ status: base({ key_set: true, key_last4: "9876" }) });
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(q('[data-testid="activation-badge-ai"]')!.textContent).toBe("AI: Off");
    expect(sw().disabled).toBe(false);
    replies = [{ status: 403, body: MFA }, { status: 200, body: base({ key_set: true, roundup_enabled: true, rfq_enabled: true }) }];
    const props = await draw({ status: base({ key_set: true, key_last4: "9876" }) });
    await click(sw());
    expect(props.requestCode).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.url)).toEqual(["/api/ai-helper/settings", "/api/ai-helper/settings"]);
  });

  it("replacing the key while AI is already off: the notice says saving a key does not turn AI on, with no 'switched off' claim", async () => {
    await draw({ status: base({ key_set: true, key_last4: "wxyz" }) });
    replies = [{ status: 200, body: base({ key_set: true }) }];
    await replaceKey();
    const notice = q('[data-testid="ai-notice"]')!.textContent!;
    expect(notice).toContain("New key saved");
    expect(notice).toContain("AI is not turned on by saving a key");
    expect(notice).not.toContain("switched off because");
  });

  it("removing the key: DELETE to the key route, the notice says the key is removed and AI was switched off", async () => {
    const props = await draw({ status: base(ON) });
    replies = [{ status: 200, body: base() }];
    await click(removeButton()!);
    expect(calls).toEqual([{ url: "/api/ai-helper/key", method: "DELETE", body: undefined }]);
    expect(props.reload).toHaveBeenCalledTimes(1);
    const notice = q('[data-testid="ai-notice"]')!.textContent!;
    expect(notice).toContain("Key removed.");
    expect(notice).toContain("AI was switched off because the key changed");
  });

  it("removing a key when AI was off says it stays off; a refusal shows the server's sentence and changes nothing on screen", async () => {
    await draw({ status: base({ key_set: true, key_last4: "wxyz" }) });
    replies = [{ status: 200, body: base() }];
    await click(removeButton()!);
    expect(q('[data-testid="ai-notice"]')!.textContent).toContain("AI stays off until you turn it on");
    calls = [];
    await draw({ status: base({ key_set: true, key_last4: "wxyz" }) });
    replies = [{ status: 403, body: { error: "The key could not be removed." } }];
    await click(removeButton()!);
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("The key could not be removed.");
  });

  it("Remove key follows the code flow of the other key actions: asked for once, the same request sent once more", async () => {
    const props = await draw({ status: base(ON) });
    replies = [{ status: 403, body: MFA }, { status: 200, body: base() }];
    await click(removeButton()!);
    expect(props.requestCode).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE /api/ai-helper/key", "DELETE /api/ai-helper/key"]);
  });

  it("a key change never calls a switch route (the database does the switching off, not the browser)", async () => {
    await draw({ status: base(ON) });
    replies = [{ status: 200, body: base({ key_set: true }) }];
    await replaceKey();
    replies = [{ status: 200, body: base() }];
    await click(removeButton()!);
    expect(calls.every((c) => c.url === "/api/ai-helper/key")).toBe(true);
  });

  it("Remove key is offered only to an admin with a saved key in own-key mode", async () => {
    await draw({ status: base() });
    expect(removeButton()).toBeNull();
    await draw({ status: base({ key_set: true, can_manage: false }) });
    expect(removeButton()).toBeNull();
    await draw({ status: base({ key_set: true, tolra_enabled: true, roundup_enabled: true }) });
    expect(removeButton()).toBeNull();
    await draw({ status: base({ key_set: true, key_last4: "wxyz" }) });
    expect(removeButton()).not.toBeNull();
    expect(text()).toContain("Replacing or removing the key switches AI off.");
  });

  it("the sentences themselves", () => {
    expect(keyChangeNotice("replaced", true)).toBe("New key saved. It replaces the old key, which is no longer used. AI was switched off because the key changed. Turn it on again with the switch above when you are ready.");
    expect(keyChangeNotice("saved", false)).toBe("Key saved. AI is not turned on by saving a key.");
    expect(keyChangeNotice("removed", false)).toBe("Key removed. AI stays off until you turn it on with the switch above.");
    expect(keyChangeNotice("removed", true)).toContain("AI was switched off because the key changed");
  });
});

describe("A150: the company's own monthly limit field", () => {
  const limitInput = () => q<HTMLInputElement>("#ai-limit");
  const saveLimit = async (value: string) => { await type(limitInput()!, value); await act(async () => { q<HTMLButtonElement>('form[aria-label="Monthly limit"] button[type="submit"]')!.click(); }); };
  const bodyOf = (i = 0) => calls[i].body as Record<string, unknown>;

  it("shows the server's limit in pounds and Save is disabled until it is changed", async () => {
    await draw({ status: base({ key_set: true, monthly_cap_pence: 750 }) });
    expect(limitInput()!.value).toBe("7.50");
    expect(q<HTMLButtonElement>('form[aria-label="Monthly limit"] button[type="submit"]')!.disabled).toBe(true);
  });

  it("a valid limit (whole pounds, pence, a £ sign) is sent to the settings route as whole pence with every switch exactly as the server reported; AI stays as it was", async () => {
    for (const [typed, pence] of [["12", 1200], ["7.5", 750], ["£3.05", 305], ["1000", 100000], ["0", 0], ["0.00", 0]] as const) {
      calls = [];
      const status = base({ key_set: true, roundup_enabled: false, rfq_enabled: false, finance_check_enabled: true, assistant_enabled: false });
      const props = await draw({ status });
      replies = [{ status: 200, body: {} }];
      await saveLimit(typed);
      expect(calls, typed).toHaveLength(1);
      expect(calls[0].url).toBe("/api/ai-helper/settings");
      expect(bodyOf()).toEqual({ roundupEnabled: false, rfqEnabled: false, financeCheckEnabled: true, assistantEnabled: false, monthlyCapPence: pence });
      expect(props.reload).toHaveBeenCalledTimes(1);
      expect(q('[data-testid="ai-notice"]')!.textContent).toContain("does not turn AI on or off");
    }
  });

  it("with AI on, the switches are sent as they are (still on) and the code prompt is used once, same request sent again", async () => {
    const props = await draw({ status: base({ ...ON, assistant_enabled: true }) });
    replies = [{ status: 403, body: MFA }, { status: 200, body: {} }];
    await saveLimit("20");
    expect(props.requestCode).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(bodyOf()).toMatchObject({ roundupEnabled: true, rfqEnabled: true, assistantEnabled: true, monthlyCapPence: 2000 });
  });

  it("invalid values are refused before anything is sent: empty, text, negative, over the maximum, three decimals, an exponent", async () => {
    await draw({ status: base({ key_set: true }) });
    for (const bad of ["", "abc", "-1", "1000.01", "1001", "5000", "1.234", "1e2", "10,50", "NaN"]) {
      await saveLimit(bad);
      expect(calls, bad).toHaveLength(0);
      if (bad !== "") expect(q('[data-testid="ai-notice"]')!.textContent, bad).toContain("£0 to £1,000");
    }
  });

  it("cancelling the code prompt sends nothing more; a refusal shows the server's sentence", async () => {
    const props = await draw({ status: base(ON), requestCode: vi.fn(async () => false) });
    replies = [{ status: 403, body: MFA }];
    await saveLimit("9");
    expect(props.requestCode).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("Cancelled. Nothing was changed.");
    calls = [];
    await draw({ status: base({ key_set: true }) });
    replies = [{ status: 403, body: { error: "The AI helper settings could not be saved." } }];
    await saveLimit("9");
    expect(q('[data-testid="ai-notice"]')!.textContent).toBe("The AI helper settings could not be saved.");
  });

  it("not offered without admin rights; in Tolra mode it is read-only and says Tolra sets it", async () => {
    await draw({ status: base({ key_set: true, can_manage: false }) });
    expect(limitInput()).toBeNull();
    await draw({ status: base({ tolra_enabled: true, roundup_enabled: true }) });
    expect(limitInput()).toBeNull();
    expect(q('[data-testid="ai-limit-tolra-note"]')!.textContent).toBe("Your Tolra allowance is set by Tolra for your company. It can't be changed here.");
  });
});
