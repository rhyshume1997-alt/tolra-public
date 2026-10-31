/**
 * Admin two-step sign-in onboarding (migration 065): the notices and status shown in Admin > Users, and the middleware sending a
 * newly made admin to /mfa to set up an authenticator app while REQUIRE_ADMIN_MFA is off, without changing the global switch.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_MFA_ONBOARDING_NOTICE, adminMfaRuleMessage, adminMfaStatusLabel, becomesAdmin, changesAdmin, parseAdminMfaOverview, shouldCheckEnrolment,
} from "@/lib/mfa-policy";

// ---- middleware harness -----------------------------------------------------------------------------------------------------
let who: { role: string; secondary?: string | null; platform?: boolean };
let level: { currentLevel: string; nextLevel: string } | null;
let enrolment: { data: unknown; error: unknown };
const rpcCalls: string[] = [];

const profileChain = () => {
  const row = { role: who.role, secondary_role: who.secondary ?? null, active: true, organization_id: "org-1", must_change_password: false };
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" ? () => Promise.resolve({ data: row, error: null }) : () => c) });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
      signOut: async () => ({ error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: level, error: level ? null : { message: "boom" } }) },
    },
    from: () => profileChain(),
    rpc: async (name: string) => {
      rpcCalls.push(name);
      if (name === "my_session") {
        return { data: { user_id: "user-1", organization_id: "org-1", role: who.role, secondary_role: who.secondary ?? null, platform_admin: who.platform === true, organization_count: 1 }, error: null };
      }
      if (name === "my_mfa_enrolment_required") return enrolment;
      return { data: null, error: null };
    },
  }),
}));

import { middleware } from "@/middleware";

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
const visit = async (path: string) => {
  const response = await middleware(new NextRequest(`https://app.test${path}`));
  const location = response.headers.get("location");
  return location ? new URL(location).pathname + new URL(location).search : null;
};

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  who = { role: "admin" };
  level = { currentLevel: "aal1", nextLevel: "aal1" };
  enrolment = { data: true, error: null };
  rpcCalls.length = 0;
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

describe("middleware: a newly made admin sets up an authenticator app first (REQUIRE_ADMIN_MFA off)", () => {
  it("sends a flagged admin with no factor to /mfa?enrol=1 from any page, and lets /mfa itself open", async () => {
    expect(await visit("/dashboard")).toBe("/mfa?enrol=1");
    expect(await visit("/admin/users")).toBe("/mfa?enrol=1");
    expect(await visit("/jobs")).toBe("/mfa?enrol=1");
    rpcCalls.length = 0;
    expect(await visit("/mfa?enrol=1")).toBeNull();
    expect(rpcCalls).not.toContain("my_mfa_enrolment_required");
  });

  it("an admin who is not flagged (or the last usable admin: the database answers false) is let through", async () => {
    enrolment = { data: false, error: null };
    expect(await visit("/dashboard")).toBeNull();
  });

  it("the last admin who can sign in normally (flagged, no factor, but the database answers false) reaches every page", async () => {
    level = { currentLevel: "aal1", nextLevel: "aal1" };
    enrolment = { data: false, error: null };
    for (const path of ["/dashboard", "/admin/users", "/settings", "/jobs"]) expect(await visit(path)).toBeNull();
    expect(rpcCalls).toContain("my_mfa_enrolment_required");
  });

  it("any error reading the flag counts as not required (no lockout before 065 is applied)", async () => {
    enrolment = { data: null, error: { code: "42883", message: "function does not exist" } };
    expect(await visit("/dashboard")).toBeNull();
  });

  it("an admin with a verified factor (or already at aal2) is never asked again, and the database isn't asked", async () => {
    level = { currentLevel: "aal1", nextLevel: "aal2" };
    expect(await visit("/dashboard")).toBeNull();
    level = { currentLevel: "aal2", nextLevel: "aal2" };
    expect(await visit("/dashboard")).toBeNull();
    expect(rpcCalls).not.toContain("my_mfa_enrolment_required");
  });

  it("office staff are never sent, and the database isn't asked", async () => {
    who = { role: "office" };
    expect(await visit("/dashboard")).toBeNull();
    expect(rpcCalls).not.toContain("my_mfa_enrolment_required");
  });

  it("a second role of admin counts", async () => {
    who = { role: "office", secondary: "admin" };
    expect(await visit("/dashboard")).toBe("/mfa?enrol=1");
  });

  it("REQUIRE_ADMIN_MFA on: the existing aal2 gate decides (plain /mfa), unchanged", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    level = { currentLevel: "aal1", nextLevel: "aal2" };
    expect(await visit("/dashboard")).toBe("/mfa");
    expect(rpcCalls).not.toContain("my_mfa_enrolment_required");
    level = { currentLevel: "aal2", nextLevel: "aal2" };
    expect(await visit("/dashboard")).toBeNull();
  });
});

describe("policy helpers", () => {
  it("becomesAdmin: only the moment admin is gained (role, second role, or reactivation)", () => {
    expect(becomesAdmin({ role: "office" }, { role: "admin" })).toBe(true);
    expect(becomesAdmin({ role: "office", secondary_role: null }, { role: "office", secondary_role: "admin" })).toBe(true);
    expect(becomesAdmin({ role: "admin", active: false }, { role: "admin", active: true })).toBe(true);
    expect(becomesAdmin(null, { role: "admin" })).toBe(true);
    expect(becomesAdmin({ role: "admin" }, { role: "admin", secondary_role: "office" })).toBe(false);
    expect(becomesAdmin({ role: "office", secondary_role: "admin" }, { role: "admin" })).toBe(false);
    expect(becomesAdmin({ role: "admin" }, { role: "office" })).toBe(false);
    expect(becomesAdmin({ role: "office" }, { role: "admin", active: false })).toBe(false);
  });

  it("changesAdmin (audit Z1): admin given or taken by a PATCH; other changes, and admin kept, are not", () => {
    const office = { role: "office", secondary_role: null, active: true };
    const admin = { role: "admin", secondary_role: null, active: true };
    expect(changesAdmin(office, { role: "admin" })).toBe(true);
    expect(changesAdmin(office, { secondary_role: "admin" })).toBe(true);
    expect(changesAdmin(admin, { role: "office" })).toBe(true);
    expect(changesAdmin({ ...office, secondary_role: "admin" }, { secondary_role: null })).toBe(true);
    expect(changesAdmin({ ...admin, active: false }, { active: true })).toBe(true);
    expect(changesAdmin({ ...office, active: false }, { role: "admin" })).toBe(true);
    expect(changesAdmin(office, { role: "viewer", secondary_role: "workshop", active: false })).toBe(false);
    expect(changesAdmin(admin, { secondary_role: "office" })).toBe(false);
    expect(changesAdmin({ ...office, secondary_role: "admin" }, { role: "admin", secondary_role: null })).toBe(false);
    expect(changesAdmin(admin, {})).toBe(false);
  });

  it("shouldCheckEnrolment: never when the global switch is on or for non-admins; not once a factor exists", () => {
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: true })).toBe(true);
    expect(shouldCheckEnrolment({ globalRequired: true, holdsAdmin: true })).toBe(false);
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: false })).toBe(false);
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: true, currentLevel: "aal1", nextLevel: "aal2" })).toBe(false);
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: true, currentLevel: "aal2", nextLevel: "aal2" })).toBe(false);
    expect(shouldCheckEnrolment({ globalRequired: false, holdsAdmin: true, currentLevel: "aal1", nextLevel: "aal1" })).toBe(true);
  });

  it("parseAdminMfaOverview: reads the database answer, refuses anything else", () => {
    const parsed = parseAdminMfaOverview({ require_admin_mfa: false, can_require: false, admins: [{ user_id: "a", enrolled: true, enrolment_required: false }, { user_id: "b", enrolled: false, enrolment_required: true }] });
    expect(parsed?.admins.get("b")).toEqual({ enrolled: false, enrolmentRequired: true });
    expect(parsed?.canRequire).toBe(false);
    expect(parseAdminMfaOverview(null)).toBeNull();
    expect(parseAdminMfaOverview({ require_admin_mfa: "no", can_require: true, admins: [] })).toBeNull();
    expect(parseAdminMfaOverview({ require_admin_mfa: false, can_require: true, admins: [{ user_id: 1 }] })).toBeNull();
  });

  it("status labels and the rule message name who has not set it up", () => {
    expect(adminMfaStatusLabel({ enrolled: true, enrolmentRequired: true })).toBe("Two-step sign-in: set up");
    expect(adminMfaStatusLabel({ enrolled: false, enrolmentRequired: true })).toMatch(/not set up \(asked at next sign-in\)/);
    expect(adminMfaStatusLabel({ enrolled: false, enrolmentRequired: false })).toBe("Two-step sign-in: not set up");
    expect(adminMfaStatusLabel(undefined)).toMatch(/unknown/);

    const names: Record<string, string> = { a: "Ann", b: "Bob", c: "Cat" };
    const off = parseAdminMfaOverview({ require_admin_mfa: false, can_require: false, admins: [{ user_id: "a", enrolled: true }, { user_id: "c", enrolled: false }, { user_id: "b", enrolled: false }] })!;
    expect(adminMfaRuleMessage(off, (id) => names[id])).toEqual({ tone: "warn", text: "Two-step sign-in can't be required for this company yet: Bob, Cat have not set up an authenticator app." });
    const ready = parseAdminMfaOverview({ require_admin_mfa: false, can_require: true, admins: [{ user_id: "a", enrolled: true }] })!;
    expect(adminMfaRuleMessage(ready, (id) => names[id]).tone).toBe("ok");
    const onMissing = parseAdminMfaOverview({ require_admin_mfa: true, can_require: false, admins: [{ user_id: "b", enrolled: false, enrolment_required: true }] })!;
    expect(adminMfaRuleMessage(onMissing, (id) => names[id])).toMatchObject({ tone: "warn" });
    expect(adminMfaRuleMessage(onMissing, (id) => names[id]).text).toContain("Bob must set up");
    expect(ADMIN_MFA_ONBOARDING_NOTICE).toMatch(/authenticator app/);
  });
});
