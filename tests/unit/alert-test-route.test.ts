/**
 * Admin > Send test alert (/api/admin/alert-test) sends an e-mail, so only an ACTIVE admin of the company may run it: never office, never
 * support access (read-only or elevated), and an admin needs the second step (aal2) when REQUIRE_ADMIN_MFA is on or the company's own
 * rule (organizations.require_admin_mfa, via admin_mfa_overview) is on. The real
 * requireProfile runs against a stand-in Supabase client; the alert itself is a spy, so nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

let who: { role: string; active: boolean };
let level: "aal1" | "aal2";
let support: null | { read_only: boolean };
let signedIn: boolean;
let sessionOrg: string;
let companyRule: boolean;

const chain = (result: unknown) => {
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" || prop === "single" ? () => Promise.resolve({ data: result, error: null }) : () => c) });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => (signedIn ? { data: { user: { id: "user-1", email: "a@example.test" } }, error: null } : { data: { user: null }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: level, nextLevel: "aal2" }, error: null }) },
    },
    from: () => chain({ id: "user-1", email: "a@example.test", full_name: "A", role: who.role, secondary_role: null, organization_id: "org-1", active: true, must_change_password: false }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "current_user_organization_id") return { data: "org-1", error: null };
      if (name === "my_session") {
        return { data: { user_id: "user-1", organization_id: sessionOrg, role: who.role, support: support !== null, read_only: support?.read_only === true, platform_admin: support !== null }, error: null };
      }
      // The database's own check: an ACTIVE membership with one of the roles.
      if (name === "has_org_role") return { data: who.active && ((args.allowed_roles as string[]) ?? []).includes(who.role), error: null };
      if (name === "admin_mfa_overview") return { data: { require_admin_mfa: companyRule, can_require: true, admins: [] }, error: null };
      return { data: null, error: null };
    },
  }),
}));
const { reportServerError } = vi.hoisted(() => ({ reportServerError: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/server/error-alert", () => ({ alertsEnabled: () => true, reportServerError }));

import { POST } from "@/app/api/admin/alert-test/route";

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
const call = () => POST(new Request("https://app.test/api/admin/alert-test", { method: "POST" }));

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  who = { role: "admin", active: true };
  level = "aal1";
  support = null;
  signedIn = true;
  sessionOrg = "org-1";
  companyRule = false;
  reportServerError.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

describe("who may send the test alert", () => {
  it("an active company admin: sent (aal1 is enough while the company does not require admin MFA)", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(reportServerError).toHaveBeenCalledTimes(1);
  });

  it("an admin at aal2 when admin MFA is required: sent", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    level = "aal2";
    expect((await call()).status).toBe(200);
    expect(reportServerError).toHaveBeenCalledTimes(1);
  });

  it("an admin without aal2 when admin MFA is required: 403 mfa_required, nothing sent", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_required" });
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("office: 403, nothing sent", async () => {
    who = { role: "office", active: true };
    expect((await call()).status).toBe(403);
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("a deactivated admin membership (the database's has_org_role says no): 403, nothing sent", async () => {
    who = { role: "admin", active: false };
    expect((await call()).status).toBe(403);
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it.each([["read-only", true], ["elevated", false]])("%s support access, even at aal2: 403 with a clear message, nothing sent", async (_label, readOnly) => {
    support = { read_only: readOnly };
    level = "aal2";
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Support access can't send a test alert. Ask an admin of this company." });
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("the company's own rule on (REQUIRE_ADMIN_MFA off), admin at aal1: 403 mfa_required, nothing sent", async () => {
    companyRule = true;
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_required" });
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("the company's own rule on, admin at aal2: sent", async () => {
    companyRule = true;
    level = "aal2";
    expect((await call()).status).toBe(200);
    expect(reportServerError).toHaveBeenCalledTimes(1);
  });

  it("the company's own rule off, REQUIRE_ADMIN_MFA off, aal1: sent (unchanged)", async () => {
    expect((await call()).status).toBe(200);
    expect(reportServerError).toHaveBeenCalledTimes(1);
  });

  it("not signed in: 401, nothing sent", async () => {
    signedIn = false;
    expect((await call()).status).toBe(401);
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("an admin whose session company is not the active company (organisation mismatch): 403, nothing sent", async () => {
    sessionOrg = "org-2";
    expect((await call()).status).toBe(403);
    expect(reportServerError).not.toHaveBeenCalled();
  });
});
