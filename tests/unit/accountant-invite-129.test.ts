/**
 * C3 "Invite your accountant" (migration 129), the routes and the page (the database rules are proven in tests/scripts/accountant-invite-129.proof.sql):
 *  - create: admin only, the second step (aal2) always, never support; only the token's SHA-256 goes to the database; the link is on
 *    NEXT_PUBLIC_SITE_URL; the database's refusals in plain words. "Also connect Xero" uses the existing Xero connect link (107), only while
 *    Xero is set up here and not connected; otherwise the invite is made without it and says why.
 *  - revoke: admin, own company (the database), 404 for one no longer open.
 *  - the accountant's page: nothing is used up by opening it; the Xero offer only for an open 107 link while Xero is set up and not
 *    connected; join uses the browser's OWN session (signed out: "Sign in first"); new e-mails the invite's own address only.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SITE = "https://app.example.test";
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

let isAdmin = true;
let session: { support: boolean } | null = null;
let aal2 = true;
let sameOriginOk = true;
let xeroReadyValue: unknown = null;
let xeroStatus = "not_connected";
let signedIn: { id: string } | null = { id: "acct-1" };
let createResult: { data: unknown; error: unknown } = { data: { id: "inv-1", email: "acct@firm.example", expires_at: "2026-11-08T12:00:00Z" }, error: null };
let redeemResult: { data: unknown; error: unknown } = { data: { status: "joined" }, error: null };
let peek: unknown = { company_name: "Alpha <Ltd>", email: "acct@firm.example", expires_at: "2026-11-08T12:00:00Z", xero_connected: false };
let xeroPeek: unknown = { provider: "xero", company_name: "Alpha <Ltd>" };
let inviteEmailError: unknown = null;

const userRpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
  void args;
  if (fn === "create_accountant_invite") return createResult;
  if (fn === "revoke_accountant_invite") return { data: true, error: null };
  if (fn === "integration_overview") return { data: { status: xeroStatus }, error: null };
  if (fn === "integration_invite_create") return { data: { id: "x-1" }, error: null };
  if (fn === "redeem_accountant_invite") return redeemResult;
  return { data: null, error: null };
});
const userClient = () => ({
  rpc: userRpc,
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Alpha Ltd" }, error: null }) }) }) }),
  auth: { getUser: async () => ({ data: { user: signedIn } }) },
});
const inviteUserByEmail = vi.fn(async (email: string, opts?: unknown) => { void email; void opts; return { data: {}, error: inviteEmailError }; });
const service = {
  rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
    void args;
    if (fn === "auth_rate_hit") return { data: true, error: null };
    if (fn === "accountant_invite_peek") return { data: peek, error: null };
    if (fn === "integration_invite_peek") return { data: xeroPeek, error: null };
    return { data: null, error: null };
  }),
  auth: { admin: { inviteUserByEmail } },
};

vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => sameOriginOk,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  mfaRequired: () => NextResponse.json({ error: "Confirm your authenticator code first.", code: "mfa_required" }, { status: 403 }),
  clientIp: () => "203.0.113.9",
  createSupabaseServerClient: async () => userClient(),
  requireProfile: vi.fn(async () => (isAdmin ? { supabase: userClient(), user: { id: "admin-1" }, profile: { organization_id: "org-1", role: "admin" }, session }
    : NextResponse.json({ error: "Forbidden" }, { status: 403 }))),
}));
vi.mock("@/lib/server/admin-users", () => ({
  requireAal2: async () => (aal2 ? null : NextResponse.json({ error: "Confirm your authenticator code first.", code: "mfa_required" }, { status: 403 })),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => service }));
vi.mock("@/lib/integrations/server", async (orig) => ({ ...(await orig<object>()), xeroReady: vi.fn(async () => xeroReadyValue) }));

beforeEach(() => {
  isAdmin = true; session = null; aal2 = true; sameOriginOk = true; xeroReadyValue = null; xeroStatus = "not_connected"; signedIn = { id: "acct-1" };
  createResult = { data: { id: "inv-1", email: "acct@firm.example", expires_at: "2026-11-08T12:00:00Z" }, error: null };
  redeemResult = { data: { status: "joined" }, error: null };
  peek = { company_name: "Alpha <Ltd>", email: "acct@firm.example", expires_at: "2026-11-08T12:00:00Z", xero_connected: false };
  xeroPeek = { provider: "xero", company_name: "Alpha <Ltd>" };
  inviteEmailError = null;
  userRpc.mockClear(); service.rpc.mockClear(); inviteUserByEmail.mockClear();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
});

const TOKEN = "A".repeat(43);
const XTOKEN = "B".repeat(43);
const create = (body: unknown) => new Request(`${SITE}/api/integrations/accountant-invite`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const pageGet = (search = "", token = TOKEN) => new Request(`${SITE}/api/integrations/accountant-invite/${token}${search}`);
const pagePost = (action: string, search = "") => {
  const form = new FormData();
  form.set("action", action);
  return new Request(`${SITE}/api/integrations/accountant-invite/${TOKEN}${search}`, { method: "POST", body: form });
};
const params = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const callsOf = (fn: string) => userRpc.mock.calls.filter(([name]) => name === fn);

describe("create (POST /api/integrations/accountant-invite)", () => {
  it("an admin with the second step gets a link on the site address; only the token's SHA-256 goes to the database", async () => {
    const { POST } = await import("@/app/api/integrations/accountant-invite/route");
    const res = await POST(create({ email: "  Acct@Firm.Example " }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const url = new URL(body.url);
    expect(`${url.origin}${url.pathname}`).toMatch(new RegExp(`^${SITE}/api/integrations/accountant-invite/[A-Za-z0-9_-]{43}$`));
    const token = url.pathname.split("/").pop()!;
    const [[, args]] = callsOf("create_accountant_invite");
    expect(args).toEqual({ p_email: "acct@firm.example", p_token_hash: sha(token) });
    expect(JSON.stringify(args)).not.toContain(token);
    expect(body).toMatchObject({ email: "acct@firm.example", xero: false, xeroProblem: null, expiresAt: "2026-11-08T12:00:00Z" });
    expect(body.mailto).toMatch(/^mailto:acct%40firm\.example\?subject=/);
    expect(decodeURIComponent(body.mailto)).toContain(body.url);
    expect(callsOf("integration_invite_create")).toHaveLength(0);
  });

  it("refused: not an admin, a support session, no second step (aal1), a bad e-mail; nothing reaches the database", async () => {
    const { POST } = await import("@/app/api/integrations/accountant-invite/route");
    isAdmin = false;
    expect((await POST(create({ email: "a@b.example" }))).status).toBe(403);
    isAdmin = true; session = { support: true };
    expect((await POST(create({ email: "a@b.example" }))).status).toBe(403);
    session = null; aal2 = false;
    const mfa = await POST(create({ email: "a@b.example" }));
    expect(mfa.status).toBe(403);
    expect((await mfa.json()).code).toBe("mfa_required");
    aal2 = true;
    expect((await POST(create({ email: "not an email" }))).status).toBe(400);
    sameOriginOk = false;
    expect((await POST(create({ email: "a@b.example" }))).status).toBe(403);
    expect(callsOf("create_accountant_invite")).toHaveLength(0);
  });

  it("the database's refusals: already a member or invited 409, second step 403, update 129 missing 503", async () => {
    const { POST } = await import("@/app/api/integrations/accountant-invite/route");
    createResult = { data: null, error: { code: "23505", hint: "already_member", message: "That e-mail already has a login in this company: change their access in Settings > Users." } };
    const member = await POST(create({ email: "a@b.example" }));
    expect(member.status).toBe(409);
    expect((await member.json()).error).toContain("Settings > Users");
    createResult = { data: null, error: { code: "42501", hint: "mfa_required", message: "x" } };
    expect((await POST(create({ email: "a@b.example" }))).status).toBe(403);
    createResult = { data: null, error: { code: "PGRST202", message: "x" } };
    const missing = await POST(create({ email: "a@b.example" }));
    expect(missing.status).toBe(503);
    expect((await missing.json()).error).toBe("Not available until database update 129 is applied.");
  });

  it("'Also connect Xero': the existing connect link, only while Xero is set up and not connected", async () => {
    const { POST } = await import("@/app/api/integrations/accountant-invite/route");
    // Xero not set up on this server: no Xero step, and the answer says why.
    let body = await (await POST(create({ email: "a@b.example", connectXero: true }))).json();
    expect(body.xero).toBe(false);
    expect(body.xeroProblem).toContain("isn't set up");
    expect(new URL(body.url).searchParams.get("xero")).toBeNull();
    expect(callsOf("integration_invite_create")).toHaveLength(0);
    // Set up, already connected: no Xero step.
    xeroReadyValue = { config: {}, key: Buffer.alloc(32) }; xeroStatus = "connected";
    body = await (await POST(create({ email: "a@b.example", connectXero: true }))).json();
    expect(body.xero).toBe(false);
    expect(body.xeroProblem).toContain("already connected");
    expect(callsOf("integration_invite_create")).toHaveLength(0);
    // Set up, not connected: 107's link is made (its hash only) and carried on the accountant's link.
    xeroStatus = "not_connected";
    body = await (await POST(create({ email: "a@b.example", connectXero: true }))).json();
    expect(body.xero).toBe(true);
    const xero = new URL(body.url).searchParams.get("xero")!;
    expect(xero).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(callsOf("integration_invite_create")[0][1]).toEqual({ p_provider: "xero", p_token_hash: sha(xero) });
  });
});

describe("revoke (DELETE /api/integrations/accountant-invite?id=)", () => {
  it("admin only; a malformed id 400; one no longer open 404", async () => {
    const { DELETE } = await import("@/app/api/integrations/accountant-invite/route");
    const id = "11111111-1111-4111-8111-111111111111";
    const del = (q: string) => new Request(`${SITE}/api/integrations/accountant-invite?id=${q}`, { method: "DELETE" });
    expect((await DELETE(del(id))).status).toBe(200);
    expect(callsOf("revoke_accountant_invite")[0][1]).toEqual({ p_invite: id });
    expect((await DELETE(del("nope"))).status).toBe(400);
    userRpc.mockImplementationOnce(async () => ({ data: false, error: null }));
    expect((await DELETE(del(id))).status).toBe(404);
    isAdmin = false;
    expect((await DELETE(del(id))).status).toBe(403);
  });
});

describe("the accountant's page (/api/integrations/accountant-invite/[token])", () => {
  it("GET: an open invite's company and masked e-mail, nothing used up; anything else a fixed page", async () => {
    const { GET } = await import("@/app/api/integrations/accountant-invite/[token]/route");
    const res = await GET(pageGet(), params());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join Alpha &lt;Ltd&gt; on Tolra");
    expect(html).toContain("a***@firm.example");
    expect(html).not.toContain("acct@firm.example");
    expect(html).not.toContain("Also connect Xero");
    expect(service.rpc.mock.calls.find(([fn]) => fn === "accountant_invite_peek")?.[1]).toEqual({ p_token_hash: sha(TOKEN) });
    expect(userRpc).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    peek = null;
    expect((await GET(pageGet(), params())).status).toBe(404);
    expect((await GET(pageGet("", "short"), params("short"))).status).toBe(404);
  });

  it("the Xero offer: only for an open 107 link, while Xero is set up here and the company's Xero is not connected", async () => {
    const { GET } = await import("@/app/api/integrations/accountant-invite/[token]/route");
    const offered = async () => (await (await GET(pageGet(`?xero=${XTOKEN}`), params())).text()).includes(`/api/integrations/invite/${XTOKEN}`);
    expect(await offered()).toBe(false); // Xero not set up: hidden (the not-set-up state)
    xeroReadyValue = { config: {}, key: Buffer.alloc(32) };
    expect(await offered()).toBe(true);
    peek = { company_name: "Alpha", email: "acct@firm.example", expires_at: "x", xero_connected: true };
    expect(await offered()).toBe(false); // already connected
    peek = { company_name: "Alpha", email: "acct@firm.example", expires_at: "x", xero_connected: false };
    xeroPeek = null;
    expect(await offered()).toBe(false); // the Xero link is used, cancelled or expired
  });

  it("POST join: the browser's own session redeems (the token's hash); signed out: Sign in first; refusals in plain words", async () => {
    const { POST } = await import("@/app/api/integrations/accountant-invite/[token]/route");
    let res = await POST(pagePost("join"), params());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You're in");
    expect(callsOf("redeem_accountant_invite")[0][1]).toEqual({ p_token_hash: sha(TOKEN) });
    redeemResult = { data: { status: "already_member" }, error: null };
    expect(await (await POST(pagePost("join"), params())).text()).toContain("Nothing about your access changed");
    for (const [hint, words] of [["invite_other_email", "another e-mail"], ["membership_inactive", "switched off"], ["invite_invalid", "can't be used"], ["mfa_required", "authenticator"]]) {
      redeemResult = { data: null, error: { code: "42501", hint, message: "db text" } };
      res = await POST(pagePost("join"), params());
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain(words);
      expect(html).not.toContain("db text");
    }
    signedIn = null; userRpc.mockClear();
    res = await POST(pagePost("join"), params());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Sign in first");
    expect(userRpc).not.toHaveBeenCalled();
  });

  it("POST new: Supabase Auth e-mails the invite's OWN address a set-password link; an address with a login is told to sign in", async () => {
    const { POST } = await import("@/app/api/integrations/accountant-invite/[token]/route");
    const res = await POST(pagePost("new"), params());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your e-mail");
    expect(inviteUserByEmail).toHaveBeenCalledWith("acct@firm.example", { redirectTo: `${SITE}/auth/set-password` });
    inviteEmailError = { status: 422, code: "email_exists", message: "exists" };
    expect(await (await POST(pagePost("new"), params())).text()).toContain("You already have a Tolra login");
    peek = null; inviteUserByEmail.mockClear();
    expect((await POST(pagePost("new"), params())).status).toBe(404);
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("POST from another site, or an unknown action, does nothing", async () => {
    const { POST } = await import("@/app/api/integrations/accountant-invite/[token]/route");
    sameOriginOk = false;
    expect((await POST(pagePost("join"), params())).status).toBe(403);
    sameOriginOk = true;
    expect((await POST(pagePost("whatever"), params())).status).toBe(400);
    expect(userRpc).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });
});

describe("the list's states", () => {
  it("open until the expiry; accepted, cancelled and expired are not open", async () => {
    const { accountantInviteState } = await import("@/components/accountant-invite-card");
    const base = { id: "i", email: "a@b.example", created_at: "2026-11-01T10:00:00Z", expires_at: "2026-11-08T10:00:00Z", used_at: null, revoked_at: null };
    const now = Date.parse("2026-11-02T10:00:00Z");
    expect(accountantInviteState(base, now).open).toBe(true);
    expect(accountantInviteState({ ...base, used_at: "2026-11-02T09:00:00Z" }, now)).toMatchObject({ open: false, label: expect.stringContaining("Accepted") });
    expect(accountantInviteState({ ...base, revoked_at: "2026-11-02T09:00:00Z" }, now)).toMatchObject({ open: false, label: expect.stringContaining("Cancelled") });
    expect(accountantInviteState(base, Date.parse("2026-11-09T10:00:00Z"))).toMatchObject({ open: false, label: expect.stringContaining("Expired") });
  });
});
