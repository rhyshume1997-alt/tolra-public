/**
 * E2/E7 (migration 107) route guards. Connect / Disconnect / Test for Microsoft 365, Xero's Test and the accountant's link are an admin's
 * (two-step: requireProfile), and every support session (read-only or elevated) is refused before any service-role client, provider or
 * database call. The app credentials are the platform owner's only (requirePlatformOwner); the secret is encrypted before it reaches the
 * database and never comes back. The link is built on NEXT_PUBLIC_SITE_URL, not the request's Host. When 107 isn't applied the Microsoft
 * card and the link say so and Xero is unchanged. Opening a link while Xero isn't set up doesn't use the link up.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshMfaAuth } from "../support/fresh-mfa";

vi.mock("server-only", () => ({}));

const key = randomBytes(32);
let session: { read_only: boolean; support: boolean } | null = null;
let refuse: number | null = null;
let origin = true;
type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const userRpc = vi.fn<RpcFn>(async () => ({ data: { id: "inv-1", expires_at: "2026-10-31T15:00:00Z", recipient: "a***@firm.example" }, error: null }));
const userFrom = () => { const c: Record<string, unknown> = {}; for (const m of ["select", "eq"]) c[m] = () => c; c.maybeSingle = async () => ({ data: { name: "Alpha Ltd" }, error: null }); return c; };
const requireProfile = vi.fn<(roles: string[]) => Promise<unknown>>(async () => (refuse
  ? NextResponse.json({ error: "Forbidden" }, { status: refuse })
  : { supabase: { rpc: userRpc, from: userFrom, auth: freshMfaAuth() }, user: { id: "u1" }, profile: { organization_id: "org-1", role: "admin" }, session }));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => origin,
  clientIp: () => "203.0.113.7",
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  mfaRequired: () => NextResponse.json({ error: "Confirm your authenticator code first." }, { status: 403 }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile,
}));

/** The service-role client: table reads answer `table`, rpc answers `svcRpc`. */
let table: { data: unknown; error: unknown } = { data: null, error: null };
/** The service role's rpc: the rate limiter allows (auth_rate_hit TRUE) unless `rate` says otherwise; peek finds the company. */
let rate: "ok" | "over" | "down" = "ok";
const svcRpc = vi.fn<RpcFn>(async (fn) => {
  if (fn === "auth_rate_hit") return rate === "down" ? { data: null, error: { code: "57014" } } : { data: rate === "ok", error: null };
  if (fn === "integration_invite_peek") return { data: { provider: "xero", company_name: "Alpha <Ltd>", recipient_hint: "a***@firm.example" }, error: null };
  if (fn === "integration_invite_code_issue") return { data: { ok: true, recipient: "acct@firm.example", company_name: "Alpha <Ltd>", organization_id: "org-1", sent_number: 1 }, error: null };
  if (fn === "integration_invite_code_verify") return { data: verify, error: null };
  if (fn === "integration_oauth_consume_invite") return { data: consume, error: null };
  return { data: null, error: null };
});
/** What integration_oauth_consume_invite answers (null: no such state). */
let consume: unknown = null;
/** What integration_invite_code_verify answers. */
let verify: unknown = { ok: true, organization_id: "org-1", provider: "xero" };
/** The e-mails: the link (admin) and the code (public page). */
const mail = { link: vi.fn(async (_i: unknown) => ({ ok: true }) as { ok: true } | { ok: false; error: string }), code: vi.fn(async (_i: unknown) => ({ ok: true }) as { ok: true } | { ok: false; error: string }) };
vi.mock("@/lib/integrations/invite-mail", () => ({ sendInviteLinkEmail: (i: unknown) => mail.link(i), sendInviteCodeEmail: (i: unknown) => mail.code(i) }));
const serviceClient = () => {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "limit"]) c[m] = () => c;
  c.maybeSingle = async () => table;
  c.then = (resolve: (v: unknown) => unknown) => resolve(table);
  return { from: () => c, rpc: svcRpc };
};
const createSupabaseAdminClient = vi.fn(() => serviceClient());
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient }));

