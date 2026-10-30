/**
 * Review condition (phone lag, fix 3): what refreshes the auth cookies.
 *  - every page request (navigations, reloads, a Link's prefetch) and every /api request runs the middleware's getUser through a
 *    server client whose setAll writes refreshed cookies onto the request and the response, redirects included. For /api this
 *    matters: the routes' own clients are read-only (lib/server/auth.ts), so a refresh there would use up the refresh token and
 *    drop the new one;
 *  - the browser's own client (lib/supabase.ts, @supabase/ssr createBrowserClient) is created with autoRefreshToken on, so it
 *    refreshes its tokens itself and writes them to the same cookies.
 * The browser client below is the real one (real @supabase/ssr and auth-js) built in a stubbed browser; it makes no request.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CookieWrite = { name: string; value: string; options?: Record<string, unknown> };
const server = vi.hoisted(() => ({
  clients: 0,
  calls: [] as string[],
  refreshOnGetUser: null as null | { name: string; value: string; options?: Record<string, unknown> }[],
  signedIn: true,
}));
vi.mock("@supabase/ssr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/ssr")>()),
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: (cookies: CookieWrite[]) => void } }) => {
    server.clients += 1;
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({ data: { role: "office", secondary_role: null, active: true, organization_id: "org-1", must_change_password: false }, error: null });
    return {
      auth: {
        // What @supabase/ssr does when the access token has expired: getUser refreshes the session and hands the new cookies to setAll.
        getUser: async () => {
          server.calls.push("getUser");
          if (server.refreshOnGetUser) options.cookies.setAll(server.refreshOnGetUser);
          return server.signedIn ? { data: { user: { id: "u-1" } }, error: null } : { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } };
        },
        signOut: async () => ({ error: null }),
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
      },
      from: () => chain,
      rpc: async (name: string) => {
        server.calls.push(name);
        if (name === "my_session") return { data: { user_id: "u-1", organization_id: "org-1", role: "office", secondary_role: null, hidden_sections: [], organization_count: 1 }, error: null };
        return { data: null, error: null };
      },
    };
  },
}));

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  server.clients = 0;
  server.calls.length = 0;
  server.refreshOnGetUser = null;
  server.signedIn = true;
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.unstubAllGlobals();
});

const REFRESHED = [
  { name: "sb-abc-auth-token.0", value: "refreshed-part-0", options: { path: "/", sameSite: "lax", maxAge: 400 * 24 * 60 * 60 } },
  { name: "sb-abc-auth-token.1", value: "refreshed-part-1", options: { path: "/", sameSite: "lax", maxAge: 400 * 24 * 60 * 60 } },
];
const visit = async (path: string, headers: Record<string, string> = { cookie: "sb-abc-auth-token=expired-session" }) => {
  const { middleware } = await import("@/middleware");
  return middleware(new NextRequest(`https://app.test${path}`, { headers }));
};

describe("page requests still refresh the auth cookies in the middleware", () => {
  it.each(["/dashboard", "/jobs", "/quotes", "/invoices", "/time/week"])("%s: getUser runs and its refreshed cookies go back to the browser", async (path) => {
    server.refreshOnGetUser = REFRESHED;
    const response = await visit(path);
    expect(server.clients).toBe(1);
    expect(server.calls[0]).toBe("getUser");
    expect(response.headers.get("location")).toBeNull();
    for (const cookie of REFRESHED) expect(response.cookies.get(cookie.name)?.value).toBe(cookie.value);
  });

  it("a redirect (signed-in visit to /login) carries the refreshed cookies too", async () => {
    server.refreshOnGetUser = REFRESHED;
    const response = await visit("/login");
    expect(new URL(response.headers.get("location")!).pathname).toBe("/dashboard");
    for (const cookie of REFRESHED) expect(response.cookies.get(cookie.name)?.value).toBe(cookie.value);
  });

  it("a Link prefetch of a page is a page request: refreshed as well", async () => {
    server.refreshOnGetUser = REFRESHED;
    const response = await visit("/jobs?_rsc=1", { cookie: "sb-abc-auth-token=expired-session", "next-router-prefetch": "1" });
    expect(server.calls[0]).toBe("getUser");
    for (const cookie of REFRESHED) expect(response.cookies.get(cookie.name)?.value).toBe(cookie.value);
  });

  it.each(["/api/audit", "/api/report-error", "/api/mail/status"])("%s with an expired session: getUser refreshes it and the new cookies go back on the response, like a page", async (path) => {
    server.refreshOnGetUser = REFRESHED;
    const response = await visit(path);
    expect(server.clients).toBe(1);
    expect(server.calls).toEqual(["getUser"]); // then on to the route: no page gate
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    for (const cookie of REFRESHED) expect(response.cookies.get(cookie.name)?.value).toBe(cookie.value);
  });

  it("the route sees the refreshed session too: the cookies are written onto the request passed on", async () => {
    server.refreshOnGetUser = REFRESHED;
    const response = await visit("/api/audit");
    // NextResponse.next({ request }) forwards the rewritten request cookies to the route as x-middleware-request-cookie.
    const forwarded = response.headers.get("x-middleware-request-cookie") ?? "";
    for (const cookie of REFRESHED) expect(forwarded).toContain(`${cookie.name}=${cookie.value}`);
  });

  it("files and the installable-app files do not run the middleware's client at all", async () => {
    server.refreshOnGetUser = REFRESHED;
    for (const path of ["/logo.png", "/manifest.webmanifest", "/sw.js", "/offline.html"]) {
      const response = await visit(path);
      expect(response.cookies.get(REFRESHED[0].name)).toBeUndefined();
    }
    expect(server.clients).toBe(0);
    expect(server.calls).toEqual([]);
  });
});

describe("the browser client refreshes its own tokens", () => {
  it("lib/supabase.ts passes no autoRefreshToken: false, persistSession: false or isSingleton: false", async () => {
    const { AUTH_OPTIONS } = await import("@/lib/supabase");
    expect(AUTH_OPTIONS).toEqual({ lockAcquireTimeout: 5000 });
    expect(AUTH_OPTIONS).not.toHaveProperty("autoRefreshToken");
    expect(AUTH_OPTIONS).not.toHaveProperty("persistSession");
  });

  it("in a browser, the client lib/supabase.ts builds has autoRefreshToken on and stores the session in the auth cookies", async () => {
    const cookies = new Map<string, string>();
    const doc = Object.assign(new EventTarget(), {
      get cookie() { return [...cookies].map(([k, v]) => `${k}=${v}`).join("; "); },
      set cookie(text: string) { const [pair] = text.split(";"); const at = pair.indexOf("="); cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1)); },
      visibilityState: "visible",
    });
    const win = Object.assign(new EventTarget(), {
      document: doc,
      location: new URL("https://app.test/dashboard"),
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      history: { replaceState: () => undefined },
    });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    vi.resetModules();
    const { supabase } = await import("@/lib/supabase");
    expect(supabase).not.toBeNull();
    const auth = supabase!.auth as unknown as { autoRefreshToken: boolean; persistSession: boolean; storageKey: string; initializePromise: Promise<unknown>; stopAutoRefresh: () => Promise<void> };
    try {
      await auth.initializePromise; // no stored session: nothing is fetched
      expect(auth.autoRefreshToken).toBe(true);
      expect(auth.persistSession).toBe(true);
      // The session lives in the sb-<project>-auth-token cookies the middleware reads (127 is this test's project ref).
      expect(auth.storageKey).toBe("sb-127-auth-token");
    } finally {
      await auth.stopAutoRefresh();
    }
  });
});
