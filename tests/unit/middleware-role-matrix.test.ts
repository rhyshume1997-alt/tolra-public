/**
 * S2 (Fri 30 Oct): the page gate by URL, pinned as a matrix of every page x every kind of login. middleware.ts is the real page gate
 * (ROUTE_ROLES: "Client-side RoleGate is cosmetic"); the database refuses the data underneath (RLS) and every API route guards itself
 * (tests/unit/api-route-guards.test.ts, tests/unit/api-role-matrix.test.ts). The expected table below is the code's own rule, written
 * out: middleware.ts ROUTE_ROLES, which agrees with the sidebar's lib/sections.ts MEMBER_SECTIONS (checked below). There are no role
 * guides in this repository, so the code is the source of truth.
 *
 * Every app/**\/page.tsx is enumerated: a new page fails here until it is given a row (gated, or open to anyone signed in, with why).
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MEMBER_SECTIONS } from "@/lib/sections";

type Persona = {
  role: string | null;
  secondary?: string | null;
  support?: boolean;
  platform?: boolean;
  organization?: string | null;
};
let who: Persona;

const profileChain = () => {
  const row = { role: who.role ?? "viewer", secondary_role: who.secondary ?? null, active: true, organization_id: "org-1", must_change_password: false };
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" ? () => Promise.resolve({ data: row, error: null }) : () => c) });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
      signOut: async () => ({ error: null }),
      // Everyone has passed the second step here, so the MFA gate never decides; this test is about roles.
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }) },
    },
    from: () => profileChain(),
    rpc: async (name: string) => {
      if (name === "my_session") {
        const organization_id = who.organization === undefined ? "org-1" : who.organization;
        return {
          data: {
            user_id: "user-1", organization_id, organization_name: organization_id ? "Alpha" : null, role: organization_id ? who.role : null,
            secondary_role: organization_id ? who.secondary ?? null : null, support: who.support === true, read_only: who.support === true,
            platform_admin: who.platform === true, organization_count: 1, needs_choice: false, hidden_sections: [],
          },
          error: null,
        };
      }
      return { data: false, error: null };
    },
  }),
}));

import { middleware } from "@/middleware";

const visit = async (target: string, method = "GET") => {
  const response = await middleware(new NextRequest(`https://app.test${target}`, { method }));
  const location = response.headers.get("location");
  return location ? new URL(location).pathname + new URL(location).search : null;
};

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.REQUIRE_ADMIN_MFA = "false";
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

const PERSONAS: Record<string, Persona> = {
  admin: { role: "admin" },
  office: { role: "office" },
  workshop: { role: "workshop" },
  viewer: { role: "viewer" },
  "office+admin": { role: "office", secondary: "admin" },
  "workshop+office": { role: "workshop", secondary: "office" },
  // The platform owner inside a company through a support membership: the membership's role decides the pages (the database keeps it
  // read-only and the API routes refuse the admin actions).
  "support(admin)": { role: "admin", support: true, platform: true },
  // The platform owner with no company chosen: only the platform page.
  "platform-no-company": { role: null, platform: true, organization: null },
};

const A = ["admin", "office+admin", "support(admin)"];
const AO = [...A, "office", "workshop+office"];
const AOW = [...AO, "workshop"];
const ALL = [...AOW, "viewer"];

/** Section prefix -> the personas that may open it (middleware ROUTE_ROLES, written out). Everyone else goes to /dashboard. */
const GATED: Record<string, string[]> = {
  "/admin": A,
  "/settings": A,
  "/numbers": A,
  "/invoices": AO,
  "/sales-orders": AO,
  "/approval": AO,
  "/email": AO,
  "/quotes": AO,
  "/rfq": AO,
  "/suppliers": AO,
  "/customers": AO,
  "/purchase-orders": AO,
  "/delivery-notes": AOW,
  "/time": AOW,
  "/jobs": ALL,
  "/schedule": ALL,
};
/** Pages the middleware opens to anyone signed in, and why that is safe. */
const OPEN: Record<string, string> = {
  "/": "redirects to /dashboard",
  "/dashboard": "every role's home; each tile reads its own data under RLS",
  "/choose-company": "lists only the caller's own companies (my_organizations as the caller)",
  "/select-role": "chooses between the caller's own roles",
  "/mfa": "setting up or entering the caller's own second step",
};
/** Pages the middleware lets through before sign-in, or that are not business pages. */
/** The platform owner's page: lib/session-info.ts companyStepRoute sends anyone else in a company to /dashboard. */
const PLATFORM = ["support(admin)", "platform-no-company"];
const PRE_AUTH = new Set(["/login", "/auth/set-password", "/configuration-error"]);
/** Owned by the Design session (its /ai-helper route guard fix): not pinned here so the two changes don't collide. */
const NOT_PINNED = new Set(["/ai-helper"]);

const APP = path.resolve(__dirname, "../../app");
const pages = (readdirSync(APP, { recursive: true }) as string[])
  .filter((rel) => path.basename(rel) === "page.tsx")
  .map((rel) => {
    const segments = path.dirname(rel).split(path.sep).filter((s) => s !== "." && !/^\(.*\)$/.test(s));
    return "/" + segments.map((s) => (s.startsWith("[") ? "11111111-1111-4111-8111-111111111111" : s)).join("/");
  })
  .sort();