const microsoftReady = vi.fn(async () => ({ config: { clientId: "m", clientSecret: "s", redirectUri: "https://app.example.test/api/integrations/microsoft/callback", tenant: "organizations" }, key }));
vi.mock("@/lib/integrations/microsoft/client", () => ({ microsoftReady }));
const ms = { beginMicrosoftConnect: vi.fn(async () => "https://login.microsoftonline.com/x"), disconnectMicrosoft: vi.fn(async () => undefined), testMicrosoft: vi.fn(async () => ({ mailbox: "office@a.test" })) };
vi.mock("@/lib/integrations/microsoft/connect", () => ms);

let platformRefusal: number | null = null;
const ownerRpc = vi.fn<RpcFn>(async () => ({ data: [], error: null }));
vi.mock("@/lib/server/platform", () => ({
  requirePlatformOwner: vi.fn(async () => (platformRefusal ? NextResponse.json({ error: "Forbidden" }, { status: platformRefusal }) : { supabase: { rpc: ownerRpc }, user: { id: "owner" }, companies: [], admin: {} })),
}));

const ENV = { NEXT_PUBLIC_SITE_URL: "https://app.example.test", INTEGRATIONS_ENCRYPTION_KEY: key.toString("base64"), XERO_CLIENT_ID: "x-id", XERO_CLIENT_SECRET: "x-secret", XERO_INVITE_REDIRECT_URIS: "https://app.example.test/api/integrations/invite/callback" };
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  session = null; refuse = null; platformRefusal = null; table = { data: null, error: null }; origin = true; rate = "ok"; verify = { ok: true, organization_id: "org-1", provider: "xero" }; consume = null;
  mail.link.mockClear(); mail.code.mockClear(); mail.link.mockResolvedValue({ ok: true }); mail.code.mockResolvedValue({ ok: true });
  for (const f of [userRpc, svcRpc, ownerRpc, createSupabaseAdminClient, microsoftReady, requireProfile, ms.beginMicrosoftConnect, ms.disconnectMicrosoft, ms.testMicrosoft]) f.mockClear();
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const post = (url = "https://app.example.test/x", headers: Record<string, string> = {}, body?: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

const adminRoutes = [
  ["microsoft/connect", () => import("@/app/api/integrations/microsoft/connect/route"), "Support access can't change Microsoft 365 settings."],
  ["microsoft/disconnect", () => import("@/app/api/integrations/microsoft/disconnect/route"), "Support access can't change Microsoft 365 settings."],
  ["microsoft/test", () => import("@/app/api/integrations/microsoft/test/route"), "Support access can't change Microsoft 365 settings."],
  ["xero/test", () => import("@/app/api/integrations/xero/test/route"), "Support access can't change Xero settings."],
  ["invite (create)", () => import("@/app/api/integrations/invite/route"), "Support access can't change Xero settings."],
] as const;

describe("admin routes: support sessions and non-admins are refused first", () => {
  it.each(adminRoutes)("%s: read-only and elevated support get 403, before any service-role client, provider or database call", async (_n, load, words) => {
    for (const s of [{ read_only: true, support: true }, { read_only: false, support: true }]) {
      session = s;
      const res = await (await load()).POST(post());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: words });
    }
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(microsoftReady).not.toHaveBeenCalled();
    expect(userRpc).not.toHaveBeenCalled();
    expect(Object.values(ms).some((f) => f.mock.calls.length)).toBe(false);
  });

  it.each(adminRoutes)("%s: admin only (requireProfile(['admin'])), its refusal returned as it is", async (_n, load) => {
    refuse = 403;
    const res = await (await load()).POST(post());
    expect(res.status).toBe(403);
    expect(requireProfile).toHaveBeenCalledWith(["admin"]);
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(userRpc).not.toHaveBeenCalled();
    refuse = 401;
    expect((await (await load()).POST(post())).status).toBe(401);
  });

  it("the company's own admin goes through (Microsoft connect answers the sign-in URL; test says Working)", async () => {
    for (const s of [null, { read_only: false, support: false }]) {
      session = s;
      const res = await (await import("@/app/api/integrations/microsoft/connect/route")).POST(post());
      expect(await res.json()).toEqual({ url: "https://login.microsoftonline.com/x" });
    }
    const t = await (await import("@/app/api/integrations/microsoft/test/route")).POST(post());
    expect(await t.json()).toMatchObject({ ok: true, message: "Working: office@a.test" });
  });

  it("Microsoft connect with no app details: 'Not set up yet' and nothing started", async () => {
    microsoftReady.mockResolvedValueOnce(null as never);
    const res = await (await import("@/app/api/integrations/microsoft/connect/route")).POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Not set up yet: Tolra's Microsoft 365 connection is switched on at go-live. Nothing to do here.", code: "not_configured" });
    expect(ms.beginMicrosoftConnect).not.toHaveBeenCalled();
  });
});

