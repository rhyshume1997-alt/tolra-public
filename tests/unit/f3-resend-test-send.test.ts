/**
 * W-F3: POST /api/integrations/resend/test-send, with the REAL route, lib/email/resend-test-send.ts, requireRecentAal2, resendProvider and
 * sendWithOutcome. Only the Resend SDK, the session (requireProfile) and the database client are faked.
 */
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ sendMock: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>, requireProfile: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>, origin: { v: true } }));
h.sendMock = vi.fn();
vi.mock("resend", () => ({ Resend: class { emails = { send: (...a: unknown[]) => h.sendMock(...a) }; domains = { list: vi.fn() }; } }));

let refuse: number | null = null;
let support = false;
let aal: { currentLevel: string; currentAuthenticationMethods: unknown[] } = { currentLevel: "aal2", currentAuthenticationMethods: [] };
let org = "org-1";
const rpc = vi.fn(async (...args: unknown[]) => (void args, { data: null, error: null as null | { code: string } }));
h.requireProfile = vi.fn(async () => refuse
  ? NextResponse.json({ error: "Forbidden" }, { status: refuse })
  : { supabase: { rpc, auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: aal, error: null }) } } }, user: { id: "u1", email: "Admin@A.test" }, profile: { organization_id: org, role: "admin", email: "profile@a.test" }, session: support ? { support: true } : null });
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  sameOrigin: () => h.origin.v,
  requireProfile: (...a: unknown[]) => h.requireProfile(...a),
}));
const sendMock = h.sendMock;
const requireProfile = h.requireProfile;

import { POST } from "@/app/api/integrations/resend/test-send/route";
import { resetTestSendLimiter, TEST_SUBJECT, TEST_TEXT } from "@/lib/email/resend-test-send";

