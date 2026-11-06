/**
 * R1: the Integrations action routes (Xero connect/disconnect/mappings save, Microsoft connect/disconnect/admin-consent) need an admin with a
 * RECENT authenticator code (requireRecentAal2, forceRecent), whatever REQUIRE_ADMIN_MFA says. The REAL routes and the REAL helper run; only the
 * session (requireProfile), the database/provider modules and the origin check are faked. Read-only routes (Xero test, mappings GET, Microsoft test) stay as they were.
 */
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireProfile: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
  calls: { beginConnect: 0, disconnect: 0, msConnect: 0, msDisconnect: 0, consent: 0, rpc: 0, xeroTest: 0, msTest: 0, xeroReady: 0, msReady: 0 },
}));
type Aal = { currentLevel: string; currentAuthenticationMethods: unknown[] };
let refuse: number | null = null;
let support = false;
let origin = true;
let aal: Aal = { currentLevel: "aal2", currentAuthenticationMethods: [] };
const rpc = vi.fn(async () => { h.calls.rpc++; return { data: null, error: null }; });
h.requireProfile = vi.fn(async () => refuse
  ? NextResponse.json({ error: "Forbidden" }, { status: refuse })
  : { supabase: { rpc, auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: aal, error: null }) } }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Acme" } }) }) }) }) }, user: { id: "u1", email: "a@a.test" }, profile: { organization_id: "org-1", role: "admin" }, session: support ? { support: true } : null });
vi.mock("@/lib/server/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/server/auth")>()), sameOrigin: () => origin, requireProfile: (...a: unknown[]) => h.requireProfile(...a) }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/integrations/server", () => ({
  DbError: class DbError extends Error { code?: string; hint?: string; },
  xeroReady: async () => { h.calls.xeroReady++; return { ok: true }; },
  beginConnect: async () => { h.calls.beginConnect++; return "https://login.xero.test/x"; },
  disconnectCompany: async () => { h.calls.disconnect++; return { removedAtXero: true }; },
  companyProvider: async () => ({ listAccounts: async () => [], listTaxRates: async () => [] }),
  companyXeroToken: async () => { h.calls.xeroTest++; return null; },
}));
vi.mock("@/lib/integrations/xero/client", () => ({ readOrganisationName: async () => "Org" }));
vi.mock("@/lib/integrations/app-credentials", () => ({ xeroEnvProblem: () => null }));
vi.mock("@/lib/integrations/microsoft/client", () => ({ microsoftReady: async () => { h.calls.msReady++; return { config: {}, key: "k" }; } }));
vi.mock("@/lib/integrations/microsoft/connect", () => ({
  beginMicrosoftConnect: async () => { h.calls.msConnect++; return "https://login.ms.test/x"; },
  disconnectMicrosoft: async () => { h.calls.msDisconnect++; },
  testMicrosoft: async () => { h.calls.msTest++; return null; },
}));
vi.mock("@/lib/integrations/microsoft/consent", () => ({ newConsentLink: () => { h.calls.consent++; return { url: "https://ms.test/consent", mailto: "mailto:x", permissions: [], expiresAt: "" }; } }));

import { POST as xeroConnect } from "@/app/api/integrations/xero/connect/route";
import { POST as xeroDisconnect } from "@/app/api/integrations/xero/disconnect/route";
import { GET as mapGet, POST as mapPost } from "@/app/api/integrations/xero/mappings/route";
import { POST as xeroTest } from "@/app/api/integrations/xero/test/route";
import { POST as msConnect } from "@/app/api/integrations/microsoft/connect/route";
import { POST as msDisconnect } from "@/app/api/integrations/microsoft/disconnect/route";
import { POST as msConsent } from "@/app/api/integrations/microsoft/admin-consent/route";
import { POST as msTest } from "@/app/api/integrations/microsoft/test/route";

