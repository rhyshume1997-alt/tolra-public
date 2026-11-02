/**
 * G1: an admin whose last authenticator code is over 15 minutes old is asked for a fresh one instead of being told to sign in again.
 * The browser side (lib/mfa-step-up.ts): the prompt appears only for mfa_recent_required; a verified code sends the SAME change once more;
 * a wrong code changes nothing and can be retried; cancelling sends nothing; and the server's refusal after a code is final (no loop).
 * The server side stays in tests/unit/change-password-route.test.ts: without a fresh aal2 the route refuses, whatever the browser did.
 */
import { describe, expect, it, vi } from "vitest";

import { CODE_PROMPT, CODE_UNAVAILABLE, CODE_WRONG, changePasswordWithCode, cleanCode, needsRecentCode, verifyAuthenticatorCode } from "@/lib/mfa-step-up";
import type { ChangeAnswer, MfaApi } from "@/lib/mfa-step-up";

const OK: ChangeAnswer = { ok: true, status: 200, body: { } };
const RECENT: ChangeAnswer = { ok: false, status: 403, body: { code: "mfa_recent_required", error: "For your security, enter a fresh code from your authenticator app to change your password." } };
const WRONG_PASSWORD: ChangeAnswer = { ok: false, status: 400, body: { error: "Your current password is wrong." } };

function mfa(overrides: Partial<MfaApi> = {}): MfaApi & { verified: Array<{ factorId: string; code: string }> } {
  const verified: Array<{ factorId: string; code: string }> = [];
  return {
    verified,
    listFactors: async () => ({ data: { totp: [{ id: "factor-1" }] }, error: null }),
    challengeAndVerify: async (params) => { verified.push(params); return { error: null }; },
    ...overrides,
  };
}

describe("needsRecentCode", () => {
  it("only a 403 with the mfa_recent_required code", () => {
    expect(needsRecentCode(403, { code: "mfa_recent_required" })).toBe(true);
    expect(needsRecentCode(403, { code: "mfa_required" })).toBe(false);
    expect(needsRecentCode(400, { code: "mfa_recent_required" })).toBe(false);
    expect(needsRecentCode(403, null)).toBe(false);
    expect(needsRecentCode(undefined, undefined)).toBe(false);
  });
});

describe("cleanCode", () => {
  it("six digits, spaces allowed", () => {
    expect(cleanCode("123456")).toBe("123456");
    expect(cleanCode(" 123 456 ")).toBe("123456");
    for (const bad of ["", "12345", "1234567", "12345a", "abcdef"]) expect(cleanCode(bad), bad).toBeNull();
  });
});

describe("verifyAuthenticatorCode", () => {
  it("verifies against the person's enrolled authenticator with the cleaned code", async () => {
    const api = mfa();
    expect(await verifyAuthenticatorCode(api, "123 456")).toEqual({ ok: true });
    expect(api.verified).toEqual([{ factorId: "factor-1", code: "123456" }]);
  });
  it("a wrong code: a plain error, and it can be tried again", async () => {
    let attempts = 0;
    const api = mfa({ challengeAndVerify: async () => (++attempts < 2 ? { error: new Error("invalid") } : { error: null }) });
    expect(await verifyAuthenticatorCode(api, "000000")).toEqual({ ok: false, message: CODE_WRONG });
    expect(await verifyAuthenticatorCode(api, "111111")).toEqual({ ok: true });
  });
  it("not six digits: asks again without calling the auth service", async () => {
    const list = vi.fn();
    expect(await verifyAuthenticatorCode(mfa({ listFactors: list }), "12")).toEqual({ ok: false, message: CODE_PROMPT });
    expect(list).not.toHaveBeenCalled();
  });
  it("no authenticator set up, a failed lookup, a thrown error or no client: not verified", async () => {
    expect(await verifyAuthenticatorCode(mfa({ listFactors: async () => ({ data: { totp: [] }, error: null }) }), "123456")).toEqual({ ok: false, message: CODE_UNAVAILABLE });
    expect(await verifyAuthenticatorCode(mfa({ listFactors: async () => ({ data: null, error: new Error("x") }) }), "123456")).toEqual({ ok: false, message: CODE_UNAVAILABLE });
    expect(await verifyAuthenticatorCode(mfa({ challengeAndVerify: async () => { throw new Error("network"); } }), "123456")).toEqual({ ok: false, message: CODE_UNAVAILABLE });
    expect(await verifyAuthenticatorCode(null, "123456")).toEqual({ ok: false, message: CODE_UNAVAILABLE });
  });
});

