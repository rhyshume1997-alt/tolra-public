/**
 * C2 + go-live switch + app test (Platform > App connections):
 *  - "Ask your Microsoft admin to approve": consent-blocked detection, the admin-consent URL with Graph's .default scope (v2), the plain-words
 *    permissions that can never drift from that constant, and the signed state (tamper, expiry, company, wrong kind, one use).
 *  - One redirect URI: the existing Microsoft/Xero callbacks pass signed states on; the returns do the work and are one-use.
 *  - "Not set up yet": every provider card and route in both states (a calm card, a clean 503 {code:"not_configured"}, never a 500).
 *  - Test connection: a real round trip's outcomes in plain words; nothing is stored.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const key = randomBytes(32);
let isAdmin = true;
let session: { support: boolean } | null = null;
let sameOriginOk = true;
let ownerOk = true;
let ownerId = "owner-1";
let msReady: unknown;
let xeroReadyValue: unknown;
const hits = new Map<string, number>();
const service = {
  rpc: vi.fn(async (fn: string, args: Record<string, string>) => {
    if (fn !== "auth_rate_hit") return { data: null, error: null };
    const n = (hits.get(args.p_key_hash) ?? 0) + 1;
    hits.set(args.p_key_hash, n);
    return { data: n <= Number(args.p_max), error: null };
  }),
};

const profileClient = () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Alpha Ltd" }, error: null }) }) }) }) });
const requireProfile = vi.fn(async () => (isAdmin
  ? { supabase: profileClient(), user: { id: "admin-1" }, profile: { organization_id: "org-1", role: "admin" }, session }
  : NextResponse.json({ error: "Forbidden" }, { status: 403 })));
const ownerClient = () => ({
  auth: { getUser: async () => ({ data: { user: { id: ownerId } } }), mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" }, error: null }) } },
  rpc: async () => ({ data: ownerOk, error: null }),
});
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => sameOriginOk,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  mfaRequired: () => NextResponse.json({ error: "Confirm your authenticator code first." }, { status: 403 }),
  createSupabaseServerClient: async () => ownerClient(),
  requireProfile,
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => service }));
vi.mock("@/lib/server/platform", () => ({
  requirePlatformOwner: async () => (ownerOk ? { supabase: ownerClient(), user: { id: ownerId }, companies: [], admin: service } : NextResponse.json({ error: "Forbidden" }, { status: 403 })),
}));
vi.mock("@/lib/integrations/microsoft/client", async (orig) => ({ ...(await orig<object>()), microsoftReady: vi.fn(async () => msReady) }));
vi.mock("@/lib/integrations/server", async (orig) => ({ ...(await orig<object>()), xeroReady: vi.fn(async () => xeroReadyValue), finishConnect: vi.fn(async () => ({ ok: true })) }));

const SITE = "https://app.example.test";
const msConfig = { clientId: "ms-client", clientSecret: "ms-secret", redirectUri: `${SITE}/api/integrations/microsoft/callback`, tenant: "organizations" };
const xeroConfig = { clientId: "xero-client", clientSecret: "xero-secret", redirectUri: `${SITE}/api/integrations/xero/callback` };

beforeEach(() => {
  isAdmin = true; session = null; sameOriginOk = true; ownerOk = true; ownerId = "owner-1";
  msReady = { config: msConfig, key };
  xeroReadyValue = { config: xeroConfig, key };
  hits.clear();
  service.rpc.mockClear();
  requireProfile.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const get = (path: string, search = "") => new Request(`${SITE}${path}${search}`, { headers: { host: "app.example.test" } });
const post = (path: string, body?: unknown) => new Request(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/json", host: "app.example.test" }, body: body === undefined ? undefined : JSON.stringify(body) });
const SHAPED = `${"A".repeat(10)}.${"B".repeat(43)}`;
const location = (res: Response) => res.headers.get("location") ?? "";

describe("consent-blocked detection", () => {
  it("catches AADSTS65001, AADSTS90094, admin_consent_required, consent_required and 'need admin approval' in any of the texts", async () => {
    const { isConsentBlocked } = await import("@/lib/integrations/microsoft/consent");
    for (const text of ["AADSTS65001: The user or administrator has not consented", "AADSTS90094: admin consent is required", "admin_consent_required",
      "consent_required", "interaction_required consent_required", "Need admin approval", "needs ... NEED ADMIN APPROVAL for this app"]) {
      expect(isConsentBlocked(text), text).toBe(true);
    }
    expect(isConsentBlocked("access_denied", "AADSTS65001: x")).toBe(true);
    expect(isConsentBlocked(null, undefined, "AADSTS90094")).toBe(true);
  });

  it("does not catch a cancel, a bad secret or nothing", async () => {
    const { isConsentBlocked } = await import("@/lib/integrations/microsoft/consent");
    for (const text of ["access_denied", "AADSTS7000215: invalid client secret", "invalid_grant", "", null, undefined]) expect(isConsentBlocked(text)).toBe(false);
    expect(isConsentBlocked()).toBe(false);
  });
});

describe("the admin-consent URL and the permissions", () => {
  it("is Microsoft's adminconsent page for the platform client id, Graph's .default scope (v2 endpoint), our one callback and the state", async () => {
    const { adminConsentUrl, ADMIN_CONSENT_SCOPE } = await import("@/lib/integrations/microsoft/consent");
    const url = new URL(adminConsentUrl({ clientId: "ms-client", redirectUri: msConfig.redirectUri }, "STATE.SIG"));
    expect(`${url.origin}${url.pathname}`).toBe("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
    expect(url.searchParams.get("client_id")).toBe("ms-client");
    // The v2 adminconsent endpoint accepts only `<resource>/.default`, never the individual scopes of the sign-in.
    expect(ADMIN_CONSENT_SCOPE).toBe("https://graph.microsoft.com/.default");
    expect(url.searchParams.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/api/integrations/microsoft/callback`);
    expect(url.searchParams.get("state")).toBe("STATE.SIG");
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "scope", "state"]);
  });

  it("the permission list is derived from the registration's scope constant, in order, in plain words; a new scope is shown, never hidden", async () => {
    const { permissionsFor, SCOPE_WORDS } = await import("@/lib/integrations/microsoft/consent");
    const { MICROSOFT_REGISTRATION_SCOPES, MICROSOFT_SCOPES } = await import("@/lib/integrations/microsoft/oauth");
    const list = permissionsFor();
    expect(list.map((p) => p.scope)).toEqual([...MICROSOFT_REGISTRATION_SCOPES]);
    // Every permission on the registration has plain words of its own (so the page can never fall back to a bare scope name unnoticed).
    for (const scope of MICROSOFT_REGISTRATION_SCOPES) expect(SCOPE_WORDS[scope], scope).toBeTruthy();
    expect(Object.fromEntries(list.map((p) => [p.scope, p.text]))).toEqual({ offline_access: "Stay signed in", "User.Read": "Read your profile", "Mail.Send": "Send mail as you", "Mail.Read": "Read your mail" });
    // The sign-in asks for a subset of the registration, never something the administrator was not shown.
    for (const scope of MICROSOFT_SCOPES) expect(MICROSOFT_REGISTRATION_SCOPES as readonly string[], scope).toContain(scope);
    // One list (C1 added Mail.Read to Connect): the registration is exactly what Connect asks for, so the two can never drift apart.
    expect([...MICROSOFT_REGISTRATION_SCOPES]).toEqual([...MICROSOFT_SCOPES]);
    // An unknown scope is shown by its own name.
    expect(permissionsFor([...MICROSOFT_REGISTRATION_SCOPES, "Calendars.Read"]).slice(-1)).toEqual([{ scope: "Calendars.Read", text: "Calendars.Read" }]);
  });

  it(".default approves EVERY permission on the registration: exactly offline_access, User.Read, Mail.Send and Mail.Read, nothing else", async () => {
    const { MICROSOFT_REGISTRATION_SCOPES } = await import("@/lib/integrations/microsoft/oauth");
    expect([...MICROSOFT_REGISTRATION_SCOPES].sort()).toEqual(["Mail.Read", "Mail.Send", "User.Read", "offline_access"]);
    expect(new Set(MICROSOFT_REGISTRATION_SCOPES).size).toBe(4);
    const { ADMIN_CONSENT_STATEMENT } = await import("@/lib/integrations/overview");
    expect(ADMIN_CONSENT_STATEMENT).toMatch(/\.default/);
    expect(ADMIN_CONSENT_STATEMENT).toMatch(/approves EVERY permission on Tolra's app registration/);
    expect(ADMIN_CONSENT_STATEMENT).toMatch(/exactly these, and nothing else/);
  });

  it("drift: the plain-words list on the consent page (route answer, card, e-mail) equals the scope constant, item for item", async () => {
    const { MICROSOFT_REGISTRATION_SCOPES } = await import("@/lib/integrations/microsoft/oauth");
    const { SCOPE_WORDS } = await import("@/lib/integrations/microsoft/consent");
    const { ADMIN_CONSENT_STATEMENT } = await import("@/lib/integrations/overview");
    const { POST } = await import("@/app/api/integrations/microsoft/admin-consent/route");
    const body = await (await POST(post("/api/integrations/microsoft/admin-consent"))).json() as { permissions: { scope: string; text: string }[]; mailto: string };
    // What the card lists (it renders body.permissions, one <li> per item, in order).
    expect(body.permissions).toEqual(MICROSOFT_REGISTRATION_SCOPES.map((scope) => ({ scope, text: SCOPE_WORDS[scope] })));
    expect(body.permissions.map((p) => p.text)).toEqual(["Stay signed in", "Read your profile", "Send mail as you", "Read your mail"]);
    // The e-mail to the administrator: the statement, then exactly those lines, nothing more.
    const mail = decodeURIComponent(body.mailto.split("&body=")[1]);
    const lines = mail.split("\n");
    const at = lines.indexOf(ADMIN_CONSENT_STATEMENT);
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 1 + body.permissions.length + 1)).toEqual([...body.permissions.map((p) => `- ${p.text}`), ""]);
    // The card shows the statement and maps the route's list (never a list of its own).
    const card = readFileSync(path.resolve(__dirname, "../../components/microsoft-connect-card.tsx"), "utf8");
    expect(card).toContain("{ADMIN_CONSENT_STATEMENT}");
    expect(card).toContain("approve.permissions.map((p) => <li key={p.scope}>{p.text}</li>)");
    expect(card).not.toContain("Tolra asks for these permissions only");
  });

  it("a new link: signed, bound to the company, 24 hours, with the plain-words permissions in the mailto", async () => {
    const { newConsentLink } = await import("@/lib/integrations/microsoft/consent");
    const { verifyState } = await import("@/lib/integrations/signed-state");
    const now = Date.UTC(2026, 10, 1, 12);
    const link = newConsentLink(msConfig, key, { org: "org-1", userId: "admin-1", company: "Alpha Ltd" }, now);
    const state = new URL(link.url).searchParams.get("state")!;
    const verified = verifyState(state, key, { kind: "admin_consent", org: "org-1" }, now);
    expect(verified).toMatchObject({ ok: true, payload: { k: "admin_consent", p: "microsoft", o: "org-1", u: "admin-1" } });
    expect(link.expiresAt).toBe(new Date(now + 24 * 3600_000).toISOString());
    const mailto = decodeURIComponent(link.mailto);
    expect(mailto.startsWith("mailto:?subject=")).toBe(true);
    for (const p of link.permissions) expect(mailto).toContain(`- ${p.text}`);
    expect(mailto).toContain(link.url);
    expect(mailto).toContain("Alpha Ltd");
  });
});

describe("the signed state", () => {
  const make = async (over: Partial<{ kind: "admin_consent" | "app_test"; org: string | null; ttl: number }> = {}, now = 1_000_000) => {
    const { signState } = await import("@/lib/integrations/signed-state");
    return signState({ k: over.kind ?? "admin_consent", p: "microsoft", o: over.org === undefined ? "org-1" : over.org, u: "u1", ttlSeconds: over.ttl ?? 3600 }, key, now);
  };

  it("verifies, and a tampered body, a tampered signature, another key, junk and an empty string are refused", async () => {
    const { verifyState } = await import("@/lib/integrations/signed-state");
    const { state } = await make();
    expect(verifyState(state, key, { kind: "admin_consent" }, 1_000_000)).toMatchObject({ ok: true });
    const [body, mac] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), o: "org-2" })).toString("base64url");
    expect(verifyState(`${forged}.${mac}`, key, { kind: "admin_consent" }, 1_000_000)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyState(`${body}.${mac.replace(/.$/, mac.endsWith("A") ? "B" : "A")}`, key, { kind: "admin_consent" }, 1_000_000)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyState(state, randomBytes(32), { kind: "admin_consent" }, 1_000_000)).toEqual({ ok: false, reason: "bad_signature" });
    for (const junk of ["", "abc", "a.b", `${body}.`, `.${mac}`]) expect(verifyState(junk, key, { kind: "admin_consent" })).toMatchObject({ ok: false });
  });

  it("expires at its time, is bound to its company and its kind", async () => {
    const { verifyState } = await import("@/lib/integrations/signed-state");
    const { state } = await make({ ttl: 60 });
    expect(verifyState(state, key, { kind: "admin_consent", org: "org-1" }, 1_000_000 + 59_000).ok).toBe(true);
    expect(verifyState(state, key, { kind: "admin_consent" }, 1_000_000 + 60_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyState(state, key, { kind: "admin_consent", org: "org-2" }, 1_000_000)).toEqual({ ok: false, reason: "wrong_company" });
    expect(verifyState(state, key, { kind: "app_test" }, 1_000_000)).toEqual({ ok: false, reason: "wrong_kind" });
  });

  it("works once: the first use is allowed, every later one refused, and a limiter that can't be used refuses", async () => {
    const { consumeStateOnce } = await import("@/lib/integrations/signed-state");
    const { payload } = await make();
    expect(await consumeStateOnce(service as never, payload)).toBe(true);
    expect(await consumeStateOnce(service as never, payload)).toBe(false);
    expect(await consumeStateOnce(service as never, (await make()).payload)).toBe(true);
    const down = { rpc: async () => ({ data: null, error: { code: "57014" } }) };
    expect(await consumeStateOnce(down as never, (await make()).payload)).toBe(false);
  });
});

describe("one redirect URI: the callbacks pass signed states on, unchanged", () => {
  it("Microsoft: a signed state goes to ./return with the same query; a plain state stays on the company's own path", async () => {
    const { GET } = await import("@/app/api/integrations/microsoft/callback/route");
    const res = await GET(get("/api/integrations/microsoft/callback", "?admin_consent=True&tenant=t&state=AAAAAAAA.BBBB"));
    expect(res.status).toBe(307);
    expect(location(res)).toBe(`${SITE}/api/integrations/microsoft/return?admin_consent=True&tenant=t&state=AAAAAAAA.BBBB`);
    expect(requireProfile).not.toHaveBeenCalled();
    // A plain 43-character state is a company's own Connect: it needs the admin (requireProfile).
    isAdmin = false;
    const refused = await GET(get("/api/integrations/microsoft/callback", `?code=c&state=${"a".repeat(43)}`));
    expect(location(refused)).toContain("/admin/integrations?microsoft=forbidden");
    expect(requireProfile).toHaveBeenCalledWith(["admin"]);
  });

  it("Microsoft: a consent-blocked return goes back to the card as consent_blocked (not 'cancelled')", async () => {
    const { GET } = await import("@/app/api/integrations/microsoft/callback/route");
    const res = await GET(get("/api/integrations/microsoft/callback", `?error=access_denied&error_description=${encodeURIComponent("AADSTS65001: needs consent")}&state=${"a".repeat(43)}`));
    expect(location(res)).toBe(`${SITE}/admin/integrations?microsoft=consent_blocked`);
    const cancelled = await GET(get("/api/integrations/microsoft/callback", `?error=access_denied&state=${"a".repeat(43)}`));
    expect(location(cancelled)).toBe(`${SITE}/admin/integrations?microsoft=cancelled`);
    const code = await GET(get("/api/integrations/microsoft/callback", `?error=consent_required&state=${"a".repeat(43)}`));
    expect(location(code)).toContain("microsoft=consent_blocked");
  });

  it("Xero: a signed state goes to ./return; a plain one needs the admin", async () => {
    const { GET } = await import("@/app/api/integrations/xero/callback/route");
    const res = await GET(get("/api/integrations/xero/callback", "?code=c&state=AAAAAAAA.BBBB"));
    expect(res.status).toBe(307);
    expect(location(res)).toBe(`${SITE}/api/integrations/xero/return?code=c&state=AAAAAAAA.BBBB`);
    expect(requireProfile).not.toHaveBeenCalled();
  });
});

describe("Microsoft return: the administrator's approval", () => {
  const link = async () => {
    const { newConsentLink } = await import("@/lib/integrations/microsoft/consent");
    return new URL(newConsentLink(msConfig, key, { org: "org-1", userId: "admin-1", company: "Alpha Ltd" }).url).searchParams.get("state")!;
  };
  const ret = async (search: string) => (await import("@/app/api/integrations/microsoft/return/route")).GET(get("/api/integrations/microsoft/return", search));

  it("verifies the state and sends the person back to the card with 'Approved'", async () => {
    const state = await link();
    isAdmin = false; // the Microsoft administrator is not a Tolra user: no session needed
    const res = await ret(`?admin_consent=True&tenant=t&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${SITE}/admin/integrations?microsoft=consent_approved`);
  });

  it("works once: the same link a second time is refused", async () => {
    const state = await link();
    expect(location(await ret(`?admin_consent=True&state=${encodeURIComponent(state)}`))).toContain("consent_approved");
    expect(location(await ret(`?admin_consent=True&state=${encodeURIComponent(state)}`))).toContain("microsoft=expired");
  });

  it("a tampered or foreign-key state is invalid and uses nothing up; a refusal is not 'approved'", async () => {
    const state = await link();
    const [body, mac] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), o: "org-2" })).toString("base64url");
    expect(location(await ret(`?admin_consent=True&state=${forged}.${mac}`))).toContain("microsoft=invalid");
    expect(location(await ret("?admin_consent=True"))).toContain("microsoft=invalid");
    expect(location(await ret(`?admin_consent=True&state=${"a".repeat(43)}`))).toContain("microsoft=invalid");
    expect(hits.size).toBe(0);
    expect(location(await ret(`?error=access_denied&error_description=denied&state=${encodeURIComponent(state)}`))).toContain("microsoft=cancelled");
  });

  it("a state past its expiry is refused", async () => {
    const { signState } = await import("@/lib/integrations/signed-state");
    const { state } = signState({ k: "admin_consent", p: "microsoft", o: "org-1", u: "a", ttlSeconds: 60 }, key, Date.now() - 120_000);
    expect(location(await ret(`?admin_consent=True&state=${encodeURIComponent(state)}`))).toContain("microsoft=expired");
  });

  it("a person signed in to a DIFFERENT company is not told 'Approved'", async () => {
    const state = await link();
    requireProfile.mockResolvedValueOnce({ supabase: profileClient(), user: { id: "x" }, profile: { organization_id: "org-2", role: "admin" }, session: null } as never);
    expect(location(await ret(`?admin_consent=True&state=${encodeURIComponent(state)}`))).toContain("microsoft=invalid");
  });

  it("not set up: a clean 503 not_configured, nothing used up", async () => {
    msReady = null;
    const res = await ret(`?state=${SHAPED}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "not_configured" });
  });
});

describe("the admin's 'approve' link route (admin only)", () => {
  it("an admin gets the link, the mailto and the permissions; nothing is stored", async () => {
    const { POST } = await import("@/app/api/integrations/microsoft/admin-consent/route");
    const res = await POST(post("/api/integrations/microsoft/admin-consent"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.url).toContain("https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=ms-client");
    expect(body.mailto).toMatch(/^mailto:\?subject=/);
    expect(body.permissions.map((p: { scope: string }) => p.scope)).toEqual(["offline_access", "User.Read", "Mail.Send", "Mail.Read"]);
    expect(requireProfile).toHaveBeenCalledWith(["admin"]);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it("a non-admin, a support session and a cross-site request are refused; not set up is a clean 503", async () => {
    const { POST } = await import("@/app/api/integrations/microsoft/admin-consent/route");
    isAdmin = false;
    expect((await POST(post("/api/integrations/microsoft/admin-consent"))).status).toBe(403);
    isAdmin = true; session = { support: true };
    expect((await POST(post("/api/integrations/microsoft/admin-consent"))).status).toBe(403);
    session = null; sameOriginOk = false;
    expect((await POST(post("/api/integrations/microsoft/admin-consent"))).status).toBe(403);
    sameOriginOk = true; msReady = null;
    const res = await POST(post("/api/integrations/microsoft/admin-consent"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Not set up yet: Tolra's Microsoft 365 connection is switched on at go-live. Nothing to do here.", code: "not_configured" });
  });
});

describe("Not set up yet: the cards", () => {
  it("not set up: the calm message, Connect disabled, no accountant link, no approve link (both providers)", async () => {
    const { connectCardView } = await import("@/lib/integrations/overview");
    expect(connectCardView("xero", false)).toEqual({
      notSetUp: true, message: "Not set up yet: Tolra's Xero connection is switched on at go-live. Nothing to do here.", connectDisabled: true, offerInvite: false, offerApproveLink: false,
    });
    expect(connectCardView("microsoft", false)).toEqual({
      notSetUp: true, message: "Not set up yet: Tolra's Microsoft 365 connection is switched on at go-live. Nothing to do here.", connectDisabled: true, offerInvite: false, offerApproveLink: false,
    });
  });

  it("set up: Connect enabled; the accountant link is Xero's and the approve link is Microsoft's", async () => {
    const { connectCardView } = await import("@/lib/integrations/overview");
    expect(connectCardView("xero", true)).toMatchObject({ notSetUp: false, message: null, connectDisabled: false, offerInvite: true, offerApproveLink: false });
    expect(connectCardView("microsoft", true)).toMatchObject({ notSetUp: false, message: null, connectDisabled: false, offerInvite: false, offerApproveLink: true });
  });

  it("while the status is loading nothing is offered and nothing is claimed", async () => {
    const { connectCardView } = await import("@/lib/integrations/overview");
    for (const loading of [null, undefined]) {
      expect(connectCardView("xero", loading)).toEqual({ notSetUp: false, message: null, connectDisabled: true, offerInvite: false, offerApproveLink: false });
    }
  });

  it("the cards show the view's message in grey (no red, no toast) and make no /connect call when it is not set up", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["components/microsoft-connect-card.tsx", "components/integrations-panel.tsx"]) {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("connectCardView(");
      expect(src).toMatch(/if \(\w*[vV]iew\.connectDisabled\) return;/);
    }
    const ms = readFileSync("components/microsoft-connect-card.tsx", "utf8");
    expect(ms).toContain('outcome === "not_configured"');
    expect(ms).toMatch(/data-testid="microsoft-not-set-up"/);
    expect(ms).not.toMatch(/microsoft-not-set-up[^\n]*(text-red|text-amber)/);
  });
});

describe("Not set up yet: the routes answer a clean 503 not_configured, never a 500", () => {
  const expected = (name: string) => ({ error: `Not set up yet: Tolra's ${name} connection is switched on at go-live. Nothing to do here.`, code: "not_configured" });

  it("Microsoft connect, test, admin-consent", async () => {
    msReady = null;
    const routes = {
      connect: await import("@/app/api/integrations/microsoft/connect/route"),
      test: await import("@/app/api/integrations/microsoft/test/route"),
      "admin-consent": await import("@/app/api/integrations/microsoft/admin-consent/route"),
    };
    for (const [path, route] of Object.entries(routes)) {
      const res = await route.POST(post(`/api/integrations/microsoft/${path}`));
      expect(res.status, path).toBe(503);
      expect(await res.json(), path).toEqual(expected("Microsoft 365"));
    }
  });

  it("Microsoft callback (company Connect) and return", async () => {
    msReady = null;
    const cb = await (await import("@/app/api/integrations/microsoft/callback/route")).GET(get("/api/integrations/microsoft/callback", `?code=c&state=${"a".repeat(43)}`));
    expect(cb.status).toBe(503);
    expect(await cb.json()).toEqual(expected("Microsoft 365"));
  });

  it("Xero connect, test, the accountant's link, callback and return", async () => {
    xeroReadyValue = null;
    const routes = { connect: await import("@/app/api/integrations/xero/connect/route"), test: await import("@/app/api/integrations/xero/test/route") };
    for (const [path, route] of Object.entries(routes)) {
      const res = await route.POST(post(`/api/integrations/xero/${path}`));
      expect(res.status, path).toBe(503);
      expect(await res.json(), path).toMatchObject({ ...expected("Xero") });
    }
    const invite = await (await import("@/app/api/integrations/invite/route")).POST(post("/api/integrations/invite"));
    expect(invite.status).toBe(503);
    expect(await invite.json()).toEqual(expected("Xero"));
    const cb = await (await import("@/app/api/integrations/xero/callback/route")).GET(get("/api/integrations/xero/callback", `?code=c&state=${"a".repeat(43)}`));
    expect(cb.status).toBe(503);
    expect(await cb.json()).toEqual(expected("Xero"));
    const ret = await (await import("@/app/api/integrations/xero/return/route")).GET(get("/api/integrations/xero/return", `?code=c&state=${SHAPED}`));
    expect(ret.status).toBe(503);
    expect(await ret.json()).toEqual(expected("Xero"));
  });

  it("the platform owner's test route too", async () => {
    msReady = null; xeroReadyValue = null;
    const { POST } = await import("@/app/api/integrations/app-credentials/test/route");
    for (const [provider, name] of [["xero", "Xero"], ["microsoft", "Microsoft 365"]] as const) {
      const res = await POST(post("/api/integrations/app-credentials/test", { provider }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(expected(name));
    }
  });

  it("set up: Microsoft and Xero connect still reach their providers' flow (the 503 is only for 'not set up')", async () => {
    const { POST } = await import("@/app/api/integrations/xero/connect/route");
    const res = await POST(post("/api/integrations/xero/connect"));
    expect(res.status).not.toBe(503);
  });
});

describe("Test connection (Platform > App connections)", () => {
  const begin = async (provider: "xero" | "microsoft") => {
    const { POST } = await import("@/app/api/integrations/app-credentials/test/route");
    const res = await POST(post("/api/integrations/app-credentials/test", { provider }));
    expect(res.status).toBe(200);
    return new URL((await res.json()).url);
  };

  it("platform owner only; a bad provider is refused", async () => {
    const { POST } = await import("@/app/api/integrations/app-credentials/test/route");
    ownerOk = false;
    expect((await POST(post("/api/integrations/app-credentials/test", { provider: "xero" }))).status).toBe(403);
    ownerOk = true;
    expect((await POST(post("/api/integrations/app-credentials/test", { provider: "other" }))).status).toBe(400);
  });

  it("starts a real sign-in with the app's own redirect URI and scopes and a signed app_test state bound to the owner (no company)", async () => {
    const { verifyState } = await import("@/lib/integrations/signed-state");
    const { MICROSOFT_SCOPES } = await import("@/lib/integrations/microsoft/oauth");
    const { XERO_SCOPES } = await import("@/lib/integrations/xero/oauth");
    const ms = await begin("microsoft");
    expect(ms.origin + ms.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    expect(ms.searchParams.get("redirect_uri")).toBe(msConfig.redirectUri);
    expect(ms.searchParams.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
    expect(verifyState(ms.searchParams.get("state")!, key, { kind: "app_test" })).toMatchObject({ ok: true, payload: { p: "microsoft", o: null, u: "owner-1" } });
    const xero = await begin("xero");
    expect(xero.origin + xero.pathname).toBe("https://login.xero.com/identity/connect/authorize");
    expect(xero.searchParams.get("redirect_uri")).toBe(xeroConfig.redirectUri);
    expect(xero.searchParams.get("scope")).toBe(XERO_SCOPES.join(" "));
    expect(verifyState(xero.searchParams.get("state")!, key, { kind: "app_test" })).toMatchObject({ ok: true, payload: { p: "xero", o: null } });
  });

  const fetchFor = (routes: Record<string, () => Response>) => vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.keys(routes).find((k) => url.startsWith(k));
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return routes[hit]();
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("Microsoft: authorize, callback, token, GET /me -> 'works'; nothing is stored anywhere", async () => {
    const state = (await begin("microsoft")).searchParams.get("state")!;
    const f = fetchFor({
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token": () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
      "https://graph.microsoft.com/v1.0/me": () => json({ id: "oid", mail: "owner@x.test" }),
    });
    vi.stubGlobal("fetch", f);
    const res = await (await import("@/app/api/integrations/microsoft/return/route")).GET(get("/api/integrations/microsoft/return", `?code=abc&state=${encodeURIComponent(state)}`));
    expect(location(res)).toBe(`${SITE}/platform?app_test=microsoft&result=ok`);
    expect(f).toHaveBeenCalledTimes(2);
    // Only the one-use record touched the database: no connection, no token, no state row.
    expect(service.rpc.mock.calls.map((c) => c[0])).toEqual(["auth_rate_hit"]);
    expect(location(res)).not.toContain("abc");
  });

  it("Xero: authorize, callback, token, read the connections list -> 'works'", async () => {
    const state = (await begin("xero")).searchParams.get("state")!;
    const f = fetchFor({
      "https://identity.xero.com/connect/token": () => json({ access_token: "AT", refresh_token: "RT", expires_in: 1800 }),
      "https://api.xero.com/connections": () => json([]),
    });
    vi.stubGlobal("fetch", f);
    const res = await (await import("@/app/api/integrations/xero/return/route")).GET(get("/api/integrations/xero/return", `?code=abc&state=${encodeURIComponent(state)}`));
    expect(location(res)).toBe(`${SITE}/platform?app_test=xero&result=ok`);
    expect(service.rpc.mock.calls.map((c) => c[0])).toEqual(["auth_rate_hit"]);
  });

  it("a bad secret, and Microsoft's redirect / consent / account errors, come back in plain words", async () => {
    const ret = (await import("@/app/api/integrations/microsoft/return/route")).GET;
    const outcome = async (search: (state: string) => string, tokenResponse?: Response) => {
      const state = (await begin("microsoft")).searchParams.get("state")!;
      if (tokenResponse) vi.stubGlobal("fetch", vi.fn(async () => tokenResponse));
      return new URL(location(await ret(get("/api/integrations/microsoft/return", search(encodeURIComponent(state)))))).searchParams.get("result");
    };
    expect(await outcome((s) => `?code=c&state=${s}`, json({ error: "invalid_client" }, 401))).toBe("bad_secret");
    expect(await outcome((s) => `?code=c&state=${s}`, json({ error: "unauthorized_client" }, 400))).toBe("bad_client_id");
    expect(await outcome((s) => `?error=invalid_request&error_description=${encodeURIComponent("AADSTS50011: The redirect URI does not match")}&state=${s}`)).toBe("redirect_mismatch");
    expect(await outcome((s) => `?error=access_denied&error_description=${encodeURIComponent("AADSTS65001: consent")}&state=${s}`)).toBe("consent_blocked");
    expect(await outcome((s) => `?error=invalid_request&error_description=${encodeURIComponent("AADSTS50020: user from another tenant")}&state=${s}`)).toBe("wrong_account");
    expect(await outcome((s) => `?error=invalid_client&error_description=${encodeURIComponent("AADSTS7000215: Invalid client secret")}&state=${s}`)).toBe("bad_secret");
    expect(await outcome((s) => `?error=access_denied&state=${s}`)).toBe("denied");
  });

  it("works once, only for the owner who started it, and not after it expired", async () => {
    const ret = (await import("@/app/api/integrations/microsoft/return/route")).GET;
    const state = encodeURIComponent((await begin("microsoft")).searchParams.get("state")!);
    expect(new URL(location(await ret(get("/api/integrations/microsoft/return", `?error=access_denied&state=${state}`)))).searchParams.get("result")).toBe("denied");
    expect(new URL(location(await ret(get("/api/integrations/microsoft/return", `?error=access_denied&state=${state}`)))).searchParams.get("result")).toBe("expired");
    const other = encodeURIComponent((await begin("microsoft")).searchParams.get("state")!);
    ownerId = "someone-else";
    expect(new URL(location(await ret(get("/api/integrations/microsoft/return", `?code=c&state=${other}`)))).searchParams.get("result")).toBe("failed");
    ownerId = "owner-1";
    const { signState } = await import("@/lib/integrations/signed-state");
    const old = signState({ k: "app_test", p: "microsoft", o: null, u: "owner-1", ttlSeconds: 60 }, key, Date.now() - 120_000).state;
    expect(new URL(location(await ret(get("/api/integrations/microsoft/return", `?code=c&state=${encodeURIComponent(old)}`)))).searchParams.get("result")).toBe("expired");
  });

  it("the words: success says what was accepted; every outcome has its own plain sentence", async () => {
    const { appTestMessage, APP_TEST_OUTCOMES } = await import("@/lib/integrations/app-test-messages");
    expect(appTestMessage("xero", "ok")).toBe("Xero app works ✓ (redirect, id and secret all accepted)");
    expect(appTestMessage("microsoft", "ok")).toBe("Microsoft 365 app works ✓ (redirect, id and secret all accepted)");
    const sentences = APP_TEST_OUTCOMES.map((o) => appTestMessage("microsoft", o));
    expect(new Set(sentences).size).toBe(APP_TEST_OUTCOMES.length);
    expect(appTestMessage("xero", "redirect_mismatch")).toContain("redirect");
    expect(appTestMessage("xero", "bad_secret")).toContain("secret");
    expect(appTestMessage("microsoft", "consent_blocked")).toContain("administrator");
    expect(appTestMessage("microsoft", "wrong_account")).toContain("work or school");
  });
});

describe("Platform > App connections shows what to register", () => {
  it("Xero's Test connection: the card says it leaves a connection on the owner's own Xero side, removable in Xero > Settings > Connected apps", async () => {
    const { XERO_TEST_CONNECTION_NOTE } = await import("@/lib/integrations/app-test-messages");
    expect(XERO_TEST_CONNECTION_NOTE).toBe("Xero's Test connection leaves a connection on your own Xero side (Tolra keeps nothing). You can remove it in Xero > Settings > Connected apps.");
    const card = readFileSync(path.resolve(__dirname, "../../components/platform/app-credentials-card.tsx"), "utf8");
    expect(card).toContain('{p.provider === "xero" ? <p className="text-xs text-slate-500" data-testid="app-credentials-xero-test-note">{XERO_TEST_CONNECTION_NOTE}</p> : null}');
  });
  it("the redirect URIs and scopes come from the code's own constants", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
    vi.doMock("@/lib/server/platform", () => ({ requirePlatformOwner: async () => ({ supabase: { rpc: async () => ({ data: [], error: null }) }, user: { id: "o" }, companies: [], admin: service }) }));
    const { GET } = await import("@/app/api/integrations/app-credentials/route");
    const body = await (await GET(get("/api/integrations/app-credentials"))).json();
    const by = Object.fromEntries(body.providers.map((p: { provider: string }) => [p.provider, p]));
    expect(by.xero.redirectUris).toEqual([`${SITE}/api/integrations/xero/callback`, `${SITE}/api/integrations/invite/callback`]);
    expect(by.microsoft.redirectUris).toEqual([`${SITE}/api/integrations/microsoft/callback`]);
    const { XERO_SCOPES } = await import("@/lib/integrations/xero/oauth");
    const { MICROSOFT_REGISTRATION_SCOPES } = await import("@/lib/integrations/microsoft/oauth");
    expect(by.xero.scopes.map((s: { scope: string }) => s.scope)).toEqual([...XERO_SCOPES]);
    // The registration's exact list (the admin approval's .default approves all of it), not only the sign-in's.
    expect(by.microsoft.scopes.map((s: { scope: string }) => s.scope)).toEqual([...MICROSOFT_REGISTRATION_SCOPES]);
    expect(by.microsoft.scopes.map((s: { text: string }) => s.text)).toEqual(["Stay signed in", "Read your profile", "Send mail as you", "Read your mail"]);
    vi.unstubAllEnvs();
  });
});

describe("the 503 not_configured answers expose no configuration: the exact JSON body of every route", () => {
  // Every setting these routes read, set to values that would be recognisable anywhere in a body. The readiness checks are mocked "not
  // set up", so each route answers its 503; a set-but-unusable Xero redirect URI is the one setting a route used to put in the body.
  const SETTINGS: Record<string, string> = {
    XERO_CLIENT_ID: "XEROID-sentinel-1", XERO_CLIENT_SECRET: "XEROSECRET-sentinel-2", XERO_REDIRECT_URI: "http://wrong.sentinel.example.test/cb?x=1",
    MS_CLIENT_ID: "MSID-sentinel-3", MS_CLIENT_SECRET: "MSSECRET-sentinel-4", MS_TENANT_ID: "TENANT-sentinel-5", MS_MAILBOX: "mailbox@sentinel.example.test",
    MS_ORGANIZATION_ID: "ORG-sentinel-6", NEXT_PUBLIC_SITE_URL: "https://site.sentinel.example.test", INTEGRATIONS_ENCRYPTION_KEY: "KEY-sentinel-7",
  };
  const expected = (name: string) => ({ error: `Not set up yet: Tolra's ${name} connection is switched on at go-live. Nothing to do here.`, code: "not_configured" });
  /** Nothing of a setting: no setting's name, no value, no URL, no client id, secret, tenant or redirect wording. */
  const leaks = (text: string) => [
    ...Object.keys(SETTINGS).filter((name) => text.includes(name)),
    ...Object.values(SETTINGS).filter((value) => text.includes(value)),
    ...[/sentinel/i, /https?:\/\//i, /\b(XERO|MS|MICROSOFT|SUPABASE|NEXT_PUBLIC)_[A-Z_]+/, /client.?id/i, /secret/i, /tenant/i, /redirect/i, /\.env\b/i, /problem/i]
      .filter((pattern) => pattern.test(text)).map(String),
  ];

  beforeEach(() => {
    for (const [name, value] of Object.entries(SETTINGS)) vi.stubEnv(name, value);
    msReady = null;
    xeroReadyValue = null;
  });
  afterEach(() => vi.unstubAllEnvs());

  const cases: [string, "Xero" | "Microsoft 365", () => Promise<Response>][] = [
    ["POST /api/integrations/microsoft/connect", "Microsoft 365", async () => (await import("@/app/api/integrations/microsoft/connect/route")).POST(post("/api/integrations/microsoft/connect"))],
    ["POST /api/integrations/microsoft/test", "Microsoft 365", async () => (await import("@/app/api/integrations/microsoft/test/route")).POST(post("/api/integrations/microsoft/test"))],
    ["POST /api/integrations/microsoft/admin-consent", "Microsoft 365", async () => (await import("@/app/api/integrations/microsoft/admin-consent/route")).POST(post("/api/integrations/microsoft/admin-consent"))],
    ["GET /api/integrations/microsoft/callback", "Microsoft 365", async () => (await import("@/app/api/integrations/microsoft/callback/route")).GET(get("/api/integrations/microsoft/callback", `?code=c&state=${"a".repeat(43)}`))],
    ["GET /api/integrations/microsoft/return", "Microsoft 365", async () => (await import("@/app/api/integrations/microsoft/return/route")).GET(get("/api/integrations/microsoft/return", `?state=${SHAPED}`))],
    ["POST /api/integrations/xero/connect", "Xero", async () => (await import("@/app/api/integrations/xero/connect/route")).POST(post("/api/integrations/xero/connect"))],
    ["POST /api/integrations/xero/test", "Xero", async () => (await import("@/app/api/integrations/xero/test/route")).POST(post("/api/integrations/xero/test"))],
    ["GET /api/integrations/xero/callback", "Xero", async () => (await import("@/app/api/integrations/xero/callback/route")).GET(get("/api/integrations/xero/callback", `?code=c&state=${"a".repeat(43)}`))],
    ["GET /api/integrations/xero/return", "Xero", async () => (await import("@/app/api/integrations/xero/return/route")).GET(get("/api/integrations/xero/return", `?code=c&state=${SHAPED}`))],
    ["POST /api/integrations/invite", "Xero", async () => (await import("@/app/api/integrations/invite/route")).POST(post("/api/integrations/invite"))],
    ["POST /api/integrations/app-credentials/test (xero)", "Xero", async () => (await import("@/app/api/integrations/app-credentials/test/route")).POST(post("/api/integrations/app-credentials/test", { provider: "xero" }))],
    ["POST /api/integrations/app-credentials/test (microsoft)", "Microsoft 365", async () => (await import("@/app/api/integrations/app-credentials/test/route")).POST(post("/api/integrations/app-credentials/test", { provider: "microsoft" }))],
  ];
  for (const [label, name, call] of cases) {
    it(`${label}: 503, exactly { error, code }, nothing of the configuration`, async () => {
      const res = await call();
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(JSON.parse(text)).toStrictEqual(expected(name));
      expect(Object.keys(JSON.parse(text))).toEqual(["error", "code"]);
      expect(leaks(text)).toEqual([]);
    });
  }

  it("Xero connect with a set-but-unusable redirect URI logs that on the server (no value) and answers the same body", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await (await import("@/app/api/integrations/xero/connect/route")).POST(post("/api/integrations/xero/connect"));
      expect(await res.json()).toStrictEqual(expected("Xero"));
      const logged = errors.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("redirect URI setting is unusable");
      expect(logged).not.toContain(SETTINGS.XERO_REDIRECT_URI);
    } finally {
      errors.mockRestore();
    }
  });
});
