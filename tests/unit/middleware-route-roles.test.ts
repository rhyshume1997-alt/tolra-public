/**
 * BOUNDARY (module 1): synthetic requests -> middleware decisions and the existing Portal page guard.
 * Must preserve staff role assertions; Portal RPC stubs here prove delegation only, never database security.
 * The middleware's page gate by role (ROUTE_ROLES; the browser suite's tests/e2e/roles.spec.ts checks the same with real users).
 * Audit Z6: /ai-helper had no rule, so workshop and viewer staff could open the page; it is office and admin only now.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let role = "office";
let signedIn = true;
const portal = vi.hoisted(() => ({ cookies: vi.fn(), resolve: vi.fn(), staffAuth: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: portal.cookies }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/portal/server", () => ({ resolvePortalSession: portal.resolve }));

const profileChain = () => {
  const row = { role, secondary_role: null, active: true, organization_id: "org-1", must_change_password: false };
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" ? () => Promise.resolve({ data: row, error: null }) : () => c) });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => { portal.staffAuth(); return { data: { user: signedIn ? { id: "user-1" } : null }, error: null }; },
      signOut: async () => ({ error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
    from: () => profileChain(),
    rpc: async (name: string) => {
      if (name === "my_session") return { data: { user_id: "user-1", organization_id: "org-1", role, secondary_role: null, platform_admin: false, needs_choice: false, organization_count: 1, hidden_sections: [] }, error: null };
      // Not a newly made admin (065): no enrolment step in the way.
      if (name === "my_mfa_enrolment_required") return { data: false, error: null };
      return { data: null, error: null };
    },
  }),
}));

import { middleware } from "@/middleware";
import { portalSession } from "@/components/portal/portal-data";

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "CUSTOMER_PORTAL_ENABLED"];
const saved: Record<string, string | undefined> = {};
const visit = async (path: string) => {
  const location = (await middleware(new NextRequest(`https://app.test${path}`))).headers.get("location");
  return location ? new URL(location).pathname : null;
};

beforeEach(() => {
  signedIn = true;
  role = "office";
  vi.clearAllMocks();
  portal.cookies.mockResolvedValue({ get: () => undefined });
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


describe("middleware: separate customer Portal authentication", () => {
  it.each(["/portal", "/portal/", "/portal/signin", "/portal/code/abc", "/portal/quotes", "/portal/jobs"])("signed out %s delegates without a staff-login redirect or staff cookie work", async (pathname) => {
    signedIn = false;
    const response = await middleware(new NextRequest(`https://app.test${pathname}`));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.getAll()).toEqual([]);
    expect(portal.staffAuth).not.toHaveBeenCalled();
  });

  it.each(["/portals", "/portaladmin", "/portalanything", "/portal-other", "/Portal", "/portal%2Fquotes"])("prefix collision %s remains staff protected", async (pathname) => {
    signedIn = false;
    expect(await visit(pathname)).toBe("/login");
    expect(portal.staffAuth).toHaveBeenCalledOnce();
  });

  it.each(["/dashboard", "/customers", "/settings", "/admin/users", "/invoices", "/jobs"])("a customer cookie grants no staff access to %s", async (pathname) => {
    signedIn = false;
    for (const name of ["tolra_portal", "__Host-tolra_portal"]) {
      const request = new NextRequest(`https://app.test${pathname}`, { headers: { cookie: `${name}=customer-token` } });
      const response = await middleware(request);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    }
  });

  it("a signed-out staff request still reaches login, and login does not loop", async () => {
    signedIn = false;
    expect(await visit("/dashboard")).toBe("/login");
    expect(await visit("/login")).toBeNull();
    expect(await visit("/portal/signin")).toBeNull();
  });

  it("Portal OFF still refuses at the actual page guard before cookie or session reads", async () => {
    signedIn = false;
    expect(await visit("/portal/quotes")).toBeNull();
    await expect(portalSession()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(portal.cookies).not.toHaveBeenCalled();
    expect(portal.resolve).not.toHaveBeenCalled();
  });

  it("Portal ON without a customer cookie returns no session even for signed-in staff", async () => {
    process.env.CUSTOMER_PORTAL_ENABLED = "true";
    expect(await visit("/portal/quotes")).toBeNull();
    expect(await portalSession()).toBeNull();
    expect(portal.resolve).not.toHaveBeenCalled();
  });

  it("an expired or refused customer session cannot become a staff session", async () => {
    process.env.CUSTOMER_PORTAL_ENABLED = "true";
    signedIn = false;
    portal.cookies.mockResolvedValue({ get: () => ({ value: "refused-token" }) });
    portal.resolve.mockResolvedValue({ ok: false, reason: "refused", correlationId: "safe-id" });
    expect(await portalSession()).toBeNull();
    expect(portal.resolve).toHaveBeenCalledWith("refused-token");
    expect(await visit("/invoices")).toBe("/login");
  });
});