describe("changePasswordWithCode", () => {
  it("fresh enough: changed with one request and no prompt", async () => {
    const send = vi.fn(async () => OK);
    const ask = vi.fn(async () => true);
    expect(await changePasswordWithCode(send, ask)).toEqual({ result: "changed" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
  });
  it("too old: prompts, then sends the change once more automatically, and it is changed", async () => {
    const send = vi.fn().mockResolvedValueOnce(RECENT).mockResolvedValueOnce(OK);
    const ask = vi.fn(async () => true);
    expect(await changePasswordWithCode(send, ask)).toEqual({ result: "changed" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("cancelled: nothing more is sent", async () => {
    const send = vi.fn(async () => RECENT);
    expect(await changePasswordWithCode(send, async () => false)).toEqual({ result: "cancelled" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("the server still refuses after a verified code: that refusal is the outcome, no second prompt, no loop", async () => {
    const send = vi.fn(async () => RECENT);
    const ask = vi.fn(async () => true);
    const outcome = await changePasswordWithCode(send, ask);
    expect(outcome).toMatchObject({ result: "failed", status: 403, error: RECENT.body!.error });
    expect(send).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it("any other refusal (wrong current password) is shown as it is, with no prompt", async () => {
    const ask = vi.fn(async () => true);
    expect(await changePasswordWithCode(async () => WRONG_PASSWORD, ask)).toEqual({ result: "failed", status: 400, error: "Your current password is wrong." });
    expect(ask).not.toHaveBeenCalled();
  });
  it("after the code, a different refusal (e.g. wrong current password) is shown as it is", async () => {
    const send = vi.fn().mockResolvedValueOnce(RECENT).mockResolvedValueOnce(WRONG_PASSWORD);
    expect(await changePasswordWithCode(send, async () => true)).toEqual({ result: "failed", status: 400, error: "Your current password is wrong." });
  });
});

// ---- G1: the six Admin > Users callers (lib/admin-user-save.ts callAdminApi, over sendWithCode) --------------------------------
import { ApiError, CODE_CANCELLED, callAdminApi } from "@/lib/admin-user-save";
import { sendWithCode } from "@/lib/mfa-step-up";

const reply = (status: number, body: Record<string, unknown>) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RECENT_BODY = { error: "For your security, enter a fresh code from your authenticator app to make this change.", code: "mfa_recent_required" };
const fetchSequence = (...answers: Array<() => Promise<Response>>) => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: String(init.body) });
    const next = answers.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  });
  return { fetchFn: fn as unknown as typeof fetch, calls };
};

const CALLERS: Array<{ name: string; url: string; method: "POST" | "PATCH"; payload: Record<string, unknown> }> = [
  { name: "set password", url: "/api/admin/users/password", method: "POST", payload: { user_id: "u", password: "p", must_change_password: true } },
  { name: "reset two-step", url: "/api/admin/users/mfa-reset", method: "POST", payload: { userId: "u" } },
  { name: "reset link", url: "/api/admin/users/reset-link", method: "POST", payload: { userId: "u" } },
  { name: "create user", url: "/api/admin/users", method: "POST", payload: { email: "a@b.test", role: "office" } },
  { name: "give or take admin", url: "/api/admin/users", method: "PATCH", payload: { user_id: "u", role: "admin" } },
  { name: "disable or enable sign-in", url: "/api/admin/users/sign-in", method: "POST", payload: { user_id: "u", enabled: false } },
];

describe.each(CALLERS)("callAdminApi: $name", ({ url, method, payload }) => {
  it("a fresh code on the server: one request, no prompt", async () => {
    const { fetchFn, calls } = fetchSequence(reply(200, { ok: true }));
    const prompt = vi.fn(async () => true);
    expect(await callAdminApi(url, method, payload, prompt, fetchFn)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(prompt).not.toHaveBeenCalled();
  });
  it("mfa_recent_required: asks for a code, then sends the SAME request once more and succeeds", async () => {
    const { fetchFn, calls } = fetchSequence(reply(403, RECENT_BODY), reply(200, { ok: true }));
    const prompt = vi.fn(async () => true);
    expect(await callAdminApi(url, method, payload, prompt, fetchFn)).toMatchObject({ ok: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0]).toMatchObject({ url, method, body: JSON.stringify(payload) });
  });
  it("a failed code or a cancel (the prompt answers false): nothing more is sent", async () => {
    const { fetchFn, calls } = fetchSequence(reply(403, RECENT_BODY));
    await expect(callAdminApi(url, method, payload, async () => false, fetchFn)).rejects.toMatchObject({ message: CODE_CANCELLED });
    expect(calls).toHaveLength(1);
  });
  it("a second 403 after a verified code is shown: one prompt, two requests, no loop", async () => {
    const { fetchFn, calls } = fetchSequence(reply(403, RECENT_BODY), reply(403, RECENT_BODY));
    const prompt = vi.fn(async () => true);
    await expect(callAdminApi(url, method, payload, prompt, fetchFn)).rejects.toBeInstanceOf(ApiError);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });
  it("any other refusal (mfa_required, 409, 500) is final at once: no prompt", async () => {
    for (const answer of [reply(403, { error: "Confirm your authenticator code first.", code: "mfa_required" }), reply(409, { error: "Nope" }), reply(500, { error: "Boom" })]) {
      const { fetchFn, calls } = fetchSequence(answer);
      const prompt = vi.fn(async () => true);
      await expect(callAdminApi(url, method, payload, prompt, fetchFn)).rejects.toBeInstanceOf(ApiError);
      expect(prompt).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    }
  });
  it("a refusal after the retry carries the server's message", async () => {
    const { fetchFn } = fetchSequence(reply(403, RECENT_BODY), reply(409, { error: "Another admin must stay." }));
    await expect(callAdminApi(url, method, payload, async () => true, fetchFn)).rejects.toMatchObject({ message: "Another admin must stay." });
  });
});

describe("sendWithCode", () => {
  it("the password change helper still maps onto it (changePasswordWithCode keeps its outcomes)", async () => {
    const send = vi.fn().mockResolvedValueOnce(RECENT).mockResolvedValueOnce(OK);
    expect(await changePasswordWithCode(send, async () => true)).toEqual({ result: "changed" });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("cancelled sends once", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, status: 403, body: { code: "mfa_recent_required" } });
    expect(await sendWithCode(send, async () => false)).toEqual({ result: "cancelled" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
