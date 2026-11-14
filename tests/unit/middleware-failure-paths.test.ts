/**
 * Module 1 boundary: synthetic Auth/PostgREST responses -> real middleware decisions using the unchanged gateway retry helper.
 * No database/RLS proof is claimed. Preserve staff, MFA, company, Portal and cookie isolation; never replace failures with roles.
 */
import { NextRequest } from "next/server";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { status: number; body?: unknown } | "network";
const h = vi.hoisted(() => ({
  replies: new Map<string, Reply[]>(), counts: new Map<string, number>(), signOuts: 0,
  refreshedCookie: false, clients: 0,
  authError: null as Error | null,
  cookieBatches: [] as Array<Array<{ name: string; value: string; options: { path: string; maxAge?: number } }>>,
  user: { id: "user-1" } as { id: string } | null,
  profile: { role: "viewer", secondary_role: null, active: true, organization_id: "old-company", must_change_password: false },
  session: {} as Record<string, unknown>,
  assurance: { currentLevel: "aal1", nextLevel: "aal1" },
}));

// The SDK edge is simulated; each read really invokes the fetch supplied by middleware, so retry counts test the real helper.
vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, _key: string, options: {
    global?: { fetch: typeof fetch };
    cookies: { setAll: (cookies: Array<{ name: string; value: string; options: { path: string; maxAge?: number } }>) => void };
  }) => {
    h.clients += 1;
    async function read<T>(path: string, method = "GET") {
      const response = await (options.global?.fetch ?? fetch)(`${url}${path}`, { method });
      if (!response.ok) return { data: null as T | null, error: { message: "synthetic upstream error", status: response.status }, status: response.status };
      return { data: await response.json() as T, error: null, status: response.status };
    }
    const chain = {
      select: () => chain, eq: () => chain,
      maybeSingle: <T,>() => read<T>("/rest/v1/user_profiles"),
    };
    return {
      auth: {
        getUser: async () => {
          for (const batch of h.cookieBatches) options.cookies.setAll(batch);
          if (h.authError) return { data: { user: null }, error: h.authError };
          if (h.refreshedCookie) options.cookies.setAll([{ name: "sb-local-auth-token", value: "changed-by-sdk", options: { path: "/", maxAge: 0 } }]);
          const result = await read<{ id: string }>("/auth/v1/user");
          return { ...result, data: { user: result.data } };
        },
        signOut: async () => { h.signOuts += 1; return { error: null }; },
        mfa: { getAuthenticatorAssuranceLevel: () => read("/auth/v1/factors") },
      },
      from: () => chain,
      rpc: (name: string) => read(`/rest/v1/rpc/${name}`, "POST"),
    };
  },
}));

import { middleware } from "@/middleware";