describe("the accountant's link (create)", () => {
  const create = async (body: unknown = { email: "Acct@Firm.example" }, headers: Record<string, string> = {}) =>
    (await import("@/app/api/integrations/invite/route")).POST(post("https://app.example.test/api/integrations/invite", headers, body));

  it("an opaque reference and the recipient go to the database; the link is E-MAILED on NEXT_PUBLIC_SITE_URL (never the request's Host) and is NOT in the answer", async () => {
    const res = await create({ email: "Acct@Firm.example" }, { host: "evil.example.test", "x-forwarded-host": "evil.example.test" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "inv-1", sent: true, recipient: "a***@firm.example", expiresAt: "2026-10-31T15:00:00Z" });
    expect(JSON.stringify(body)).not.toMatch(/https?:|invite\//);
    const [fn, args] = userRpc.mock.calls[0];
    expect(fn).toBe("integration_invite_create");
    expect(args).toEqual({ p_provider: "xero", p_ref: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), p_recipient: "acct@firm.example" });
  });

  it("the e-mail carries the link with that reference; no token hash anywhere", async () => {
    userRpc.mockResolvedValueOnce({ data: { id: "inv-1", expires_at: "2026-10-31T15:00:00Z", recipient: "a***@firm.example" }, error: null });
    const res = await create();
    expect(res.status).toBe(200);
    const [input] = mail.link.mock.calls[0] as [{ url: string; to: string; inviteId: string }];
    const ref = (userRpc.mock.calls[0][1] as { p_ref: string }).p_ref;
    expect(input).toMatchObject({ url: `https://app.example.test/api/integrations/invite/${ref}`, to: "acct@firm.example", inviteId: "inv-1" });
    expect((await res.json()).recipient).toBe("a***@firm.example");
  });

  it("fails closed: if the e-mail can't be sent the invite is cancelled again and the admin is told why (no link is returned)", async () => {
    userRpc.mockResolvedValueOnce({ data: { id: "inv-1", expires_at: "x", recipient: "a***@firm.example" }, error: null });
    mail.link.mockResolvedValueOnce({ ok: false, error: "No e-mail sending is set up for this company, so the invite was not sent." });
    const res = await create();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("No e-mail sending is set up");
    expect(userRpc).toHaveBeenLastCalledWith("integration_invite_revoke", { p_invite: "inv-1" });
  });

  it.each([{}, { email: "" }, { email: "not-an-address" }, { email: "a@b.example", extra: 1 }, { email: "a@b.example\r\nbcc:x@y.example" }, { email: 5 }])("a bad address or body %j is refused before any database call", async (body) => {
    expect((await create(body)).status).toBe(400);
    expect(userRpc).not.toHaveBeenCalled();
    expect(mail.link).not.toHaveBeenCalled();
  });

  it("the redirect address must be on the exact allow list: unset, near-miss or http means no invite is made", async () => {
    for (const v of [undefined, "", "https://app.example.test/api/integrations/invite/callback/", "http://app.example.test/api/integrations/invite/callback", "https://app.example.test/api/integrations/invite/*", "https://app.example.test"]) {
      if (v === undefined) delete process.env.XERO_INVITE_REDIRECT_URIS; else process.env.XERO_INVITE_REDIRECT_URIS = v;
      expect((await create()).status).toBe(503);
    }
    expect(userRpc).not.toHaveBeenCalled();
    expect(mail.link).not.toHaveBeenCalled();
  });

  it("151 not applied: 'Not available until database update 151 is applied'", async () => {
    userRpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const res = await create();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Not available until database update 151 is applied.");
    expect(mail.link).not.toHaveBeenCalled();
  });
});

