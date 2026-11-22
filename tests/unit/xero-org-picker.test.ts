/**
 * The Xero organisation picker (several organisations ticked in one consent). The sealed offer, the server's side (finishConnect with the
 * picker on, finishPick), and the /api/integrations/xero/choose route with the callback's hand-off. Xero and the database are faked:
 * nothing reaches the network. Connecting leaves transfers off and releases nothing (no transfer or release call is ever made).
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const KEY = randomBytes(32);
const ORG = "22222222-2222-2222-2222-222222222222";
const OTHER_ORG = "33333333-3333-3333-3333-333333333333";
const USER = "user-1";
const NOW = Date.parse("2026-11-05T10:00:00Z");
const ready = { config: { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example.test/api/integrations/xero/callback" }, key: KEY };

const state = {
  profile: { organization_id: ORG } as { organization_id: string },
  userId: USER,
  support: false,
  mfaRefused: false,
  limiterAllows: true,
  limiterThrows: false,
  audit: vi.fn(async () => ({ error: null })),
};
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: (r: Request) => r.headers.get("sec-fetch-site") !== "cross-site",
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number, init?: { headers?: Record<string, string> }) => NextResponse.json({ error: m }, { status: s, headers: init?.headers }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: async () => ({ profile: state.profile, user: { id: state.userId }, session: state.support ? { support: true } : null, supabase: { rpc: state.audit } }),
}));
vi.mock("@/lib/server/admin-users", () => ({
  requireRecentAal2: async () => (state.mfaRefused ? NextResponse.json({ error: "mfa", code: "mfa_recent_required" }, { status: 403 }) : null),
}));
const svcHolder: { client: unknown } = { client: {} };
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => svcHolder.client }));
vi.mock("@/lib/server/login", () => ({
  LimiterUnavailableError: class extends Error {},
  withinLimit: vi.fn(async () => {
    if (state.limiterThrows) throw new (await import("@/lib/server/login")).LimiterUnavailableError("down");
    return state.limiterAllows;
  }),
}));
const pickSpy = vi.fn();
vi.mock("@/lib/integrations/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/server")>("@/lib/integrations/server");
  return { ...actual, xeroReady: async () => ready, finishPick: (...a: unknown[]) => { pickSpy(...a); return (actual.finishPick as (...b: unknown[]) => unknown)(...a); } };
});

import { encryptSecret } from "@/lib/integrations/crypto";
import { completeConnect, finishConnect, finishPick } from "@/lib/integrations/server";
import { PICKER_COOKIE, csrfMatches, openPicker, pickerCsrf, sealPicker } from "@/lib/integrations/xero/picker";
import { GET, POST } from "@/app/api/integrations/xero/choose/route";
import { GET as callbackGet } from "@/app/api/integrations/xero/callback/route";

const ago = (ms: number) => new Date(NOW - ms).toISOString();
const evt = (id: string) => `h.${Buffer.from(JSON.stringify({ authentication_event_id: id })).toString("base64url")}.s`;
const xc = (id: string, tenantId: string, created: number, over: Record<string, unknown> = {}) =>
  ({ id, tenantId, tenantName: `Org ${tenantId}`, tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: ago(created), ...over });

const offerOrgs = [
  { id: "conn-a", tenantId: "t-a", tenantName: "Alpha Ltd" },
  { id: "conn-b", tenantId: "t-b", tenantName: "Beta Ltd" },
];

/** Xero faked: token + refresh calls, the connections list, every DELETE; `refresh` can be made to fail. */
function fakeXero(connections: Array<Record<string, unknown>>, opts: { refreshFails?: boolean } = {}) {
  const deleted: string[] = [];
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/connect/token")) {
      calls.push(String(init?.body).includes("refresh_token") ? "refresh" : "exchange");
      if (opts.refreshFails && String(init?.body).includes("grant_type=refresh_token")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: evt("evt-1"), refresh_token: "r-new", expires_in: 1800 }), { status: 200 });
    }
    if (init?.method === "DELETE") { deleted.push(url.split("/").pop()!); return new Response(null, { status: 204 }); }
    calls.push("list");
    return new Response(JSON.stringify(connections), { status: 200 });
  });
  return { deleted, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function fakeService(storeError: { message: string; code: string; hint: string } | null = null, linked: string[] = []) {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    rpcs,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        if (fn === "integration_oauth_consume") return { data: { verifier_enc: encryptSecret("verifier", { organizationId: ORG, provider: "xero", purpose: "pkce" }, KEY) }, error: null };
        if (fn === "integration_store_connection") return { data: null, error: storeError };
        return { data: null, error: null };
      },
      from: () => ({ select: () => ({ eq: () => ({ neq: async () => ({ data: linked.map((tenant_id) => ({ tenant_id })), error: null }) }) }) }),
    } as never,
  };
}
const offer = { refreshToken: "r-old", eventId: "evt-1", orgs: offerOrgs };
const stored = (rpcs: Array<{ fn: string; args: Record<string, unknown> }>) => rpcs.filter((c) => c.fn === "integration_store_connection");
const noTransferCalls = (rpcs: Array<{ fn: string }>) => rpcs.every((c) => !/set_transfers|release|approve|xero_launch/.test(c.fn));