const AUTH = "/auth/v1/user";
const PROFILE = "/rest/v1/user_profiles";
const SESSION = "/rest/v1/rpc/my_session";
const MFA = "/auth/v1/factors";
const ENROL = "/rest/v1/rpc/my_mfa_enrolment_required";
const envKeys = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "REQUIRE_ADMIN_MFA"] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of envKeys) { originalEnv.set(key, process.env[key]); delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://backend.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon";
  h.replies.clear(); h.counts.clear(); h.signOuts = 0; h.clients = 0; h.refreshedCookie = false; h.authError = null; h.cookieBatches = [];
  h.user = { id: "user-1" };
  h.profile = { role: "viewer", secondary_role: null, active: true, organization_id: "old-company", must_change_password: false };
  h.session = { user_id: "user-1", organization_id: "current-company", role: "admin", secondary_role: null,
    hidden_sections: [], platform_admin: false, organization_count: 1, needs_choice: false };
  h.assurance = { currentLevel: "aal1", nextLevel: "aal1" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    h.counts.set(path, (h.counts.get(path) ?? 0) + 1);
    const defaults: Record<string, unknown> = { [AUTH]: h.user, [PROFILE]: h.profile, [SESSION]: h.session, [MFA]: h.assurance, [ENROL]: false };
    const queue = h.replies.get(path);
    const reply = queue?.shift() ?? { status: 200, body: defaults[path] };
    if (reply === "network") throw new TypeError("fetch failed: synthetic private detail");
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of envKeys) { const value = originalEnv.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const visit = (path = "/jobs", cookie = "sb-local-auth-token=original-staff-cookie") => middleware(new NextRequest(`https://app.test${path}`, { headers: { cookie } }));
const location = (response: Response) => response.headers.get("location") ? new URL(response.headers.get("location")!).pathname + new URL(response.headers.get("location")!).search : null;
async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("5");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBeNull();
  expect(h.signOuts).toBe(0);
  expect(await response.text()).toBe(JSON.stringify({ error: "Service temporarily unavailable. Please try again." }));
}
const gateway = (path: string, statuses: number[]) => h.replies.set(path, statuses.map((status) => ({ status })));

describe("middleware: fail closed verified authorisation", () => {
  it("my_session 502 then success uses the company admin rather than the viewer profile", async () => {
    gateway(SESSION, [502]);
    const response = await visit("/settings");
    expect(response.status).toBe(200); expect(location(response)).toBeNull(); expect(h.counts.get(SESSION)).toBe(2);
  });
  it("persistent my_session 502 returns 503, never a viewer redirect", async () => {
    gateway(SESSION, [502, 502, 200]); await expectUnavailable(await visit("/settings")); expect(h.counts.get(SESSION)).toBe(2);
  });
  it("profile 502 then success still verifies my_session", async () => {
    gateway(PROFILE, [502]); const response = await visit("/settings");
    expect(response.status).toBe(200); expect(location(response)).toBeNull(); expect(h.counts.get(PROFILE)).toBe(2); expect(h.counts.get(SESSION)).toBe(1);
  });
  it("persistent profile 502 returns 503 before using any profile role", async () => {
    gateway(PROFILE, [502, 502]); await expectUnavailable(await visit()); expect(h.counts.get(PROFILE)).toBe(2); expect(h.counts.has(SESSION)).toBe(false);
  });
  it.each([AUTH, PROFILE, SESSION])("network failure of %s returns 503 without a helper retry", async (path) => {
    h.replies.set(path, ["network"]); await expectUnavailable(await visit()); expect(h.counts.get(path)).toBe(1);
  });
  it("verified missing database session redirects to login without profile fallback", async () => {
    h.replies.set(SESSION, [{ status: 200, body: null }]); const response = await visit();
    expect(location(response)).toBe("/login"); expect(response.status).toBe(307); expect(h.signOuts).toBe(0);
  });
  it("verified viewer cannot use the profile's admin role to open Settings", async () => {
    h.profile.role = "admin"; h.session.role = "viewer";
    expect(location(await visit("/settings"))).toBe("/dashboard");
  });
  it("password-only platform owner must reach aal2 before /jobs", async () => {
    h.session.platform_admin = true; expect(location(await visit())).toBe("/mfa"); expect(h.counts.get(MFA)).toBe(1);
  });
  it("platform owner with aal2 and a chosen company may open /jobs", async () => {
    h.session.platform_admin = true; h.assurance = { currentLevel: "aal2", nextLevel: "aal2" };
    const response = await visit(); expect(response.status).toBe(200); expect(location(response)).toBeNull();
  });
  it("verified platform owner without a company must complete company setup", async () => {
    h.session.platform_admin = true; h.session.organization_id = null; h.assurance = { currentLevel: "aal2", nextLevel: "aal2" };
    expect(location(await visit())).toBe("/platform");
  });
  it("verified multi-company staff without a choice must choose a company", async () => {
    h.session.organization_id = null; h.session.needs_choice = true; h.session.organization_count = 2;
    expect(location(await visit())).toBe("/choose-company");
  });
  it("a verified hidden Jobs section remains blocked", async () => {
    h.session.hidden_sections = ["jobs"]; expect(location(await visit())).toBe("/dashboard?blocked=1");
  });
  it.each(["/portal", "/portal/", "/portal/signin", "/portal/quotes"]) ("Portal namespace %s is delegated before staff reads", async (path) => {
    gateway(AUTH, [502, 502]); const response = await visit(path, "tolra_portal=synthetic-customer");
    expect(response.status).toBe(200); expect(h.clients).toBe(0); expect(h.counts.size).toBe(0);
  });
  it("a Portal customer cookie cannot authorise a protected staff route", async () => {
    h.user = null; const response = await visit("/jobs", "tolra_portal=synthetic-customer");
    expect(location(response)).toBe("/login"); expect(h.counts.has(SESSION)).toBe(false);
  });
  it.each(["/jobs", "/schedule", "/time"]) ("offline %s cannot open with an unverified Auth session and staff cookie", async (path) => {
    gateway(AUTH, [502, 502]); await expectUnavailable(await visit(path)); expect(h.counts.get(AUTH)).toBe(2);
  });
  it("an SDK cookie mutation is not sent to the browser on an unavailable read", async () => {
    h.refreshedCookie = true; gateway(SESSION, [502, 502]); await expectUnavailable(await visit());
  });
  it("an outage cannot trigger idle sign-out before session verification", async () => {
    gateway(SESSION, [502, 502]); await expectUnavailable(await visit("/jobs", "sb-local-auth-token=original; tolra_last_active=1"));
  });
  it.each([500, 503, 504])("persistent session HTTP %s is unavailable with at most one permitted retry", async (status) => {
    gateway(SESSION, [status, status]); await expectUnavailable(await visit()); expect(h.counts.get(SESSION)).toBe(status === 500 ? 1 : 2);
  });
  it("a session naming another user is unavailable rather than borrowing that company's role", async () => {
    h.session.user_id = "other-user"; await expectUnavailable(await visit());
  });
  it("malformed session data never falls back to the profile", async () => {
    h.replies.set(SESSION, [{ status: 200, body: {} }]); await expectUnavailable(await visit());
  });
  it("verified inactive profile retains the existing disabled-account policy", async () => {
    h.profile.active = false; const response = await visit(); expect(location(response)).toBe("/login?disabled=1"); expect(h.signOuts).toBe(1);
  });
  it("a genuinely signed-out user still reaches login", async () => {
    h.user = null; expect(location(await visit())).toBe("/login");
  });
  it("an unavailable MFA assurance check cannot admit a platform owner", async () => {
    h.session.platform_admin = true; gateway(MFA, [502, 502]); await expectUnavailable(await visit()); expect(h.counts.get(MFA)).toBe(2);
  });
  it("an unavailable enrolment read cannot silently exempt an admin", async () => {
    gateway(ENROL, [502]); await expectUnavailable(await visit()); expect(h.counts.get(ENROL)).toBe(1);
  });
  it.each([
    ["platform_admin", undefined], ["platform_admin", "false"], ["hidden_sections", undefined], ["hidden_sections", [null]],
    ["needs_choice", undefined], ["organization_count", -1], ["organization_id", 7], ["role", undefined],
  ])("incomplete session security field %s is unavailable, never defaulted", async (key, value) => {
    h.session[key as string] = value; await expectUnavailable(await visit());
  });
  it("malformed assurance cannot approve a platform owner's session", async () => {
    h.session.platform_admin = true; h.replies.set(MFA, [{ status: 200, body: { currentLevel: "aal2" } }]);
    await expectUnavailable(await visit());
  });
  it("malformed enrolment response cannot mean not required", async () => {
    h.replies.set(ENROL, [{ status: 200, body: null }]); await expectUnavailable(await visit());
  });
  it("profile permission denial is stable rather than a dashboard redirect loop", async () => {
    gateway(PROFILE, [403]); const response = await visit("/dashboard");
    expect(response.status).toBe(403); expect(location(response)).toBeNull(); expect(h.signOuts).toBe(0);
  });
  it("MFA permission denial is stable rather than an MFA redirect loop", async () => {
    h.session.platform_admin = true; gateway(MFA, [403]); const response = await visit("/mfa");
    expect(response.status).toBe(403); expect(location(response)).toBeNull(); expect(h.signOuts).toBe(0);
  });
  it("MFA outage is classified before any idle sign-out side effect", async () => {
    h.session.platform_admin = true; gateway(MFA, [502, 502]);
    await expectUnavailable(await visit("/jobs", "sb-local-auth-token=original; tolra_last_active=1"));
  });
  it("verified missing session on public login does not redirect to itself", async () => {
    h.replies.set(SESSION, [{ status: 200, body: null }]); const response = await visit("/login");
    expect(response.status).toBe(200); expect(location(response)).toBeNull();
  });

  it.each(["/platform", "/choose-company"]) ("no company membership cannot authorise the setup page %s", async (path) => {
    h.session.organization_id = null; h.session.organization_count = 0; h.session.needs_choice = false;
    const response = await visit(path); expect(response.status).toBe(403); expect(location(response)).toBeNull();
  });

  it("verified owner aal1 with an expired idle clock signs out before MFA routing", async () => {
    h.session.platform_admin = true;
    const response = await visit("/jobs", "sb-local-auth-token=original; tolra_last_active=1");
    expect(location(response)).toBe("/login?expired=1"); expect(h.signOuts).toBe(1);
  });
  it("verified enrolment requirement with an expired idle clock signs out before enrolment routing", async () => {
    h.replies.set(ENROL, [{ status: 200, body: true }]);
    const response = await visit("/jobs", "sb-local-auth-token=original; tolra_last_active=1");
    expect(location(response)).toBe("/login?expired=1"); expect(h.signOuts).toBe(1);
  });
  it("verified session permission denial is 403 rather than unavailable", async () => {
    gateway(SESSION, [403]); const response = await visit();
    expect(response.status).toBe(403); expect(response.headers.get("retry-after")).toBeNull();
    expect(location(response)).toBeNull(); expect(h.signOuts).toBe(0);
  });

  it.each(["refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired"])("real AuthApiError400 %s is signed out and carries SDK cookie deletion to login", async (code) => {
    h.authError = new AuthApiError("Invalid session", 400, code);
    h.cookieBatches = [[{ name: "sb-local-auth-token", value: "", options: { path: "/", maxAge: 0 } }]];
    const response = await visit("/jobs");
    expect(response.status).toBe(307); expect(location(response)).toBe("/login");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.cookies.get("sb-local-auth-token")).toMatchObject({ value: "", maxAge: 0, path: "/" });
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(h.counts.has(PROFILE)).toBe(false); expect(h.counts.has(SESSION)).toBe(false); expect(h.signOuts).toBe(0);
  });
  it("revoked refresh preserves clearing of every cookie chunk across SDK callbacks and does not loop on login", async () => {
    h.authError = new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found");
    h.cookieBatches = [
      [{ name: "sb-local-auth-token.0", value: "", options: { path: "/", maxAge: 0 } }],
      [{ name: "sb-local-auth-token.1", value: "", options: { path: "/", maxAge: 0 } }],
    ];
    const response = await visit("/settings", "sb-local-auth-token.0=revoked-0; sb-local-auth-token.1=revoked-1");
    expect(response.status).toBe(307); expect(location(response)).toBe("/login");
    for (const name of ["sb-local-auth-token.0", "sb-local-auth-token.1"]) {
      expect(response.cookies.get(name)).toMatchObject({ value: "", maxAge: 0, path: "/" });
    }
    const login = await visit("/login", "");
    expect(login.status).toBe(200); expect(location(login)).toBeNull();
    expect(login.cookies.getAll()).toHaveLength(2); expect(h.counts.size).toBe(0);
  });
  it("ambiguous real AuthApiError400 does not erase a potentially valid session", async () => {
    h.authError = new AuthApiError("Ambiguous request", 400, "validation_failed");
    h.cookieBatches = [[{ name: "sb-local-auth-token", value: "", options: { path: "/", maxAge: 0 } }]];
    await expectUnavailable(await visit());
  });
  it("an unrecognised400 error object cannot impersonate confirmed revoked authentication", async () => {
    h.authError = Object.assign(new Error("Unknown source"), { status: 400, code: "refresh_token_not_found" });
    await expectUnavailable(await visit());
  });
  it("real retryable Auth service failure retains browser cookies rather than forwarding SDK clearing", async () => {
    h.authError = new AuthRetryableFetchError("Service unavailable", 503);
    h.cookieBatches = [[{ name: "sb-local-auth-token", value: "", options: { path: "/", maxAge: 0 } }]];
    await expectUnavailable(await visit());
  });
  it("server failure status takes precedence even if its code resembles revoked authentication", async () => {
    h.authError = new AuthApiError("Server failure", 503, "refresh_token_not_found");
    await expectUnavailable(await visit());
  });

});