const gateOf = (page: string) => Object.keys(GATED).find((prefix) => page === prefix || page.startsWith(prefix + "/"));

describe("every page has a row", () => {
  it("finds the pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(30);
    expect(pages).toContain("/admin/users");
  });

  it("each page is gated, open to anyone signed in (with a reason), pre-sign-in, or deliberately not pinned", () => {
    const unclassified = pages.filter((p) => !gateOf(p) && !OPEN[p] && p !== "/platform" && !PRE_AUTH.has(p) && !NOT_PINNED.has(p));
    expect(unclassified).toEqual([]);
  });

  it("the gate agrees with the sidebar's sections (lib/sections.ts): same roles for the same page", () => {
    const personasFor = (roles: string[]) => Object.keys(PERSONAS).filter((name) => {
      const p = PERSONAS[name];
      return p.organization !== null && [p.role, p.secondary].some((r) => r && roles.includes(r));
    }).sort();
    for (const section of MEMBER_SECTIONS) expect([section.href, [...GATED[section.href]].sort()]).toEqual([section.href, personasFor(section.roles)]);
  });

  it("no page under a gated prefix ends in a dynamic segment, so an asset-looking URL (/x/<id>.png, let through as an asset) can't reach one", () => {
    const APP_DYNAMIC_LAST = (readdirSync(APP, { recursive: true }) as string[])
      .filter((rel) => path.basename(rel) === "page.tsx" && path.basename(path.dirname(rel)).startsWith("["));
    expect(APP_DYNAMIC_LAST).toEqual([]);
  });
});

describe("page x login matrix (typing the URL)", () => {
  for (const page of pages.filter((p) => gateOf(p))) {
    it(`${page}`, async () => {
      const allowed = GATED[gateOf(page)!];
      const got: Record<string, string | null> = {};
      const want: Record<string, string | null> = {};
      for (const [name, persona] of Object.entries(PERSONAS)) {
        who = persona;
        got[name] = await visit(page);
        want[name] = persona.organization === null ? "/platform" : allowed.includes(name) ? null : "/dashboard";
      }
      expect(got).toEqual(want);
    });
  }

  it("/platform (the platform owner only)", async () => {
    for (const [name, persona] of Object.entries(PERSONAS)) {
      who = persona;
      expect([name, await visit("/platform")]).toEqual([name, PLATFORM.includes(name) ? null : "/dashboard"]);
    }
  });

  for (const page of Object.keys(OPEN)) {
    it(`${page} (open to anyone signed in)`, async () => {
      for (const [name, persona] of Object.entries(PERSONAS)) {
        who = persona;
        const expected = persona.organization === null && page !== "/platform" && page !== "/mfa" ? "/platform" : null;
        expect([name, await visit(page)]).toEqual([name, expected]);
      }
    });
  }
});

describe("URL variants a workshop or office login might try", () => {
  beforeEach(() => { who = PERSONAS.workshop; });

  it("trailing slash, sub-paths, query strings, doubled slashes and the bare prefix are all gated", async () => {
    for (const target of ["/admin", "/admin/", "/admin/users", "/admin/users/", "/admin/users?tab=roles", "/admin//users", "/admin/users/../integrations", "/settings/", "/invoices?x=.png"]) {
      expect([target, await visit(target)]).toEqual([target, "/dashboard"]);
    }
  });

  it("HEAD and OPTIONS are gated like GET (the middleware does not look at the method)", async () => {
    for (const method of ["HEAD", "OPTIONS", "POST"]) expect([method, await visit("/admin/users", method)]).toEqual([method, "/dashboard"]);
  });

  it("office is refused the admin pages by every variant too", async () => {
    who = PERSONAS.office;
    for (const target of ["/admin", "/admin/", "/admin/users", "/admin/integrations", "/admin/data", "/settings", "/settings/"]) {
      expect([target, await visit(target)]).toEqual([target, "/dashboard"]);
    }
  });

  it("a different-case URL is not a page (app routes are case-sensitive), so the gate letting it through exposes nothing", () => {
    expect(pages.filter((p) => p !== p.toLowerCase())).toEqual([]);
  });

  // KNOWN GAP S2-F1 (deferred: middleware.ts is owned by the Design session; patch in docs/handover-notes/S2-deferred-patches.md).
  // The gate compares the raw pathname, but a production `next start` serves the DECODED path (node_modules/next/dist/server/lib/
  // router-utils/filesystem.js getItem: "check decoded variant as well", outside dev). So /%61dmin/users renders the Admin > Users shell
  // for a workshop login. The page's RoleGate still shows Access Denied and RLS / the API refuse the data, so nothing is read, but the
  // real gate is skipped. `it.fails`: this passes while the gap is open and turns red once the patch lands; then make it a plain `it`.
  it.fails("percent-encoded paths are gated too (/%61dmin/users, /admin%2Fusers, /%73ettings)", async () => {
    for (const target of ["/%61dmin/users", "/admin%2Fusers", "/%73ettings", "/%69nvoices"]) {
      expect([target, await visit(target)]).toEqual([target, "/dashboard"]);
    }
  });
});
