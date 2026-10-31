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

vi.mock("server-only", () => ({}));

const key = randomBytes(32);
let session: { read_only: boolean; support: boolean } | null = null;
let refuse: number | null = null;
let origin = true;
type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const userRpc = vi.fn<RpcFn>(async () => ({ data: { expires_at: "2026-10-31T15:00:00Z" }, error: null }));
const requireProfile = vi.fn<(roles: string[]) => Promise<unknown>>(async () => (refuse
  ? NextResponse.json({ error: "Forbidden" }, { status: refuse })
  : { supabase: { rpc: userRpc }, user: { id: "u1" }, profile: { organization_id: "org-1", role: "admin" }, session }));
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
  if (fn === "integration_invite_peek") return { data: { provider: "xero", company_name: "Alpha <Ltd>" }, error: null };
  return { data: null, error: null };
});
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

const ENV = { NEXT_PUBLIC_SITE_URL: "https://app.example.test", INTEGRATIONS_ENCRYPTION_KEY: key.toString("base64"), XERO_CLIENT_ID: "x-id", XERO_CLIENT_SECRET: "x-secret" };
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  session = null; refuse = null; platformRefusal = null; table = { data: null, error: null }; origin = true; rate = "ok";
  for (const f of [userRpc, svcRpc, ownerRpc, createSupabaseAdminClient, microsoftReady, requireProfile, ms.beginMicrosoftConnect, ms.disconnectMicrosoft, ms.testMicrosoft]) f.mockClear();
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const post = (url = "https://app.example.test/x", headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers });

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
    expect((await res.json()).error).toBe("Not set up yet: the owner must enter the Microsoft 365 app details.");
    expect(ms.beginMicrosoftConnect).not.toHaveBeenCalled();
  });
});

describe("the accountant's link (create)", () => {
  it("only the token's hash goes to the database; the link is on NEXT_PUBLIC_SITE_URL, never the request's Host", async () => {
    const res = await (await import("@/app/api/integrations/invite/route")).POST(post("https://evil.example.test/api/integrations/invite", { host: "evil.example.test", "x-forwarded-host": "evil.example.test" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.url).toMatch(/^https:\/\/app\.example\.test\/api\/integrations\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = body.url.split("/").pop();
    const [fn, args] = userRpc.mock.calls[0];
    expect(fn).toBe("integration_invite_create");
    expect(args).toEqual({ p_provider: "xero", p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(args)).not.toContain(token);
  });

  it("107 not applied: 'Not available until database update 107 is applied'", async () => {
    userRpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const res = await (await import("@/app/api/integrations/invite/route")).POST(post());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Not available until database update 107 is applied.");
  });
});

describe("opening a link (public)", () => {
  const url = (token: string) => `https://app.example.test/api/integrations/invite/${token}`;
  const route = () => import("@/app/api/integrations/invite/[token]/route");
  const get = async (token: string) => (await route()).GET(new Request(url(token)), { params: Promise.resolve({ token }) });
  const press = async (token: string) => (await route()).POST(new Request(url(token), { method: "POST" }), { params: Promise.resolve({ token }) });
  const fns = () => svcRpc.mock.calls.map((c) => c[0]);
  const good = () => randomBytes(32).toString("base64url");

  it("a malformed link: a fixed 404 page, no database call (GET or POST)", async () => {
    expect((await get("not-a-token")).status).toBe(404);
    expect((await press("not-a-token")).status).toBe(404);
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("GET (a mail scanner, a chat preview, the accountant) only shows 'Connect <company> to Xero' with Continue: nothing is used up", async () => {
    const token = good();
    for (let i = 0; i < 3; i += 1) {
      const res = await get(token);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Connect Alpha &lt;Ltd&gt; to Xero");
      expect(html).toContain('<form method="post"><button type="submit">Continue to Xero</button></form>');
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(fns()).not.toContain("integration_invite_redeem");
    expect(fns().filter((f) => f === "integration_invite_peek")).toHaveLength(3);
  });

  it("GET for a link that isn't open: the same fixed page, nothing used up", async () => {
    svcRpc.mockImplementationOnce(async () => ({ data: true, error: null })).mockImplementationOnce(async () => ({ data: null, error: null }));
    const res = await get(good());
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link can't be used");
    expect(fns()).not.toContain("integration_invite_redeem");
  });

  it("POST (the Continue button): used up through the service role and sent straight to Xero", async () => {
    const res = await press(good());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/login\.xero\.com\//);
    expect(fns()).toEqual(["auth_rate_hit", "integration_invite_redeem"]);
  });

  it("POST from another site is refused before anything", async () => {
    origin = false;
    expect((await press(good())).status).toBe(403);
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("Xero not set up: the link is NOT used up", async () => {
    delete process.env.XERO_CLIENT_ID;
    expect((await press(good())).status).toBe(503);
    expect(fns()).not.toContain("integration_invite_redeem");
  });

  it("rate limited (20 in 15 minutes per IP), and fails closed when the limiter is down: nothing peeked or used up", async () => {
    for (const r of ["over", "down"] as const) {
      rate = r;
      svcRpc.mockClear();
      expect((await get(good())).status).toBe(429);
      expect((await press(good())).status).toBe(429);
      const cb = await (await import("@/app/api/integrations/invite/callback/route")).GET(new Request("https://app.example.test/api/integrations/invite/callback?state=s&code=c"));
      expect(cb.status).toBe(429);
      expect(fns().every((f) => f === "auth_rate_hit")).toBe(true);
    }
    const [, args] = svcRpc.mock.calls[0];
    expect(args).toMatchObject({ p_bucket: "integration_invite", p_window_seconds: 900, p_max: 20 });
  });

  it("the invite callback without a code completes nothing", async () => {
    const res = await (await import("@/app/api/integrations/invite/callback/route")).GET(new Request("https://app.example.test/api/integrations/invite/callback?state=x"));
    expect(res.status).toBe(400);
    expect(svcRpc).not.toHaveBeenCalled();
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
