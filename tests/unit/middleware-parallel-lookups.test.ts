/**
 * Lag fix 1: the profile read and my_session are independent, so the middleware sends them together instead of one after the other.
 * Every call here takes a modelled 50 ms (a MODEL, not a live timing: no hosted Supabase here). The gates are unchanged: signed
 * out, deactivated, admin second step and enrolment, and the support session's routing still behave as before.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  user: null as { id: string } | null,
  profile: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  aal: { currentLevel: "aal1", nextLevel: "aal1" },
  enrolmentRequired: false,
  inflight: 0,
  maxInflight: 0,
  calls: [] as string[],
  signOuts: 0,
}));
const slow = async <T,>(name: string, value: T): Promise<T> => {
  server.calls.push(name);
  server.inflight += 1;
  server.maxInflight = Math.max(server.maxInflight, server.inflight);
  await new Promise((resolve) => setTimeout(resolve, 50));
  server.inflight -= 1;
  return value;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = () => slow("user_profiles", { data: server.profile, error: null });
    return {
      auth: {
        getUser: () => slow("getUser", server.user ? { data: { user: server.user }, error: null } : { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } }),
        signOut: async () => { server.signOuts += 1; return { error: null }; },
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: server.aal, error: null }) },
      },
      from: () => chain,
      rpc: (name: string) => {
        if (name === "my_session") return slow(name, { data: server.session, error: null });
        if (name === "my_mfa_enrolment_required") return slow(name, { data: server.enrolmentRequired, error: null });
        return slow(name, { data: null, error: null });
      },
    };
  },
}));

import { middleware } from "@/middleware";

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
const mk = (role: string, extra: Record<string, unknown> = {}) => ({ user_id: "u-1", organization_id: "org-1", role, secondary_role: null, hidden_sections: [], organization_count: 1, ...extra });
beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  server.user = { id: "u-1" };
  server.profile = { role: "office", secondary_role: null, active: true, organization_id: "org-1", must_change_password: false };
  server.session = mk("office");
  server.aal = { currentLevel: "aal1", nextLevel: "aal1" };
  server.enrolmentRequired = false;
  server.inflight = 0; server.maxInflight = 0; server.calls.length = 0; server.signOuts = 0;
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

const visit = async (path: string) => {
  const started = Date.now();
  const response = await middleware(new NextRequest(`https://app.test${path}`, { headers: { cookie: "sb-abc-auth-token=session" } }));
  const location = response.headers.get("location");
  return { elapsed: Date.now() - started, response, location: location ? new URL(location).pathname + new URL(location).search : null };
};

describe("sequential steps for a signed-in page request", () => {
  it("profile and my_session are in flight together: 2 awaited steps (getUser, then both), not 3", async () => {
    const { elapsed, location } = await visit("/jobs");
    expect(location).toBeNull();
    expect(server.calls).toEqual(["getUser", "user_profiles", "my_session"]);
    expect(server.maxInflight).toBe(2);
    // Model: 50 ms per call. Before: 3 x 50 = 150 ms. After: 2 x 50 = 100 ms (allowing timer slack, but clearly under the old 150).
    expect(elapsed).toBeLessThan(140);
  });
});

describe("the gates are unchanged", () => {
  it("signed out: redirect to /login after getUser alone", async () => {
    server.user = null;
    const { location } = await visit("/jobs");
    expect(location).toBe("/login");
    expect(server.calls).toEqual(["getUser"]);
  });

  it("deactivated or ended account: signed out and sent to /login?disabled=1", async () => {
    server.profile = { ...server.profile, active: false };
    const { location } = await visit("/jobs");
    expect(location).toBe("/login?disabled=1");
    expect(server.signOuts).toBe(1);
  });

  it("an admin without the second step (REQUIRE_ADMIN_MFA on) is sent to /mfa", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    server.profile = { ...server.profile, role: "admin" };
    server.session = mk("admin");
    expect((await visit("/jobs")).location).toBe("/mfa");
  });

  it("a newly made admin who must enrol is sent to /mfa?enrol=1", async () => {
    server.profile = { ...server.profile, role: "admin" };
    server.session = mk("admin");
    server.aal = { currentLevel: "aal1", nextLevel: "aal1" };
    server.enrolmentRequired = true;
    process.env.REQUIRE_ADMIN_MFA = "false";
    const { location } = await visit("/jobs");
    expect(location).toBe("/mfa?enrol=1");
    expect(server.calls).toContain("my_mfa_enrolment_required");
  });

  it("a support session routes by the session's role, as before (viewer cannot open /admin)", async () => {
    server.session = mk("viewer", { support: true, support_expires_at: "2099-01-01T00:00:00Z" });
    server.profile = { ...server.profile, role: "admin" };
    expect((await visit("/admin")).location).toBe("/dashboard");
  });

  it("a page hidden for this person is still refused", async () => {
    server.session = mk("office", { hidden_sections: ["invoices"] });
    const { location } = await visit("/invoices");
    expect(location).toBe("/dashboard?blocked=1");
  });
});