describe("opening a link (public)", () => {
  const url = (ref: string) => `https://app.example.test/api/integrations/invite/${ref}`;
  const route = () => import("@/app/api/integrations/invite/[ref]/route");
  const get = async (ref: string) => (await route()).GET(new Request(url(ref)), { params: Promise.resolve({ ref }) });
  const press = async (ref: string, fields: Record<string, string> = { action: "verify", code: "1234 5678" }) =>
    (await route()).POST(new Request(url(ref), { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } }), { params: Promise.resolve({ ref }) });
  const fns = () => svcRpc.mock.calls.map((c) => c[0]);
  const good = () => randomBytes(16).toString("base64url");

  it("a malformed link (including an old 43-character token): a fixed 404 page, no database call (GET or POST)", async () => {
    for (const bad of ["not-a-ref", randomBytes(32).toString("base64url")]) {
      expect((await get(bad)).status).toBe(404);
      expect((await press(bad)).status).toBe(404);
    }
    // Nothing about an invite is asked: only the rate limiter and the security log (a refusal each) are written.
    expect(fns().every((f) => f === "auth_rate_hit" || f === "integration_invite_refusal_log")).toBe(true);
    expect(fns().filter((f) => f === "integration_invite_refusal_log")).toHaveLength(4);
  });

  it("GET (a mail scanner, a chat preview, the accountant) only shows the company, the MASKED address and the two forms: nothing is used up, nothing is sent", async () => {
    const ref = good();
    for (let i = 0; i < 3; i += 1) {
      const res = await get(ref);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Connect Alpha &lt;Ltd&gt; to Xero");
      expect(html).toContain("a***@firm.example");
      expect(html).toContain('name="action" value="send"');
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(fns()).not.toContain("integration_invite_code_verify");
    expect(fns()).not.toContain("integration_invite_code_issue");
    expect(fns().filter((f) => f === "integration_invite_peek")).toHaveLength(3);
    expect(mail.code).not.toHaveBeenCalled();
  });

  it("GET for a link that isn't open: the same fixed page, nothing used up", async () => {
    svcRpc.mockImplementationOnce(async () => ({ data: true, error: null })).mockImplementationOnce(async () => ({ data: null, error: null }));
    const res = await get(good());
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link can't be used");
    expect(fns()).not.toContain("integration_invite_code_verify");
  });

  it("'E-mail me a code': the code goes only to the address the database says the invite is bound to, and is not in the page", async () => {
    const res = await press(good(), { action: "send", to: "attacker@evil.example", email: "attacker@evil.example" });
    expect(res.status).toBe(200);
    const [input] = mail.code.mock.calls[0] as [{ to: string; code: string; organizationId: string }];
    expect(input.to).toBe("acct@firm.example");
    expect(input.organizationId).toBe("org-1");
    expect(input.code).toMatch(/^[0-9]{8}$/);
    const html = await res.text();
    expect(html).not.toContain(input.code);
    expect(html).toContain("a***@firm.example");
    expect(fns()).toEqual(["auth_rate_hit", "integration_invite_code_issue"]);
    const [, args] = svcRpc.mock.calls[1];
    expect(JSON.stringify(args)).not.toContain(input.code);
  });

  it("'E-mail me a code' when the e-mail can't be sent: a fixed failure page, nothing used up", async () => {
    mail.code.mockResolvedValueOnce({ ok: false, error: "x" });
    const res = await press(good(), { action: "send" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("The code couldn&#39;t be sent".replace("&#39;", "'"));
    expect(fns()).not.toContain("integration_invite_code_verify");
  });

  it("too many codes / too soon: refused with a fixed notice, nothing e-mailed", async () => {
    svcRpc.mockImplementationOnce(async () => ({ data: true, error: null })).mockImplementationOnce(async () => ({ data: { ok: false, reason: "wait" }, error: null }));
    const res = await press(good(), { action: "send" });
    expect(res.status).toBe(429);
    expect(mail.code).not.toHaveBeenCalled();
  });

  it("verify with the right code: used up through the service role and sent straight to Xero", async () => {
    const res = await press(good());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/login\.xero\.com\//);
    expect(res.headers.get("location")).toContain("redirect_uri=" + encodeURIComponent("https://app.example.test/api/integrations/invite/callback"));
    expect(fns()).toEqual(["auth_rate_hit", "integration_invite_code_verify"]);
  });

  it("verify with a wrong code: 400 with a fixed notice, never Xero; locked: a fixed page; expired code: asks for a new one", async () => {
    verify = { ok: false, reason: "wrong_code", attempts_left: 3 };
    let res = await press(good());
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("That code isn&#39;t right".replace("&#39;", "'"));
    verify = { ok: false, reason: "locked" };
    res = await press(good());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("This link is locked");
    verify = { ok: false, reason: "code_expired" };
    res = await press(good());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("run out");
    verify = { ok: false, reason: "invalid" };
    expect((await press(good())).status).toBe(404);
  });

  it("verify with something that isn't 8 digits: refused before the database counts an attempt", async () => {
    for (const code of ["", "1234567", "123456789", "abcdefgh", "1234 567x"]) {
      svcRpc.mockClear();
      expect((await press(good(), { action: "verify", code })).status).toBe(400);
      expect(fns()).not.toContain("integration_invite_code_verify");
    }
  });

  it("an unknown action does nothing", async () => {
    expect((await press(good(), { action: "peek" })).status).toBe(400);
    expect(fns()).toEqual(["auth_rate_hit"]);
  });

  it("POST from another site is refused before anything but the security log", async () => {
    origin = false;
    expect((await press(good())).status).toBe(403);
    expect(fns()).toEqual(["integration_invite_refusal_log"]);
  });

  it("Xero not set up, or the redirect address off the allow list: nothing is used up or sent", async () => {
    delete process.env.XERO_CLIENT_ID;
    expect((await press(good())).status).toBe(503);
    process.env.XERO_CLIENT_ID = "x-id";
    process.env.XERO_INVITE_REDIRECT_URIS = "https://app.example.test/api/integrations/invite/callback/";
    expect((await press(good(), { action: "send" })).status).toBe(503);
    expect((await press(good())).status).toBe(503);
    expect(fns()).not.toContain("integration_invite_code_verify");
    expect(fns()).not.toContain("integration_invite_code_issue");
  });

  it("rate limited (20 in 15 minutes per IP), and fails closed when the limiter is down: nothing peeked, sent or used up", async () => {
    for (const r of ["over", "down"] as const) {
      rate = r;
      svcRpc.mockClear();
      expect((await get(good())).status).toBe(429);
      expect((await press(good())).status).toBe(429);
      const cb = await (await import("@/app/api/integrations/invite/callback/route")).GET(new Request("https://app.example.test/api/integrations/invite/callback?state=s&code=c"));
      expect(cb.status).toBe(429);
      expect(fns().every((f) => f === "auth_rate_hit" || f === "integration_invite_refusal_log")).toBe(true);
    }
    const [, args] = svcRpc.mock.calls[0];
    expect(args).toMatchObject({ p_bucket: "integration_invite", p_window_seconds: 900, p_max: 20 });
  });

  it("the invite callback without a code completes nothing", async () => {
    const res = await (await import("@/app/api/integrations/invite/callback/route")).GET(new Request("https://app.example.test/api/integrations/invite/callback?state=x"));
    expect(res.status).toBe(400);
    expect(fns()).toEqual(["integration_invite_refusal_log"]);
  });
});

const CORR = "5c1f3b0e-8a64-4f43-9d0a-2f6a7a1e9b11";
const UUID_IN_PAGE = /Reference: <code>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})<\/code>/;

