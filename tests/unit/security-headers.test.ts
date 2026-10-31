/**
 * S8: the HTTP security headers (next.config.mjs headers()) and the attributes of every cookie the app's own code sets are pinned.
 * The real config is imported, not a copy. Cookies set by @supabase/ssr itself (the sb-*-auth-token chunks) are driven through the
 * app's own setAll wrappers with the library's real default options, so what the browser would receive is what is checked.
 *
 * Known and accepted (L10): script-src/style-src keep 'unsafe-inline' (Next's inline bootstrap, no nonces). The tests only stop it
 * getting WORSE (no new source, no wildcard, no unsafe-eval in production). The Supabase auth cookies are httpOnly:false by design
 * (the browser client reads the session), which is why the CSP matters.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_COOKIE_OPTIONS } from "@supabase/ssr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SUPABASE_URL = "https://abcdefgh.supabase.co";
const DAY_S = 24 * 60 * 60;

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

async function loadHeaders(env: { NODE_ENV: string; supabaseUrl?: string }) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", env.NODE_ENV);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl ?? "");
  const config = (await import("../../next.config.mjs")).default as { headers: () => Promise<HeaderRule[]>; poweredByHeader?: boolean };
  const rules = await config.headers();
  const all = rules.find((rule) => rule.source === "/(.*)");
  if (!all) throw new Error("no catch-all header rule");
  const get = (key: string) => {
    const hits = all.headers.filter((header) => header.key.toLowerCase() === key.toLowerCase());
    if (hits.length > 1) throw new Error(`${key} is set twice`);
    return hits[0]?.value;
  };
  const csp = new Map((get("Content-Security-Policy") ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...sources] = part.split(/\s+/);
    return [name, sources] as const;
  }));
  return { rules, config, get, csp };
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe("next.config.mjs security headers (production)", () => {
  it("applies one rule to every path", async () => {
    const { rules } = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    expect(rules.map((rule) => rule.source)).toEqual(["/(.*)"]);
  });

  it("HSTS: includeSubDomains and at least 180 days", async () => {
    const { get } = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    const value = get("Strict-Transport-Security") ?? "";
    expect(value).toMatch(/(^|;\s*)includeSubDomains(\s*;|$)/i);
    const maxAge = Number(/max-age=(\d+)/i.exec(value)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(180 * DAY_S);
  });

  it("nosniff, framing denied, no x-powered-by", async () => {
    const { get, csp, config } = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("X-Frame-Options")).toBe("DENY");
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(config.poweredByHeader).toBe(false);
  });

  it("Referrer-Policy is strict-origin-when-cross-origin or stricter", async () => {
    const { get } = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    expect(["strict-origin-when-cross-origin", "strict-origin", "same-origin", "no-referrer"]).toContain(get("Referrer-Policy"));
  });

  it("Permissions-Policy is present and switches off camera, microphone and geolocation", async () => {
    const { get } = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    const value = get("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation"]) expect(value).toContain(`${feature}=()`);
  });

  it("camera=() is right only while no code calls getUserMedia (job photos use <input type=file capture>)", () => {
    const roots = ["app", "components", "lib"];
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(name) && /getUserMedia|BarcodeDetector|navigator\.geolocation/.test(readFileSync(full, "utf8"))) users.push(full);
      }
    };
    for (const root of roots) walk(path.resolve(__dirname, "../..", root));
    // If this fails, a live camera/location feature was added: change Permissions-Policy to camera=(self) / geolocation=(self) on purpose.
    expect(users).toEqual([]);
    expect(readFileSync(path.resolve(__dirname, "../../components/job-photos.tsx"), "utf8")).toMatch(/type="file"[^>]*capture="environment"/);
  });

  it("CSP: default-src 'self', no unsafe-eval, object-src 'none', base-uri 'self', form-action 'self'", async () => {
    const { csp } = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
    expect(csp.get("worker-src")).toEqual(["'self'"]);
    expect(csp.get("manifest-src")).toEqual(["'self'"]);
    for (const [name, sources] of csp) expect(sources, `${name} must not allow 'unsafe-eval'`).not.toContain("'unsafe-eval'");
  });

  it("CSP: 'unsafe-inline' is the only weakness and does not grow (L10)", async () => {
    const { csp } = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    expect([...(csp.get("script-src") ?? [])].sort()).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]);
    expect([...(csp.get("style-src") ?? [])].sort()).toEqual(["'self'", "'unsafe-inline'"]);
    for (const [name, sources] of csp) {
      for (const source of sources) {
        expect(source, `${name} has a wildcard or scheme-wide source`).not.toMatch(/^(\*|https?:|http:\/\/\*|https:\/\/\*$)$/);
        if (name !== "img-src" && name !== "font-src") expect(source, `${name} allows data:/blob:`).not.toMatch(/^(data|blob):$/);
      }
    }
  });

  it("CSP: connect-src is the app itself and the configured Supabase project (https and wss) only", async () => {
    const { csp } = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    expect(csp.get("connect-src")).toEqual(["'self'", SUPABASE_URL, "wss://abcdefgh.supabase.co"]);
    expect(csp.get("img-src")).toEqual(["'self'", "data:", "blob:", SUPABASE_URL]);
  });

  it("CSP: with no Supabase URL configured it falls back to supabase.co only", async () => {
    const { csp } = await loadHeaders({ NODE_ENV: "production" });
    expect(csp.get("connect-src")).toEqual(["'self'", "https://*.supabase.co", "wss://*.supabase.co"]);
  });
});

describe("next.config.mjs security headers (development)", () => {
  it("unsafe-eval appears only outside production (React Refresh), and every other header is unchanged", async () => {
    const dev = await loadHeaders({ NODE_ENV: "development", supabaseUrl: SUPABASE_URL });
    const prod = await loadHeaders({ NODE_ENV: "production", supabaseUrl: SUPABASE_URL });
    expect(dev.csp.get("script-src")).toContain("'unsafe-eval'");
    expect(prod.csp.get("script-src")).not.toContain("'unsafe-eval'");
    for (const key of ["Strict-Transport-Security", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) expect(dev.get(key)).toBe(prod.get(key));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Cookies

type Attrs = { secure?: boolean; httpOnly?: boolean; sameSite?: string; path?: string; maxAge?: number };
const parseSetCookie = (header: string) => {
  const [pair, ...attrs] = header.split(";").map((part) => part.trim());
  const [name, ...value] = pair.split("=");
  const lower = attrs.map((attr) => attr.toLowerCase());
  const find = (key: string) => lower.find((attr) => attr.startsWith(`${key}=`))?.slice(key.length + 1);
  return {
    name,
    value: value.join("="),
    secure: lower.includes("secure"),
    httpOnly: lower.includes("httponly"),
    sameSite: find("samesite"),
    path: find("path"),
    maxAge: find("max-age") === undefined ? undefined : Number(find("max-age")),
  };
};

const hoisted = vi.hoisted(() => ({
  setAll: undefined as undefined | ((cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>) => void),
  user: { id: "u-1" } as { id: string } | null,
  profile: { role: "office", secondary_role: null, active: true, organization_id: "org-a", must_change_password: false } as Record<string, unknown>,
  store: { set: undefined as unknown as ReturnType<typeof import("vitest").vi.fn> },
}));

/** What @supabase/ssr hands setAll after a sign-in / refresh: the chunked token cookie with the library's defaults. */
const libraryCookies = () => [{ name: "sb-abcdefgh-auth-token", value: "base64-session", options: { ...DEFAULT_COOKIE_OPTIONS } }];

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: (...args: unknown[]) => hoisted.store.set(...args) }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/server/login", async (original) => {
  const real = await original<typeof import("@/lib/server/login")>();
  return { ...real, withinLimit: async () => true, recentHits: async () => 0, resolveLoginEmail: async () => "alice@example.test" };
});
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => null }));
vi.mock("@supabase/ssr", async (original) => {
  const real = await original<typeof import("@supabase/ssr")>();
  return {
    ...real,
    createServerClient: (_url: string, _key: string, options: { cookies: { setAll: NonNullable<typeof hoisted.setAll> } }) => {
      hoisted.setAll = options.cookies.setAll;
      return {
        auth: {
          signInWithPassword: async () => { options.cookies.setAll(libraryCookies()); return { data: { user: { id: "u-1" } }, error: null }; },
          // sign-out: the library clears the cookie (maxAge 0, empty value)
          signOut: async () => { options.cookies.setAll([{ name: "sb-abcdefgh-auth-token", value: "", options: { ...DEFAULT_COOKIE_OPTIONS, maxAge: 0 } }]); return { error: null }; },
          getUser: async () => { options.cookies.setAll(libraryCookies()); return { data: { user: hoisted.user }, error: null }; },
          mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" } }) },
        },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: hoisted.profile, error: null }) }) }) }),
        rpc: async () => ({ data: { user_id: "u-1", organization_id: "org-a", role: "office", secondary_role: null, hidden_sections: [] }, error: null }),
      };
    },
  };
});