const KEY = "re_SECRET_key_do_not_leak_123";
const fresh = [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }];
const ok = { data: { id: "msg_1" }, error: null };
const req = (body?: unknown) => new Request("https://app.test/api/integrations/resend/test-send", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
const logged = () => JSON.stringify(vi.mocked(console.error).mock.calls);
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["RESEND_API_KEY", "EMAIL_FROM", "VERCEL_ENV", "EMAIL_RECIPIENT_DOMAINS", "REQUIRE_ADMIN_MFA"]) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.RESEND_API_KEY = KEY; process.env.EMAIL_FROM = "Tolra <orders@mail.test>";
  refuse = null; support = false; h.origin.v = true; org = "org-1"; aal = { currentLevel: "aal2", currentAuthenticationMethods: fresh };
  sendMock.mockReset(); sendMock.mockResolvedValue(ok); rpc.mockClear(); rpc.mockResolvedValue({ data: null, error: null });
  resetTestSendLimiter(); vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("who may send", () => {
  it("a non-admin (or signed-out) is refused before anything is sent", async () => {
    refuse = 403;
    expect((await POST(req())).status).toBe(403);
    expect(requireProfile).toHaveBeenCalledWith(["admin"]);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it("a cross-site request and a support session are refused", async () => {
    h.origin.v = false;
    expect((await POST(req())).status).toBe(403);
    h.origin.v = true; support = true;
    expect((await POST(req())).status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it("no second step: refused (mfa_required), nothing sent, nothing audited", async () => {
    aal = { currentLevel: "aal1", currentAuthenticationMethods: [{ method: "password", timestamp: 1 }] };
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_required");
    expect(sendMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("an old authenticator code is refused (mfa_recent_required) even while REQUIRE_ADMIN_MFA is off", async () => {
    aal = { currentLevel: "aal2", currentAuthenticationMethods: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }] };
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_recent_required");
    expect(sendMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the one recipient", () => {
  it("is the admin's own session address, lower-cased, even when the body, query or headers name someone else", async () => {
    const r = new Request("https://app.test/api/integrations/resend/test-send?to=victim@x.test", { method: "POST", body: JSON.stringify({ to: "victim@x.test", cc: ["v2@x.test"], email: "victim@x.test", recipients: ["v3@x.test"] }), headers: { "content-type": "application/json", "x-to": "v4@x.test" } });
    const res = await POST(r);
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sent = sendMock.mock.calls[0][0] as { to: string[]; cc?: string[]; subject: string; text: string; from: string; html?: unknown; attachments?: unknown };
    expect(sent.to).toEqual(["admin@a.test"]);
    expect(sent.cc).toBeUndefined();
    expect(sent.subject).toBe(TEST_SUBJECT);
    expect(sent.text).toBe(TEST_TEXT);
    expect(sent.from).toBe("Tolra <orders@mail.test>");
    expect(sent.attachments).toBeUndefined();
    expect(r.bodyUsed).toBe(false);
    expect(JSON.stringify(sendMock.mock.calls)).not.toContain("x.test");
  });
  it("a session without an address sends nothing", async () => {
    requireProfile.mockResolvedValueOnce({ supabase: { rpc, auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: aal, error: null }) } } }, user: { id: "u1", email: undefined }, profile: { organization_id: org, role: "admin", email: "profile@a.test" }, session: null } as never);
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("no_address");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("rate limit: one a minute per company", () => {
  it("the second is refused with the wait, another company is not held back, and it opens again after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    aal = { currentLevel: "aal2", currentAuthenticationMethods: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] };
    expect((await POST(req())).status).toBe(200);
    vi.setSystemTime(new Date("2026-11-05T10:00:20Z"));
    const again = await POST(req());
    expect(again.status).toBe(429);
    const body = await again.json();
    expect(body).toMatchObject({ code: "rate_limited", retryAfterSeconds: 40 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    org = "org-2";
    expect((await POST(req())).status).toBe(200);
    org = "org-1";
    vi.setSystemTime(new Date("2026-11-05T10:01:01Z"));
    expect((await POST(req())).status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
  it("an uncertain outcome still uses the minute (no hammering)", async () => {
    sendMock.mockRejectedValue(new Error("socket hang up"));
    expect((await POST(req())).status).toBe(502);
    sendMock.mockResolvedValue(ok);
    expect((await POST(req())).status).toBe(429);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("configuration and provider answers", () => {
  it("no key: a clear 'not set up', nothing sent, no audit, no rate slot used", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "not_configured" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    process.env.RESEND_API_KEY = KEY;
    expect((await POST(req())).status).toBe(200);
  });
  it("no sender address: not configured too", async () => {
    delete process.env.EMAIL_FROM;
    expect((await POST(req())).status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it("Resend refuses (4xx): a clear message, nothing leaked, audited as failed, not retried", async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: "validation_error", statusCode: 422, message: `The key ${KEY} is not allowed to send from orders@mail.test` } });
    const res = await POST(req());
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({ code: "refused" });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("admin@a.test");
    expect(logged()).not.toContain(KEY);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0][1] as { p_metadata: { outcome: string } }).p_metadata.outcome).toBe("failed");
  });
  it("Resend is busy (429): says wait a minute", async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: "rate_limit_exceeded", statusCode: 429, message: "slow down" } });
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect((await res.json()).message).toContain("busy");
  });
  it.each([
    ["the SDK throws with the key in its message", () => sendMock.mockRejectedValue(new Error(`fetch failed for ${KEY}`))],
    ["Resend answers 500", () => sendMock.mockResolvedValue({ data: null, error: { name: "application_error", statusCode: 500, message: `oops ${KEY}` } })],
  ])("%s: 'we could not confirm: check your inbox', no key anywhere, no retry, audited as unknown", async (_n, arrange) => {
    arrange();
    const res = await POST(req());
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({ code: "uncertain" });
    expect(text).toContain("check your inbox before trying again");
    expect(text).not.toContain(KEY);
    expect(logged()).not.toContain(KEY);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0][1] as { p_metadata: { outcome: string } }).p_metadata.outcome).toBe("unknown");
  });
});

describe("preview deployment allowlist (EMAIL_RECIPIENT_DOMAINS)", () => {
  it("an admin address outside the allowlist is refused: nothing sent, nothing audited", async () => {
    process.env.VERCEL_ENV = "preview"; process.env.EMAIL_RECIPIENT_DOMAINS = "other.test";
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("recipient_refused");
    expect(sendMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("an empty allowlist refuses everyone on a preview; an allowlisted domain sends", async () => {
    process.env.VERCEL_ENV = "preview";
    expect((await POST(req())).status).toBe(403);
    process.env.EMAIL_RECIPIENT_DOMAINS = "a.test";
    expect((await POST(req())).status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("the audit row", () => {
  it("is written once per attempt through write_audit: action, company, outcome code; no address, no subject, no text, no ip", async () => {
    expect((await POST(req())).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("write_audit");
    expect(args).toEqual({ p_action: "SEND", p_entity_table: "email_history", p_entity_id: "org-1", p_old: null, p_new: null, p_metadata: { channel: "resend", purpose: "test_send", outcome: "accepted" }, p_ip: null, p_user_agent: null });
    const flat = JSON.stringify(args);
    for (const secret of ["admin@a.test", "a.test", TEST_SUBJECT, TEST_TEXT, KEY]) expect(flat).not.toContain(secret);
  });
  it("a failed audit write is logged by code and does not turn a sent test into an error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect((await POST(req())).status).toBe(200);
    expect(logged()).toContain("42501");
  });
});