describe("BLOCK: untraceable refusals (routes)", () => {
  const ref = randomBytes(16).toString("base64url");
  const route = () => import("@/app/api/integrations/invite/[ref]/route");
  const get = async (r: string) => (await route()).GET(new Request(`https://app.example.test/api/integrations/invite/${r}`), { params: Promise.resolve({ ref: r }) });
  const press = async (fields: Record<string, string>, r = ref) =>
    (await route()).POST(new Request(`https://app.example.test/api/integrations/invite/${r}`, { method: "POST", body: new URLSearchParams(fields) }), { params: Promise.resolve({ ref: r }) });
  const logs = () => svcRpc.mock.calls.filter((c) => c[0] === "integration_invite_refusal_log").map((c) => c[1] as Record<string, unknown>);
  const idOf = async (res: Response) => UUID_IN_PAGE.exec(await res.text())?.[1];

  it("the page for a malformed reference, for an invite that isn't open and when rate limited: each answers with a reference id that is exactly the id written to the security log", async () => {
    svcRpc.mockClear();
    let res = await get("not-a-ref");
    let id = await idOf(res);
    expect(id).toBeDefined();
    expect(logs().at(-1)).toMatchObject({ p_step: "page", p_reason: "malformed_ref", p_correlation: id });
    svcRpc.mockImplementationOnce(async () => ({ data: true, error: null })).mockImplementationOnce(async () => ({ data: null, error: null }));
    res = await get(ref);
    id = await idOf(res);
    expect(id).toBeDefined();
    expect(logs().at(-1)).toMatchObject({ p_step: "page", p_reason: "not_open", p_correlation: id });
    rate = "over";
    res = await get(ref);
    id = await idOf(res);
    expect(res.status).toBe(429);
    expect(logs().at(-1)).toMatchObject({ p_step: "request", p_reason: "rate_limited", p_correlation: id });
  });

  it("wrong code, locked, expired invite and the code e-mail failing: each page shows the database's correlation id (or the app's own), never the reference or the code", async () => {
    verify = { ok: false, reason: "wrong_code", attempts_left: 2, correlation_id: CORR };
    let res = await press({ action: "verify", code: "12345678" });
    let html = await res.text();
    expect(html).toContain(CORR);
    for (const secret of [ref, "12345678"]) expect(html).not.toContain(secret);
    verify = { ok: false, reason: "locked", correlation_id: CORR };
    expect(await (await press({ action: "verify", code: "12345678" })).text()).toContain(CORR);
    verify = { ok: false, reason: "invalid", correlation_id: CORR };
    res = await press({ action: "verify", code: "12345678" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(CORR);
    verify = { ok: false, reason: "invalid", correlation_id: "<script>alert(1)</script>" }; // a bad id from the database is never printed
    html = await (await press({ action: "verify", code: "12345678" })).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("Reference:");
    svcRpc.mockClear();
    mail.code.mockResolvedValueOnce({ ok: false, error: "x" });
    res = await press({ action: "send" });
    const id = await idOf(res);
    expect(logs().at(-1)).toMatchObject({ p_step: "code", p_reason: "mail_failed", p_correlation: id });
    expect(id).toBeDefined();
  });

  it("a request from another site, and an unknown action's neighbours: the cross-site refusal is traced too", async () => {
    origin = false;
    svcRpc.mockClear();
    const res = await press({ action: "verify", code: "12345678" });
    expect(res.status).toBe(403);
    expect(logs().at(-1)).toMatchObject({ p_step: "request", p_reason: "bad_origin", p_correlation: await idOf(res) });
  });
});

describe("the callback after expiry (route): no code exchange, no connection stored", () => {
  const callback = async (q = "?state=the-state&code=the-code") => (await import("@/app/api/integrations/invite/callback/route")).GET(new Request(`https://app.example.test/api/integrations/invite/callback${q}`));
  const fns = () => svcRpc.mock.calls.map((c) => c[0]);

  it("the database says the invite expired: Xero is never called, nothing is stored, the page says so with the database's reference", async () => {
    consume = { ok: false, reason: "expired", correlation_id: CORR };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const res = await callback();
      expect(res.status).toBe(409);
      const html = await res.text();
      expect(html).toContain("That took too long");
      expect(html).toContain(CORR);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fns()).toEqual(["auth_rate_hit", "integration_oauth_consume_invite"]);
      expect(fns()).not.toContain("integration_store_connection");
    } finally { vi.unstubAllGlobals(); }
  });

  it("an unknown or used state: refused with its own traced reference, nothing exchanged", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const res = await callback();
      expect(res.status).toBe(409);
      const id = UUID_IN_PAGE.exec(await res.text())?.[1];
      expect(id).toBeDefined();
      const logged = svcRpc.mock.calls.filter((c) => c[0] === "integration_invite_refusal_log").map((c) => c[1] as Record<string, unknown>);
      expect(logged.at(-1)).toMatchObject({ p_step: "callback", p_reason: "callback_state", p_correlation: id });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("Xero hands back an error, a missing code, or too many requests: each is traced and shows its reference", async () => {
    for (const q of ["?error=access_denied", "?state=x", "?state=s&code=c"]) {
      svcRpc.mockClear();
      rate = q === "?state=s&code=c" ? "over" : "ok";
      const res = await callback(q);
      const id = UUID_IN_PAGE.exec(await res.text())?.[1];
      expect(id, q).toBeDefined();
      expect(svcRpc.mock.calls.some((c) => c[0] === "integration_invite_refusal_log" && (c[1] as { p_correlation: string }).p_correlation === id), q).toBe(true);
    }
  });
});

describe("cancelling an open link (DELETE /api/integrations/invite?id=)", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const del = async (q = `?id=${id}`) => (await import("@/app/api/integrations/invite/route")).DELETE(new Request(`https://app.example.test/api/integrations/invite${q}`, { method: "DELETE" }));

  it("support sessions and non-admins are refused before any database call", async () => {
    for (const s of [{ read_only: true, support: true }, { read_only: false, support: true }]) {
      session = s;
      expect((await del()).status).toBe(403);
    }
    session = null;
    refuse = 403;
    expect((await del()).status).toBe(403);
    expect(userRpc).not.toHaveBeenCalled();
  });

  it("the admin cancels it through integration_invite_revoke; a link no longer open is 404; a bad id is 400", async () => {
    userRpc.mockResolvedValueOnce({ data: true, error: null });
    expect((await del()).status).toBe(200);
    expect(userRpc).toHaveBeenCalledWith("integration_invite_revoke", { p_invite: id });
    userRpc.mockResolvedValueOnce({ data: false, error: null });
    expect((await del()).status).toBe(404);
    userRpc.mockClear();
    expect((await del("?id=nope")).status).toBe(400);
    expect(userRpc).not.toHaveBeenCalled();
  });
});