const now = () => Math.floor(Date.now() / 1000);
const fresh = () => [{ method: "totp", timestamp: now() }];
const stale = () => [{ method: "totp", timestamp: now() - 16 * 60 }];
const post = (body?: unknown) => new Request("https://app.test/api/x", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
const mapBody = { kind: "sales_account", tolraKey: "", code: "" };

type Route = { name: string; call: () => Promise<Response>; reached: () => number };
const ROUTES: Route[] = [
  { name: "xero connect", call: () => xeroConnect(post()), reached: () => h.calls.beginConnect },
  { name: "xero disconnect", call: () => xeroDisconnect(post()), reached: () => h.calls.disconnect },
  { name: "xero mappings POST", call: () => mapPost(post(mapBody)), reached: () => h.calls.rpc },
  { name: "microsoft connect", call: () => msConnect(post()), reached: () => h.calls.msConnect },
  { name: "microsoft disconnect", call: () => msDisconnect(post()), reached: () => h.calls.msDisconnect },
  { name: "microsoft admin-consent", call: () => msConsent(post()), reached: () => h.calls.consent },
];

const saved = process.env.REQUIRE_ADMIN_MFA;
beforeEach(() => {
  delete process.env.REQUIRE_ADMIN_MFA;
  refuse = null; support = false; origin = true; aal = { currentLevel: "aal2", currentAuthenticationMethods: fresh() };
  for (const k of Object.keys(h.calls) as Array<keyof typeof h.calls>) h.calls[k] = 0;
  rpc.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); if (saved === undefined) delete process.env.REQUIRE_ADMIN_MFA; else process.env.REQUIRE_ADMIN_MFA = saved; });

describe.each(ROUTES)("$name", (route) => {
  it("accepts an admin whose authenticator code is fresh", async () => {
    const res = await route.call();
    expect(res.status).toBe(200);
    expect(route.reached()).toBe(1);
  });
  it("stale code: 403 mfa_recent_required, same answer as the helper, nothing done", async () => {
    aal = { currentLevel: "aal2", currentAuthenticationMethods: stale() };
    const res = await route.call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_recent_required");
    expect(route.reached()).toBe(0);
  });
  it("no code entry in the session at all (e.g. only a password): mfa_recent_required", async () => {
    aal = { currentLevel: "aal2", currentAuthenticationMethods: [{ method: "password", timestamp: now() }] };
    const res = await route.call();
    expect((await res.json()).code).toBe("mfa_recent_required");
    expect(route.reached()).toBe(0);
  });
  it("REQUIRE_ADMIN_MFA unset or off does not bypass recency", async () => {
    aal = { currentLevel: "aal2", currentAuthenticationMethods: stale() };
    for (const v of [undefined, "false", "off"]) {
      if (v === undefined) delete process.env.REQUIRE_ADMIN_MFA; else process.env.REQUIRE_ADMIN_MFA = v;
      const res = await route.call();
      expect((await res.json()).code).toBe("mfa_recent_required");
    }
    expect(route.reached()).toBe(0);
  });
  it("session never passed the second step: mfa_required", async () => {
    aal = { currentLevel: "aal1", currentAuthenticationMethods: [{ method: "password", timestamp: now() }] };
    const res = await route.call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_required");
    expect(route.reached()).toBe(0);
  });
  it("a non-admin is refused first (before the second-step check), whatever the code age", async () => {
    refuse = 403;
    aal = { currentLevel: "aal2", currentAuthenticationMethods: stale() };
    const res = await route.call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBeUndefined();
    expect(route.reached()).toBe(0);
  });
  it("a support session is refused, even with a fresh code", async () => {
    support = true;
    const res = await route.call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBeUndefined();
    expect(route.reached()).toBe(0);
  });
});

describe("read-only routes are unchanged (no recency asked)", () => {
  it("Xero test and Microsoft test and mappings GET answer with a stale code", async () => {
    aal = { currentLevel: "aal2", currentAuthenticationMethods: stale() };
    const x = await xeroTest(post());
    expect(x.status).not.toBe(403);
    const m = await msTest(post());
    expect(m.status).not.toBe(403);
    const g = await mapGet();
    expect(g.status).not.toBe(403);
  });
});
