/**
 * Phone lag (fix 3): files and the installable-app files return from the middleware before the auth server or the database is
 * asked anything. /api routes (each guards itself: api-route-guards.test.ts) are as on main 1939755: the middleware's client runs
 * getUser (it refreshes an expiring session and writes the cookies on the response) and then returns, with no page gate. Every page
 * still goes through getUser and its gates.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  user: null as { id: string } | null,
  profile: { role: "office", secondary_role: null, active: true, organization_id: "org-1", must_change_password: false } as Record<string, unknown>,
  clients: 0,
  calls: [] as string[],
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    server.clients += 1;
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => { server.calls.push("user_profiles"); return { data: server.profile, error: null }; };
    return {
      auth: {
        getUser: async () => { server.calls.push("getUser"); return server.user ? { data: { user: server.user }, error: null } : { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } }; },
        signOut: async () => ({ error: null }),
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
      },
      from: () => chain,
      rpc: async (name: string) => {
        server.calls.push(name);
        if (name === "my_session") return { data: { user_id: "u-1", organization_id: "org-1", role: server.profile.role, secondary_role: null, hidden_sections: [], organization_count: 1 }, error: null };
        return { data: null, error: null };
      },
    };
  },
}));

import { middleware } from "@/middleware";

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  server.user = null;
  server.profile = { role: "office", secondary_role: null, active: true, organization_id: "org-1", must_change_password: false };
  server.clients = 0;
  server.calls.length = 0;
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

const visit = async (path: string, headers: Record<string, string> = {}) => {
  const response = await middleware(new NextRequest(`https://app.test${path}`, { headers }));
  const location = response.headers.get("location");
  return { location: location ? new URL(location).pathname + new URL(location).search : null, response };
};

// Every path that already returned early, and only those (no new public path).
const SKIPPED = [
  "/_next/static/chunks/main.js", "/logo.png", "/icons/apple-touch-icon.png", "/fonts/inter.woff2", "/styles.css", "/robots.txt", "/sw.js",
  "/manifest.webmanifest", "/offline.html",
  // Public site files: crawler files, the icons and the home page's images (the home page "/" itself is not skipped: see below).
  "/sitemap.xml", "/favicon.ico", "/icons/favicon.ico", "/brand/tolra-og.png", "/marketing/mock-quote.svg", "/marketing/tolra-og.png", "/icons/apple-touch-icon.png", "/icons/icon-maskable-512.png",
];
const API = ["/api/pwa-icon", "/api/favicon", "/api/auth/signin", "/api/health", "/api/jobs/x", "/api/audit"];

describe("asset and installable-app paths skip auth entirely", () => {
  for (const path of SKIPPED) {
    it(path, async () => {
      for (const user of [null, { id: "u-1" }]) {
        server.user = user;
        const { location, response } = await visit(path, { cookie: "sb-abc-auth-token=session" });
        expect(location).toBeNull();
        expect(response.headers.get("x-middleware-next")).toBe("1");
      }
      expect(server.clients).toBe(0);
      expect(server.calls).toEqual([]);
    });
  }

  it("/api is not skipped before the client: see below", () => {
    expect(SKIPPED.some((path) => path.startsWith("/api/"))).toBe(false);
  });

  it("a Link prefetch of a page is still a page: it is checked", async () => {
    const { location } = await visit("/jobs?_rsc=1", { "next-router-prefetch": "1" });
    expect(location).toBe("/login");
    expect(server.calls).toEqual(["getUser"]);
  });
});

describe("/api paths run getUser only (refreshing the session cookies), then pass to the route with no page gate", () => {
  for (const path of API) {
    it(path, async () => {
      for (const user of [null, { id: "u-1" }]) {
        server.user = user;
        server.calls.length = 0;
        const { location, response } = await visit(path, { cookie: "sb-abc-auth-token=session" });
        expect(location).toBeNull(); // signed out is not sent to /login: the route answers for itself
        expect(response.headers.get("x-middleware-next")).toBe("1");
        expect(server.calls).toEqual(["getUser"]); // no user_profiles, no my_session
      }
      expect(server.clients).toBe(2);
    });
  }
});

describe('the public home page "/"', () => {
  it("signed out: it opens (no redirect to /login), after getUser only", async () => {
    server.user = null;
    const { location, response } = await visit("/");
    expect(location).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(server.calls).toEqual(["getUser"]);
  });

  it("signed in: it still goes to /dashboard", async () => {
    server.user = { id: "u-1" };
    expect((await visit("/")).location).toBe("/dashboard");
  });

  it("only the exact path is public: other pages and look-alikes still go to /login", async () => {
    for (const path of ["/dashboard", "/jobs", "/robots", "/sitemap", "/brand", "/marketing", "/icons"]) {
      expect((await visit(path)).location, path).toBe("/login");
    }
  });
});

describe('the public privacy page "/privacy"', () => {
  it("signed out: it opens (no redirect to /login), after getUser only", async () => {
    server.user = null;
    const { location, response } = await visit("/privacy");
    expect(location).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(server.calls).toEqual(["getUser"]);
  });

  it("signed in: it opens too (no redirect), with no profile or session reads", async () => {
    server.user = { id: "u-1" };
    const { location } = await visit("/privacy");
    expect(location).toBeNull();
    expect(server.calls).toEqual(["getUser"]);
  });
});

describe("public files can't open anything protected", () => {
  it("only /sitemap.xml skips the checks: any other path ending .xml is a page like any other and goes to /login", async () => {
    for (const path of ["/jobs/export.xml", "/dashboard/feed.xml", "/invoices/x.xml", "/sitemap.xml/x", "/privacy.xml"]) {
      server.calls.length = 0;
      expect((await visit(path)).location, path).toBe("/login");
      expect(server.calls, path).toEqual(["getUser"]);
    }
  });

  it("the marketing folders are not public by prefix: a path there that is not an image file goes to /login", async () => {
    for (const path of ["/brand/x", "/marketing/page", "/icons/admin", "/marketing/", "/privacy/x", "/privacy/../dashboard"]) {
      expect((await visit(path)).location, path).toBe("/login");
    }
  });
});

describe("pages still require a signed-in, active person with the right role (gates unchanged)", () => {
  it("signed out: every page goes to /login; /login, /auth/set-password and /configuration-error open after getUser", async () => {
    for (const page of ["/dashboard", "/jobs", "/quotes", "/invoices", "/admin/users", "/time/week", "/schedule"]) {
      server.calls.length = 0;
      expect((await visit(page)).location, page).toBe("/login");
      expect(server.calls).toEqual(["getUser"]);
    }
    for (const open of ["/login", "/auth/set-password", "/configuration-error"]) {
      server.calls.length = 0;
      expect((await visit(open)).location, open).toBeNull();
      expect(server.calls).toEqual(["getUser"]);
    }
  });

  it("signed in: profile and my_session are read; the role gate, a disabled account and must_change_password still apply", async () => {
    server.user = { id: "u-1" };
    expect((await visit("/quotes")).location).toBeNull();
    expect(server.calls).toEqual(["getUser", "user_profiles", "my_session"]);
    expect((await visit("/admin/users")).location).toBe("/dashboard");
    expect((await visit("/login")).location).toBe("/dashboard");
    server.profile = { ...server.profile, active: false };
    expect((await visit("/jobs")).location).toBe("/login?disabled=1");
    server.profile = { ...server.profile, active: true, must_change_password: true };
    expect((await visit("/dashboard")).location).toBe("/auth/set-password?required=1");
  });
});

describe("the sidebar does not prefetch its ~20 pages (each prefetch was a middleware run with three server reads)", () => {
  it("every sidebar Link has prefetch={false}", () => {
    const source = readFileSync(join(__dirname, "..", "..", "components", "sidebar.tsx"), "utf8");
    const links = source.match(/<Link\b[^>]*>/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toContain("prefetch={false}");
  });
});
