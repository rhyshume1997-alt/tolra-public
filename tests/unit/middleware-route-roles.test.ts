/**
 * The middleware's page gate by role (ROUTE_ROLES; the browser suite's tests/e2e/roles.spec.ts checks the same with real users).
 * Audit Z6: /ai-helper had no rule, so workshop and viewer staff could open the page; it is office and admin only now.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let role = "office";

const profileChain = () => {
  const row = { role, secondary_role: null, active: true, organization_id: "org-1", must_change_password: false };
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" ? () => Promise.resolve({ data: row, error: null }) : () => c) });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
      signOut: async () => ({ error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
    from: () => profileChain(),
    rpc: async (name: string) => {
      if (name === "my_session") return { data: { user_id: "user-1", organization_id: "org-1", role, secondary_role: null, platform_admin: false, organization_count: 1, hidden_sections: [] }, error: null };
      // Not a newly made admin (065): no enrolment step in the way.
      if (name === "my_mfa_enrolment_required") return { data: false, error: null };
      return { data: null, error: null };
    },
  }),
}));

import { middleware } from "@/middleware";

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
const visit = async (path: string) => {
  const location = (await middleware(new NextRequest(`https://app.test${path}`))).headers.get("location");
  return location ? new URL(location).pathname : null;
};

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

describe("middleware: pages by role", () => {
  it("/ai-helper (and its sub-pages): admin and office open it; workshop and viewer go to the dashboard", async () => {
    for (const allowed of ["admin", "office"]) {
      role = allowed;
      expect(await visit("/ai-helper"), allowed).toBeNull();
      expect(await visit("/ai-helper/anything"), allowed).toBeNull();
    }
    for (const refused of ["workshop", "viewer"]) {
      role = refused;
      expect(await visit("/ai-helper"), refused).toBe("/dashboard");
      expect(await visit("/ai-helper/anything"), refused).toBe("/dashboard");
    }
  });

  it("/numbers (and its sub-pages): admin only; office, workshop and viewer go to the dashboard", async () => {
    role = "admin";
    expect(await visit("/numbers")).toBeNull();
    expect(await visit("/numbers/anything")).toBeNull();
    for (const refused of ["office", "workshop", "viewer"]) {
      role = refused;
      expect(await visit("/numbers"), refused).toBe("/dashboard");
      expect(await visit("/numbers/anything"), refused).toBe("/dashboard");
    }
  });

  it("the existing rules are unchanged (a sample)", async () => {
    role = "workshop";
    expect(await visit("/jobs")).toBeNull();
    expect(await visit("/invoices")).toBe("/dashboard");
    role = "office";
    expect(await visit("/invoices")).toBeNull();
    expect(await visit("/admin/users")).toBe("/dashboard");
  });
});