describe("status: what the page may offer", () => {
  it("107 not applied (table missing): db107 false, Xero still configured from the environment, Microsoft not", async () => {
    table = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.integration_connect_invites' in the schema cache" } };
    const res = await (await import("@/app/api/integrations/status/route")).GET();
    expect(await res.json()).toEqual({ db107: false, xero: { configured: true }, microsoft: { configured: false } });
  });

  it("a XERO_REDIRECT_URI that isn't exactly right: 'not set up' names the value expected", async () => {
    process.env.XERO_REDIRECT_URI = "https://app.example.test/api/integrations/xero/callback?x=1";
    const body = await (await (await import("@/app/api/integrations/status/route")).GET()).json();
    expect(body.xero).toEqual({ configured: false, problem: "XERO_REDIRECT_URI must be exactly https://app.example.test/api/integrations/xero/callback (https, no query)." });
    delete process.env.XERO_REDIRECT_URI;
  });

  it("107 applied, nothing stored and no Microsoft env: Microsoft 'not set up'", async () => {
    const res = await (await import("@/app/api/integrations/status/route")).GET();
    expect(await res.json()).toEqual({ db107: true, xero: { configured: true }, microsoft: { configured: false } });
  });

  it("admin only", async () => {
    refuse = 403;
    expect((await (await import("@/app/api/integrations/status/route")).GET()).status).toBe(403);
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});

describe("app credentials: the platform owner only; the secret never comes back", () => {
  const req = (method: string, body?: unknown, q = "") => new Request(`https://app.example.test/api/integrations/app-credentials${q}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
  const route = () => import("@/app/api/integrations/app-credentials/route");

  it("anyone but the platform owner (company admins included) is refused before any database call", async () => {
    platformRefusal = 403;
    for (const [m, r] of [["GET", req("GET")], ["POST", req("POST", { provider: "xero", clientId: "a", clientSecret: "b" })], ["DELETE", req("DELETE", undefined, "?provider=xero")]] as const) {
      const res = await (await route())[m](r);
      expect(res.status).toBe(403);
    }
    expect(ownerRpc).not.toHaveBeenCalled();
  });

  it("save: the secret is encrypted on the server (last 4 only stored in clear) and not in the answer", async () => {
    const { decryptSecret } = await import("@/lib/integrations/crypto");
    const { appSecretContext } = await import("@/lib/integrations/app-credentials");
    const res = await (await route()).POST(req("POST", { provider: "microsoft", clientId: "client-1", clientSecret: "SuperSecretValue1234" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("SuperSecretValue");
    const [fn, args] = ownerRpc.mock.calls[0];
    expect(fn).toBe("integration_app_credentials_save");
    expect(args).toMatchObject({ p_provider: "microsoft", p_client_id: "client-1", p_secret_last4: "1234", p_redirect_uri: "https://app.example.test/api/integrations/microsoft/callback" });
    expect(String(args!.p_secret_enc)).not.toContain("SuperSecret");
    expect(decryptSecret(String(args!.p_secret_enc), appSecretContext("microsoft"), key)).toBe("SuperSecretValue1234");
  });

  it("list: client id and last 4 only, with the redirect URIs to register (Xero: its own and the accountant's)", async () => {
    ownerRpc.mockResolvedValueOnce({ data: [{ provider: "xero", client_id: "cid", client_secret_last4: "WXYZ", redirect_uri: null, updated_at: "2026-10-30T12:00:00Z" }], error: null });
    const body = await (await (await route()).GET(req("GET"))).json();
    const xero = body.providers.find((p: { provider: string }) => p.provider === "xero");
    expect(xero.stored).toEqual({ clientId: "cid", secretLast4: "WXYZ", updatedAt: "2026-10-30T12:00:00Z" });
    expect(xero.redirectUris).toEqual(["https://app.example.test/api/integrations/xero/callback", "https://app.example.test/api/integrations/invite/callback"]);
    expect(body.providers.find((p: { provider: string }) => p.provider === "microsoft").redirectUris).toEqual(["https://app.example.test/api/integrations/microsoft/callback"]);
    expect(JSON.stringify(body)).not.toMatch(/secret_enc|clientSecret/);
  });

  it("107 not applied: the list says so (db107 false) instead of failing", async () => {
    ownerRpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function public.integration_app_credentials_list" } });
    const body = await (await (await route()).GET(req("GET"))).json();
    expect(body.db107).toBe(false);
  });
});
