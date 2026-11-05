/**
 * Proposal 151: the accountant's Xero connect link as an opaque reference + a code e-mailed to the bound address. Adversarial unit tests (the database
 * rules themselves are in tests/db/xero-invite-151.test.ts): exact HTTPS redirect-URI allow list and its near misses, the code's keyed hash, state and PKCE
 * mismatches at the callback, fail-closed e-mail, and no code, reference, state or hash in any log, page or error even when the database's own error
 * text carries them. Nothing reaches the network; no real e-mail is sent.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sendCompanyEmail = vi.fn();
vi.mock("@/lib/email/send-company-email", async (orig) => ({ ...(await orig<object>()), sendCompanyEmail: (...a: unknown[]) => sendCompanyEmail(...a) }));

import { encryptSecret } from "@/lib/integrations/crypto";
import {
  allowedInviteRedirect, cleanInviteCode, finishInviteConnect, inviteCodeHash, inviteConfirmPage, inviteRedirectAllowList, inviteRedirectAllowed, inviteVerifierContext,
  issueInviteCode, newInviteCode, newInviteRef, redeemInvite,
} from "@/lib/integrations/invite";
import { sendInviteCodeEmail, sendInviteLinkEmail } from "@/lib/integrations/invite-mail";
import { hashState } from "@/lib/integrations/xero/oauth";
import type { OutgoingEmail } from "@/lib/email/providers/types";

const key = randomBytes(32);
const SITE = "https://app.example.test";
const CALLBACK = `${SITE}/api/integrations/invite/callback`;
const ready = { config: { clientId: "xid", clientSecret: "xsecret", redirectUri: `${SITE}/api/integrations/xero/callback` }, key };
const ALLOW = { XERO_INVITE_REDIRECT_URIS: CALLBACK };

describe("exact HTTPS redirect-URI allow list", () => {
  it("the one registered address is allowed, compared as plain text", () => {
    expect(inviteRedirectAllowed(CALLBACK, ALLOW)).toBe(true);
    expect(allowedInviteRedirect(ready.config, ALLOW)).toBe(CALLBACK);
  });

  it.each([
    ["trailing slash", `${CALLBACK}/`],
    ["prefix of an allowed entry", `${SITE}/api/integrations/invite`],
    ["suffix added", `${CALLBACK}/x`],
    ["a query", `${CALLBACK}?a=1`],
    ["a fragment", `${CALLBACK}#a`],
    ["http", CALLBACK.replace("https", "http")],
    ["another host", CALLBACK.replace("app.example.test", "evil.example.test")],
    ["a sub-domain of the host", CALLBACK.replace("app.", "x.app.")],
    ["host with the allowed host as a suffix", CALLBACK.replace("app.example.test", "evilapp.example.test")],
    ["upper-case host", CALLBACK.replace("app.example.test", "APP.example.test")],
    ["upper-case path", CALLBACK.replace("invite", "Invite")],
    ["default port written out", CALLBACK.replace("app.example.test", "app.example.test:443")],
    ["another port", CALLBACK.replace("app.example.test", "app.example.test:8443")],
    ["user info", CALLBACK.replace("https://", "https://u:p@")],
    ["dot segments", `${SITE}/api/integrations/x/../invite/callback`],
    ["encoded slash", `${SITE}/api/integrations%2Finvite/callback`],
    ["an empty string", ""],
  ])("refused: %s", (_n, uri) => {
    expect(inviteRedirectAllowed(uri, ALLOW)).toBe(false);
  });

  it("an unset or empty list allows nothing (fails closed)", () => {
    expect(inviteRedirectAllowed(CALLBACK, {})).toBe(false);
    expect(inviteRedirectAllowed(CALLBACK, { XERO_INVITE_REDIRECT_URIS: "" })).toBe(false);
    expect(inviteRedirectAllowed(CALLBACK, { XERO_INVITE_REDIRECT_URIS: " , ," })).toBe(false);
    expect(allowedInviteRedirect(ready.config, {})).toBeNull();
  });

  it("a list entry that is not https, has a wildcard, or is not already in its normal written form is dropped", () => {
    const list = [CALLBACK.replace("https", "http"), "https://*.example.test/api/integrations/invite/callback", "https://app.example.test/api/integrations/invite/*",
      "https://APP.example.test/api/integrations/invite/callback", `${CALLBACK}?x=1`, `${CALLBACK}#f`, "not a url", "https://u:p@app.example.test/cb", "https://app.example.test:443/cb"].join(",");
    expect(inviteRedirectAllowList({ XERO_INVITE_REDIRECT_URIS: list })).toEqual([]);
    expect(inviteRedirectAllowList({ XERO_INVITE_REDIRECT_URIS: `http://x.test/cb, ${CALLBACK} ,https://other.example.test/cb` })).toEqual([CALLBACK, "https://other.example.test/cb"]);
  });

  it("an app whose own redirect origin is not allow-listed starts nothing: nothing used up (redeem) and no state consumed (callback)", async () => {
    const calls: string[] = [];
    const svc = { rpc: async (fn: string) => { calls.push(fn); return { data: null, error: null }; } } as never;
    const other = { XERO_INVITE_REDIRECT_URIS: "https://elsewhere.example.test/api/integrations/invite/callback" };
    expect(await redeemInvite(svc, newInviteRef(), "12345678", ready, other)).toMatchObject({ ok: false, reason: "redirect_not_allowed" });
    expect(await finishInviteConnect(svc, "state", "code", ready, { env: other, fetchImpl: vi.fn() as never })).toMatchObject({ ok: false, reason: "not_configured" });
    expect(calls.every((f) => f === "integration_invite_refusal_log")).toBe(true);
  });
});

describe("the code", () => {
  it("is 8 digits; typed with spaces or hyphens is the same code; anything else is not a code", () => {
    for (let i = 0; i < 50; i += 1) expect(newInviteCode()).toMatch(/^[0-9]{8}$/);
    expect(cleanInviteCode("1234 5678")).toBe("12345678");
    expect(cleanInviteCode(" 1234-5678 ")).toBe("12345678");
    for (const bad of ["", "1234567", "123456789", "abcd5678", "1234 5678 9", 12345678, null, undefined, "1".repeat(100)]) expect(cleanInviteCode(bad)).toBeNull();
  });

  it("only a keyed hash is stored: it depends on the server key, the reference and the code", () => {
    const ref = newInviteRef();
    const h = inviteCodeHash(key, ref, "12345678");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(inviteCodeHash(key, ref, "12345678"));
    expect(h).not.toBe(inviteCodeHash(randomBytes(32), ref, "12345678"));
    expect(h).not.toBe(inviteCodeHash(key, newInviteRef(), "12345678"));
    expect(h).not.toBe(inviteCodeHash(key, ref, "12345679"));
    expect(h).not.toContain("12345678");
  });

  it("issuing: the code itself never goes to the database, only its hash; a refused issue returns no code", async () => {
    const ref = newInviteRef();
    const seen: Array<Record<string, unknown>> = [];
    const ok = { rpc: async (_f: string, a: Record<string, unknown>) => { seen.push(a); return { data: { ok: true, recipient: "a@firm.example", company_name: "Alpha", organization_id: "o", sent_number: 2 }, error: null }; } } as never;
    const out = await issueInviteCode(ok, ref, key);
    expect(out).toMatchObject({ ok: true, recipient: "a@firm.example", sentNumber: 2 });
    if (!out.ok) throw new Error("unreachable");
    expect(seen[0]).toEqual({ p_ref: ref, p_code_hash: inviteCodeHash(key, ref, out.code) });
    expect(JSON.stringify(seen)).not.toContain(out.code);
    for (const reason of ["invalid", "wait", "too_many_codes", "surprise"]) {
      const no = { rpc: async () => ({ data: { ok: false, reason }, error: null }) } as never;
      const r = await issueInviteCode(no, ref, key);
      expect(r).toEqual({ ok: false, reason: reason === "surprise" ? "invalid" : reason });
      expect(JSON.stringify(r)).not.toMatch(/[0-9]{8}/);
    }
  });
});

describe("state and PKCE at the callback", () => {
  it("an unknown or reused state (including an admin's own Connect state) completes nothing and makes no call to Xero", async () => {
    const fetchImpl = vi.fn();
    const svc = { rpc: async () => ({ data: null, error: null }) } as never;
    expect(await finishInviteConnect(svc, "forged-state", "code", ready, { env: ALLOW, fetchImpl: fetchImpl as never })).toMatchObject({ ok: false, reason: "expired" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a PKCE verifier copied from another state's row does not decrypt: no code exchange, nothing stored", async () => {
    const fetchImpl = vi.fn();
    const rpcs: string[] = [];
    const stolen = encryptSecret("someone-elses-verifier", inviteVerifierContext(hashState("another-state")), key);
    const svc = { rpc: async (fn: string) => { rpcs.push(fn); return { data: { organization_id: "o", user_id: "u", verifier_enc: stolen }, error: null }; } } as never;
    await expect(finishInviteConnect(svc, "this-state", "code", ready, { env: ALLOW, fetchImpl: fetchImpl as never })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rpcs).toEqual(["integration_oauth_consume_invite"]);
  });

  it("the invite expired after the code was typed (the database's callback check says so): no code exchange with Xero, nothing stored, the database's correlation id comes back", async () => {
    const fetchImpl = vi.fn();
    const rpcs: string[] = [];
    const corr = "5c1f3b0e-8a64-4f43-9d0a-2f6a7a1e9b11";
    const svc = { rpc: async (fn: string) => { rpcs.push(fn); return { data: { ok: false, reason: "expired", correlation_id: corr }, error: null }; } } as never;
    expect(await finishInviteConnect(svc, "state", "code", ready, { env: ALLOW, fetchImpl: fetchImpl as never })).toEqual({ ok: false, reason: "expired", correlationId: corr });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rpcs).toEqual(["integration_oauth_consume_invite"]);
  });

  it("several Xero organisations ticked: refused closed as before (choose_one), nothing stored", async () => {
    const state = "s";
    const enc = encryptSecret("v", inviteVerifierContext(hashState(state)), key);
    const rpcs: string[] = [];
    const svc = { rpc: async (fn: string) => { rpcs.push(fn); return { data: { organization_id: "o", user_id: "u", verifier_enc: enc }, error: null }; },
      from: () => { const c: Record<string, unknown> = {}; for (const m of ["select", "eq", "neq"]) c[m] = () => c; c.then = (r: (v: unknown) => unknown) => r({ data: [], error: null }); return c; } } as never;
    const at = `h.${Buffer.from(JSON.stringify({ authentication_event_id: "evt" })).toString("base64url")}.s`;
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/connect/token")
      ? new Response(JSON.stringify({ access_token: at, refresh_token: "r", expires_in: 1800 }), { status: 200 })
      : new Response(JSON.stringify([{ id: "c1", tenantId: "t1", tenantName: "A", tenantType: "ORGANISATION", authEventId: "evt" }, { id: "c2", tenantId: "t2", tenantName: "B", tenantType: "ORGANISATION", authEventId: "evt" }]), { status: 200 }));
    expect(await finishInviteConnect(svc, state, "code", ready, { env: ALLOW, fetchImpl: fetchImpl as never })).toEqual({ ok: false, reason: "choose_one" });
    expect(rpcs).not.toContain("integration_store_connection");
  });
});

describe("e-mail: the company's own provider, never a fallback, fail closed, never real", () => {
  const sent: OutgoingEmail[] = [];
  const provider = (outcome: "accepted" | "failed" | "unknown") => ({ name: "mock" as const, send: async (e: OutgoingEmail) => { sent.push(e); return { outcome, detail: "x" }; } });
  const dbSpy = () => { const calls: string[] = []; return { calls, db: { rpc: async (fn: string) => { calls.push(fn); return { data: null, error: null }; } } as never }; };
  beforeEach(() => { sent.length = 0; sendCompanyEmail.mockReset(); });

  it("the code e-mail goes to the one bound address, carries the code, and is NOT written to e-mail history (no ledger call)", async () => {
    const { db, calls } = dbSpy();
    const out = await sendInviteCodeEmail({ organizationId: "o", to: "a@firm.example", companyName: "Alpha", code: "12345678" }, { provider: provider("accepted"), db, env: {} });
    expect(out).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["a@firm.example"]);
    expect(sent[0].cc).toEqual([]);
    expect(sent[0].text).toContain("1234 5678");
    expect(calls).toEqual([]);
  });

  it.each(["failed", "unknown"] as const)("a provider that answers %s is a failure (the page says nothing was sent)", async (outcome) => {
    expect(await sendInviteCodeEmail({ organizationId: "o", to: "a@firm.example", companyName: "A", code: "12345678" }, { provider: provider(outcome), env: {} })).toMatchObject({ ok: false });
  });

  it("no provider (selection answers none): fails closed; EMAIL_PROVIDER=mock on a deployment is refused; a throwing provider is a failure; none of them leaks the code or address", async () => {
    const none = { getToken: async () => null, env: {} as Record<string, string | undefined> };
    for (const deps of [none, { ...none, env: { EMAIL_PROVIDER: "mock", VERCEL_ENV: "production" } }, { provider: { name: "mock" as const, send: async () => { throw new Error("boom a@firm.example 12345678"); } }, env: {} }]) {
      const out = await sendInviteCodeEmail({ organizationId: "o", to: "a@firm.example", companyName: "A", code: "12345678" }, deps);
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toMatch(/12345678|firm\.example/);
    }
  });

  it("on a Vercel preview the recipient must be on the allow list: otherwise nothing is sent", async () => {
    const out = await sendInviteCodeEmail({ organizationId: "o", to: "a@firm.example", companyName: "A", code: "12345678" }, { provider: provider("accepted"), env: { VERCEL_ENV: "preview", EMAIL_RECIPIENT_DOMAINS: "ours.example" } });
    expect(out.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("the link e-mail: through the company mailer with its own ledger, no code in it; a draft or a refusal is NOT a sent e-mail", async () => {
    sendCompanyEmail.mockResolvedValueOnce({ ok: true, mode: "sent", provider: "resend" });
    const url = `${SITE}/api/integrations/invite/${newInviteRef()}`;
    expect(await sendInviteLinkEmail({ organizationId: "o", userId: "u", inviteId: "i1", to: "a@firm.example", companyName: "Alpha", url })).toEqual({ ok: true });
    const [input] = sendCompanyEmail.mock.calls[0] as [{ text: string; to: string[]; requireLedger: boolean; kind: string; idempotencyKey: string }];
    expect(input).toMatchObject({ to: ["a@firm.example"], requireLedger: true, kind: "alert", idempotencyKey: "xero-invite-link:i1" });
    expect(input.text).toContain(url);
    expect(input.text).not.toMatch(/\b[0-9]{8}\b/);
    sendCompanyEmail.mockResolvedValueOnce({ ok: true, mode: "drafted", provider: "none" });
    expect(await sendInviteLinkEmail({ organizationId: "o", userId: "u", inviteId: "i2", to: "a@firm.example", companyName: "A", url })).toMatchObject({ ok: false });
    sendCompanyEmail.mockResolvedValueOnce({ ok: false, code: "no_provider", error: "x" });
    expect(await sendInviteLinkEmail({ organizationId: "o", userId: "u", inviteId: "i3", to: "a@firm.example", companyName: "A", url })).toMatchObject({ ok: false, error: expect.stringContaining("No e-mail sending") });
    sendCompanyEmail.mockRejectedValueOnce(new Error("network a@firm.example"));
    const thrown = await sendInviteLinkEmail({ organizationId: "o", userId: "u", inviteId: "i4", to: "a@firm.example", companyName: "A", url });
    expect(thrown.ok).toBe(false);
    expect(JSON.stringify(thrown)).not.toContain("firm.example");
  });
});

describe("no code, reference, state or hash in a log, a page or an error", () => {
  let logged: string[];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeEach(() => {
    logged = [];
    for (const m of ["error", "warn", "log", "info"] as const) spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.name}:${x.message}` : String(x))).join(" ")); }));
  });
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); vi.resetModules(); vi.unmock("@/lib/server/supabase-admin"); vi.unstubAllEnvs(); });

  it("even when the database's own error text carries the reference and the code, the routes log and answer only fixed words", async () => {
    const ref = newInviteRef();
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", key.toString("base64"));
    vi.stubEnv("XERO_CLIENT_ID", "x-id"); vi.stubEnv("XERO_CLIENT_SECRET", "x-secret");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE); vi.stubEnv("XERO_INVITE_REDIRECT_URIS", CALLBACK);
    const leak = `ref=${ref} code=12345678 hash=${"a".repeat(64)} state=SECRETSTATE`;
    const rpc = vi.fn(async (fn: string) => {
      if (fn === "auth_rate_hit") return { data: true, error: null };
      return { data: null, error: { code: "XX000", message: leak, hint: leak } };
    });
    vi.doMock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({ rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }), limit: async () => ({ data: [], error: null }) }) }) }) }));
    vi.doMock("@/lib/server/auth", async (orig) => ({ ...(await orig<object>()), sameOrigin: () => true }));
    const route = await import("@/app/api/integrations/invite/[ref]/route");
    const callback = await import("@/app/api/integrations/invite/callback/route");
    const params = { params: Promise.resolve({ ref }) };
    const post = (fields: Record<string, string>) => new Request(`${SITE}/api/integrations/invite/${ref}`, { method: "POST", body: new URLSearchParams(fields) });
    const answers = [
      await route.GET(new Request(`${SITE}/api/integrations/invite/${ref}`), params),
      await route.POST(post({ action: "send" }), params),
      await route.POST(post({ action: "verify", code: "12345678" }), params),
      await callback.GET(new Request(`${CALLBACK}?state=SECRETSTATE&code=OAUTHCODE`)),
    ];
    expect(answers.map((r) => r.status)).toEqual([500, 500, 500, 500]);
    const texts = await Promise.all(answers.map((r) => r.text()));
    const everything = [...logged, ...texts, ...answers.map((r) => r.headers.get("location") ?? "")].join("\n");
    for (const secret of [ref, "12345678", "a".repeat(64), "SECRETSTATE", "OAUTHCODE"]) expect(everything).not.toContain(secret);
    expect(logged.length).toBeGreaterThan(0);
    void NextResponse;
  });

  it("the confirm page never carries a code or the full address", async () => {
    const html = await inviteConfirmPage("Alpha", "a***@firm.example", "code_sent").text();
    expect(html).not.toMatch(/[0-9]{8}/);
    expect(html).not.toContain("acct@firm.example");
  });
});