describe("the sealed offer", () => {
  it("round-trips, keeps no token in the clear, and is bound to the company", () => {
    const { cookie } = sealPicker(ORG, USER, offer, KEY, NOW);
    expect(cookie).not.toContain("r-old");
    expect(cookie).not.toContain("Alpha");
    const opened = openPicker(cookie, KEY, NOW);
    expect(opened.ok && opened.payload.t.map((x) => x.t)).toEqual(["t-a", "t-b"]);
    expect(opened.ok && opened.payload.e - Math.floor(NOW / 1000)).toBe(600);
  });

  it("refuses a tampered value, another key, a value moved to another company's prefix, and an expired one", () => {
    const { cookie } = sealPicker(ORG, USER, offer, KEY, NOW);
    const flipped = `${cookie.slice(0, -3)}${cookie.endsWith("AAA") ? "BBB" : "AAA"}`;
    expect(openPicker(flipped, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(openPicker(cookie, randomBytes(32), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(openPicker(`${OTHER_ORG}.${cookie.slice(ORG.length + 1)}`, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(openPicker(cookie, KEY, NOW + 10 * 60_000)).toEqual({ ok: false, reason: "expired" });
    expect(openPicker(cookie, KEY, NOW + 10 * 60_000 - 1000).ok).toBe(true);
    expect(openPicker("", KEY, NOW).ok).toBe(false);
    expect(openPicker("garbage", KEY, NOW).ok).toBe(false);
  });

  it("the anti-forgery value belongs to this offer only", () => {
    const a = sealPicker(ORG, USER, offer, KEY, NOW).payload;
    const b = sealPicker(ORG, USER, offer, KEY, NOW).payload;
    expect(csrfMatches(pickerCsrf(a, KEY), a, KEY)).toBe(true);
    expect(csrfMatches(pickerCsrf(a, KEY), b, KEY)).toBe(false);
    expect(csrfMatches(undefined, a, KEY)).toBe(false);
  });
});

describe("Connect with several organisations (the callback's side)", () => {
  const list = [xc("conn-a", "t-a", 30_000), xc("conn-b", "t-b", 30_000)];
  it("offers only this consent's organisations, removes nothing and stores nothing yet", async () => {
    const x = fakeXero([...list, xc("conn-old", "t-old", 5_000, { authEventId: "evt-0" }), xc("conn-practice", "t-p", 5_000, { tenantType: "PRACTICE" })]);
    const svc = fakeService();
    const out = await finishConnect(svc.client, ORG, USER, "state", "code", ready, { fetchImpl: x.fetchImpl, now: () => NOW, offerPicker: true });
    expect(out).toMatchObject({ ok: false, reason: "choose_organisation" });
    const made = out.ok ? undefined : out.offer;
    expect(made?.orgs.map((o) => o.tenantId)).toEqual(["t-a", "t-b"]);
    expect(made?.refreshToken).toBe("r-new");
    expect(x.deleted).toEqual([]);
    expect(stored(svc.rpcs)).toEqual([]);
  });
  it("keeps the old refusal when the picker is not offered (accountant link) or there are too many organisations", async () => {
    let x = fakeXero(list);
    let svc = fakeService();
    expect(await finishConnect(svc.client, ORG, USER, "state", "code", ready, { fetchImpl: x.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "choose_one" });
    expect(x.deleted.sort()).toEqual(["conn-a", "conn-b"]);
    const many = Array.from({ length: 9 }, (_, i) => xc(`c${i}`, `t${i}`, 30_000));
    x = fakeXero(many);
    svc = fakeService();
    expect(await finishConnect(svc.client, ORG, USER, "state", "code", ready, { fetchImpl: x.fetchImpl, now: () => NOW, offerPicker: true })).toEqual({ ok: false, reason: "choose_one" });
  });
  it("zero organisations behave as before, with the picker on; ONE organisation now asks (the same confirm step as several) and nothing is stored", async () => {
    let x = fakeXero([]);
    let svc = fakeService();
    expect(await completeConnect(svc.client, ORG, USER, "v", "code", ready, { fetchImpl: x.fetchImpl, now: () => NOW, offerPicker: true })).toEqual({ ok: false, reason: "no_organisation" });
    x = fakeXero([xc("conn-a", "t-a", 30_000)]);
    svc = fakeService();
    const out = await completeConnect(svc.client, ORG, USER, "v", "code", ready, { fetchImpl: x.fetchImpl, now: () => NOW, offerPicker: true });
    expect(out).toMatchObject({ ok: false, reason: "choose_organisation", offer: { orgs: [{ id: "conn-a", tenantId: "t-a", tenantName: "Org t-a" }] } });
    expect(stored(svc.rpcs)).toEqual([]);
    expect(x.deleted).toEqual([]);
  });
  it("one organisation WITHOUT the picker (the accountant link) is stored as before", async () => {
    const x = fakeXero([xc("conn-a", "t-a", 30_000)]);
    const svc = fakeService();
    expect(await completeConnect(svc.client, ORG, USER, "v", "code", ready, { fetchImpl: x.fetchImpl, now: () => NOW })).toEqual({ ok: true, tenantName: "Org t-a" });
    expect(stored(svc.rpcs)).toHaveLength(1);
  });
  it("a one-organisation offer goes through finishPick and stores that organisation", async () => {
    const x = fakeXero([xc("conn-a", "t-a", 30_000)]);
    const svc = fakeService();
    const one = { refreshToken: "r-old", eventId: "evt-1", orgs: [{ id: "conn-a", tenantId: "t-a", tenantName: "Org t-a" }] };
    expect(await finishPick(svc.client, ORG, USER, one, "t-a", ready, { fetchImpl: x.fetchImpl, now: () => NOW })).toEqual({ ok: true, tenantName: "Org t-a" });
    expect(stored(svc.rpcs)).toHaveLength(1);
    expect(stored(svc.rpcs)[0].args).toMatchObject({ p_tenant_id: "t-a", p_external_connection_id: "conn-a" });
  });
});

describe("finishPick", () => {
  it("stores the chosen organisation only, removes the other new one, never touches a linked or older one, and makes no transfer call", async () => {
    const x = fakeXero([xc("conn-a", "t-a", 30_000), xc("conn-b", "t-b", 30_000)]);
    const svc = fakeService(null, ["t-linked"]);
    const out = await finishPick(svc.client, ORG, USER, offer, "t-b", ready, { fetchImpl: x.fetchImpl, now: () => NOW });
    expect(out).toEqual({ ok: true, tenantName: "Org t-b" });
    expect(stored(svc.rpcs)).toHaveLength(1);
    expect(stored(svc.rpcs)[0].args).toMatchObject({ p_org: ORG, p_user: USER, p_tenant_id: "t-b", p_external_connection_id: "conn-b" });
    expect(x.deleted).toEqual(["conn-a"]);
    expect(noTransferCalls(svc.rpcs)).toBe(true);
  });
  it("keeps an unselected organisation that existed before this consent or that a company uses", async () => {
    const x = fakeXero([xc("conn-a", "t-a", 90 * 86_400_000), xc("conn-b", "t-b", 30_000)]);
    const svc = fakeService(null, []);
    await finishPick(svc.client, ORG, USER, offer, "t-b", ready, { fetchImpl: x.fetchImpl, now: () => NOW });
    expect(x.deleted).toEqual([]);
    const y = fakeXero([xc("conn-a", "t-a", 30_000), xc("conn-b", "t-b", 30_000)]);
    await finishPick(fakeService(null, ["t-a"]).client, ORG, USER, offer, "t-b", ready, { fetchImpl: y.fetchImpl, now: () => NOW });
    expect(y.deleted).toEqual([]);
  });
  it("a tenant that was not offered is refused before Xero is called at all", async () => {
    const x = fakeXero([xc("conn-a", "t-a", 30_000), xc("conn-b", "t-b", 30_000), xc("conn-x", "t-x", 30_000)]);
    const svc = fakeService();
    expect(await finishPick(svc.client, ORG, USER, offer, "t-x", ready, { fetchImpl: x.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "not_offered" });
    expect(x.calls).toEqual([]);
    expect(stored(svc.rpcs)).toEqual([]);
    expect(x.deleted).toEqual([]);
  });
  it("re-checks at Xero: an offered organisation no longer in Xero's list (or under another connection id) is refused and stored nowhere", async () => {
    let x = fakeXero([xc("conn-a", "t-a", 30_000)]);
    let svc = fakeService();
    expect(await finishPick(svc.client, ORG, USER, offer, "t-b", ready, { fetchImpl: x.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "not_offered" });
    expect(stored(svc.rpcs)).toEqual([]);
    x = fakeXero([xc("conn-zzz", "t-b", 30_000), xc("conn-a", "t-a", 30_000)]);
    svc = fakeService();
    expect(await finishPick(svc.client, ORG, USER, offer, "t-b", ready, { fetchImpl: x.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "not_offered" });
    expect(stored(svc.rpcs)).toEqual([]);
  });
  it("a refused refresh token is 'expired'; an organisation another company uses is tenant_in_use and its connection stays", async () => {
    const dead = fakeXero([], { refreshFails: true });
    expect(await finishPick(fakeService().client, ORG, USER, offer, "t-a", ready, { fetchImpl: dead.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "expired" });
    const x = fakeXero([xc("conn-a", "t-a", 30_000), xc("conn-b", "t-b", 90 * 86_400_000)]);
    const svc = fakeService({ message: "in use", code: "23505", hint: "tenant_in_use" }, ["t-b"]);
    expect(await finishPick(svc.client, ORG, USER, offer, "t-b", ready, { fetchImpl: x.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "tenant_in_use" });
    expect(x.deleted).toEqual(["conn-a"]);
  });
});

describe("POST/GET /api/integrations/xero/choose", () => {
  const cookieFor = (org = ORG, user = USER, at = Date.now()) => `${PICKER_COOKIE}=${sealPicker(org, user, offer, KEY, at).cookie}`;
  const post = (cookie: string | null, body: unknown, headers: Record<string, string> = {}) =>
    POST(new Request("https://app.example.test/api/integrations/xero/choose", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) }));
  const get = (cookie: string | null) => GET(new Request("https://app.example.test/api/integrations/xero/choose", { headers: cookie ? { cookie } : {} }));
  const csrfOf = (cookie: string) => { const o = openPicker(cookie.split("=").slice(1).join("="), KEY); return o.ok ? pickerCsrf(o.payload, KEY) : ""; };

  beforeEach(() => {
    state.profile = { organization_id: ORG }; state.userId = USER; state.support = false; state.mfaRefused = false; state.limiterAllows = true; state.limiterThrows = false;
    pickSpy.mockClear(); state.audit.mockClear();
  });

  it("GET lists the offered organisations by name with no token, id of the connection or state, and a csrf value", async () => {
    const c = cookieFor();
    const res = await get(c);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).organisations).toEqual([{ tenantId: "t-a", name: "Alpha Ltd" }, { tenantId: "t-b", name: "Beta Ltd" }]);
    expect(text).not.toContain("r-old");
    expect(text).not.toContain("conn-a");
  });
  it("GET refuses another company's cookie, another admin's cookie, a support session and a missing cookie", async () => {
    expect((await get(cookieFor(OTHER_ORG))).status).toBe(410);
    expect((await get(cookieFor(ORG, "someone-else"))).status).toBe(410);
    expect((await get(null)).status).toBe(410);
    state.support = true;
    expect((await get(cookieFor())).status).toBe(403);
  });
  it("POST: no selection, a tenant that was not offered, or a missing/forged csrf is refused and nothing is used up", async () => {
    const c = cookieFor();
    expect((await post(c, { csrf: csrfOf(c) })).status).toBe(400);
    expect((await post(c, { tenantId: "", csrf: csrfOf(c) })).status).toBe(400);
    expect((await post(c, { tenantId: "t-x", csrf: csrfOf(c) })).status).toBe(400);
    expect((await post(c, { tenantId: "t-a" })).status).toBe(403);
    expect((await post(c, { tenantId: "t-a", csrf: "forged" })).status).toBe(403);
    expect((await post(c, { tenantId: "t-a", csrf: csrfOf(cookieFor()) })).status).toBe(403);
    expect(pickSpy).not.toHaveBeenCalled();
  });
  it("POST: a cross-site request, a support session and a missing recent authenticator code are refused before anything is used", async () => {
    const c = cookieFor();
    expect((await post(c, { tenantId: "t-a", csrf: csrfOf(c) }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    state.support = true;
    expect((await post(c, { tenantId: "t-a", csrf: csrfOf(c) })).status).toBe(403);
    state.support = false; state.mfaRefused = true;
    const res = await post(c, { tenantId: "t-a", csrf: csrfOf(c) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_recent_required");
    expect(pickSpy).not.toHaveBeenCalled();
  });
  it("POST: a foreign company's cookie, another admin's cookie, a tampered cookie and an expired cookie are refused and cleared or ignored", async () => {
    for (const c of [cookieFor(OTHER_ORG), cookieFor(ORG, "someone-else"), `${cookieFor().slice(0, -4)}AAAA`, cookieFor(ORG, USER, Date.now() - 11 * 60_000)]) {
      const res = await post(c, { tenantId: "t-a", csrf: "x" });
      expect(res.status).toBe(410);
    }
    expect((await post(null, { tenantId: "t-a", csrf: "x" })).status).toBe(410);
    expect(pickSpy).not.toHaveBeenCalled();
  });
  it("POST: a replayed choice (the single use is spent) is refused, and an unavailable limiter fails closed", async () => {
    const c = cookieFor();
    state.limiterAllows = false;
    expect((await post(c, { tenantId: "t-a", csrf: csrfOf(c) })).status).toBe(410);
    state.limiterAllows = true; state.limiterThrows = true;
    expect((await post(c, { tenantId: "t-a", csrf: csrfOf(c) })).status).toBe(503);
    expect(pickSpy).not.toHaveBeenCalled();
  });
  it("POST: a valid choice stores that organisation for this company and admin, audits without secrets, clears the cookie, and never touches transfers", async () => {
    const c = cookieFor();
    const x = fakeXero([xc("conn-a", "t-a", 0, { createdDateUtc: new Date(Date.now() - 30_000).toISOString() }), xc("conn-b", "t-b", 0, { createdDateUtc: new Date(Date.now() - 30_000).toISOString() })]);
    const svc = fakeService();
    svcHolder.client = svc.client;
    vi.stubGlobal("fetch", x.fetchImpl);
    let res: Response;
    try { res = await post(c, { tenantId: "t-b", csrf: csrfOf(c) }); } finally { vi.unstubAllGlobals(); }
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "connected" });
    expect(res.headers.get("set-cookie") ?? "").toContain(`${PICKER_COOKIE}=;`);
    expect(pickSpy.mock.calls[0].slice(1, 3)).toEqual([ORG, USER]);
    expect(stored(svc.rpcs)).toHaveLength(1);
    expect(stored(svc.rpcs)[0].args).toMatchObject({ p_tenant_id: "t-b", p_user: USER, p_org: ORG });
    expect(x.deleted).toEqual(["conn-a"]);
    expect(noTransferCalls(svc.rpcs)).toBe(true);
    expect(state.audit).toHaveBeenCalledTimes(1);
    expect(state.audit.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringMatching(/write_audit/)]));
    expect(JSON.stringify(state.audit.mock.calls)).not.toMatch(/r-old|r-new|access/);
  });
  it("POST: a choice Xero refuses (the sign-in is dead) answers 409 with the plain message, stores nothing, and clears the cookie", async () => {
    const c = cookieFor();
    const x = fakeXero([], { refreshFails: true });
    const svc = fakeService();
    svcHolder.client = svc.client;
    vi.stubGlobal("fetch", x.fetchImpl);
    let res: Response;
    try { res = await post(c, { tenantId: "t-a", csrf: csrfOf(c) }); } finally { vi.unstubAllGlobals(); }
    expect(res.status).toBe(409);
    expect((await res.json()).outcome).toBe("expired");
    expect(res.headers.get("set-cookie") ?? "").toContain(`${PICKER_COOKIE}=;`);
    expect(stored(svc.rpcs)).toEqual([]);
  });
});

describe("the callback hands the admin to the picker", () => {
  it("several organisations: a 303 to the picker page (no organisation, token or state in the URL) with the sealed offer in an HttpOnly cookie, nothing stored", async () => {
    const created = new Date(Date.now() - 30_000).toISOString();
    const x = fakeXero([xc("conn-a", "t-a", 0, { createdDateUtc: created }), xc("conn-b", "t-b", 0, { createdDateUtc: created })]);
    const svc = fakeService();
    svcHolder.client = svc.client;
    vi.stubGlobal("fetch", x.fetchImpl);
    let res: Response;
    try { res = await callbackGet(new Request("https://app.example.test/api/integrations/xero/callback?code=thecode&state=thestate")); } finally { vi.unstubAllGlobals(); }
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.example.test/admin/integrations/xero-organisation");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${PICKER_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Max-Age=600/i);
    expect(setCookie).not.toMatch(/thecode|thestate|r-new/);
    expect(stored(svc.rpcs)).toEqual([]);
    expect(x.deleted).toEqual([]);
  });
});