describe("cookie attributes: the Supabase auth cookies written by the app's route handlers", () => {
  beforeEach(() => {
    hoisted.store.set = vi.fn();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  });

  const post = (url: string, body?: unknown) => new Request(`https://app.test${url}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "x-real-ip": "203.0.113.9" } });
  const setCalls = () => hoisted.store.set.mock.calls.map(([name, value, options]) => ({ name: name as string, value: value as string, options: options as Attrs }));

  it.each([
    ["signin", "@/app/api/auth/signin/route", () => post("/api/auth/signin", { identifier: "alice", password: "pw" })],
    ["signout", "@/app/api/auth/signout/route", () => post("/api/auth/signout")],
  ])("%s in production: Secure, Path=/, SameSite=Lax, 400 days (httpOnly false so the browser client can read the session)", async (_name, module, request) => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const { POST } = (await import(/* @vite-ignore */ module)) as { POST: (request: Request) => Promise<Response> };
    const response = await POST(request());
    expect(response.status).toBe(200);
    const calls = setCalls();
    // Sign-in also restarts the idle clock (tolra_last_active, the middleware's own HttpOnly cookie); every other cookie is Supabase's.
    const auth = calls.filter((call) => call.name !== "tolra_last_active");
    expect(auth.length).toBeGreaterThan(0);
    for (const call of auth) {
      expect(call.name).toMatch(/^sb-/);
      expect(call.options.secure).toBe(true);
      expect(call.options.path).toBe("/");
      expect(call.options.sameSite).toBe("lax");
      expect(call.options.httpOnly).toBe(false);
      expect([400 * DAY_S, 0]).toContain(call.options.maxAge);
    }
    for (const call of calls.filter((c) => c.name === "tolra_last_active")) {
      expect(call.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * DAY_S });
    }
  });

  it("outside production the Secure flag is off so http://localhost sign-in works (and only there)", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    const { POST } = await import("@/app/api/auth/signin/route");
    await POST(post("/api/auth/signin", { identifier: "alice", password: "pw" }));
    expect(setCalls().every((call) => call.options.secure === false)).toBe(true);
  });
});

describe("cookie attributes: tolra_brand (route handler)", () => {
  it("is httpOnly, Secure in production, SameSite=Lax, Path=/, one year; cleared with the same attributes", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const branding = await import("@/lib/server/branding");
    expect(branding.BRAND_COOKIE_MAX_AGE_S).toBe(365 * DAY_S);
    const source = readFileSync(path.resolve(__dirname, "../../app/api/branding/remember/route.ts"), "utf8");
    // Both the set and the clear must carry the full attribute set (drive-by edits that drop one are caught here).
    const calls = source.match(/response\.cookies\.set\([^\n]+\)/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatch(/httpOnly: true, secure: SECURE_COOKIES, sameSite: "lax", path: "\/"/);
    expect(calls[1]).toContain("maxAge: 0");
    expect(source).toContain('const SECURE_COOKIES = process.env.NODE_ENV === "production"');
  });
});

describe("cookie attributes: middleware", () => {
  const originalNow = Date.now;
  afterEach(() => { Date.now = originalNow; });

  async function run(url: string, cookies: string, user: { id: string } | null, profile?: Record<string, unknown>) {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    hoisted.user = user;
    if (profile) hoisted.profile = { ...hoisted.profile, ...profile };
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("@/middleware");
    const response = await middleware(new NextRequest(`https://app.test${url}`, { headers: { cookie: cookies } }));
    return response.headers.getSetCookie().map(parseSetCookie);
  }

  const find = (set: ReturnType<typeof parseSetCookie>[], name: string) => set.find((cookie) => cookie.name === name);

  it("tolra_last_active: httpOnly, Secure, SameSite=Lax, Path=/, 30 days; the refreshed auth cookie keeps Secure and Lax", async () => {
    const set = await run("/dashboard", "", { id: "u-1" });
    expect(find(set, "tolra_last_active")).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * DAY_S });
    expect(find(set, "sb-abcdefgh-auth-token")).toMatchObject({ httpOnly: false, secure: true, sameSite: "lax", path: "/", maxAge: 400 * DAY_S });
  });

  it("tolra_expired (idle sign-out): Secure, SameSite=Lax, Path=/, 5 minutes", async () => {
    Date.now = () => originalNow() + 400 * 24 * 3600 * 1000;
    const stale = String(originalNow());
    const set = await run("/dashboard", `tolra_last_active=${stale}`, { id: "u-1" });
    expect(find(set, "tolra_expired")).toMatchObject({ secure: true, sameSite: "lax", path: "/", maxAge: 5 * 60 });
  });

  it("access-ended mark for a disabled account: Secure, SameSite=Strict, Path=/, one year, readable by script (the tabs adopt it)", async () => {
    const set = await run("/dashboard", "", { id: "u-1" }, { active: false });
    expect(find(set, "tolra_offline_blocked_u-1")).toMatchObject({ httpOnly: false, secure: true, sameSite: "strict", path: "/", maxAge: 365 * DAY_S });
  });
});

describe("cookie attributes: client-set marks (document.cookie)", () => {
  it("the offline access mark and its clearing use Path=/ and SameSite=Strict; a lock only ever suspends", async () => {
    vi.resetModules();
    const written: string[] = [];
    vi.stubGlobal("document", { get cookie() { return ""; }, set cookie(text: string) { written.push(text); } });
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, dispatchEvent: () => true });
    try {
      const { blockOfflineAccess, confirmOfflineAccess } = await import("@/lib/offline/access");
      blockOfflineAccess("u-9");
      confirmOfflineAccess("u-9");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(written).toHaveLength(2);
    for (const text of written) {
      const parsed = parseSetCookie(text);
      expect(parsed.path).toBe("/");
      expect(parsed.sameSite).toBe("strict");
      expect(parsed.httpOnly).toBe(false);
    }
    expect(parseSetCookie(written[0]).maxAge).toBe(365 * DAY_S);
    expect(parseSetCookie(written[1]).maxAge).toBe(0);
  });
});
