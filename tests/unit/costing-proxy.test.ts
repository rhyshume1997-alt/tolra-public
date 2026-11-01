/**
 * A8 costing engine: the repo-side half of the "trusted-caller + tenant-isolation proof" (ChatGPT's condition for activating the
 * engine). The engine itself (Python service behind COSTING_ENGINE_URL) is services/costing-engine; this file proves what the APP
 * guarantees to it. What the ENGINE must prove (E1 to E5 below) is proved by services/costing-engine/tests/trusted_caller_proof.py
 * against the real engine and PostgreSQL (CI job costing-engine). The comment block below travels with the code.
 *
 * WHAT THIS FILE PROVES (app side, run by `npx vitest run tests/unit/costing-proxy.test.ts`)
 *   1. Only a signed-in admin/office session of an active company reaches the engine: no session 401, workshop / inactive 403, a support
 *      (platform admin) session needs aal2. Nothing is fetched on any refusal.
 *   2. Only four engine routes exist for the app (GET parts, materials, machines; POST quotes/calculate-detailed). Anything else, any
 *      other method on a listed route, a different case, a trailing slash, an extra segment, a traversal: 404 and never forwarded.
 *      Only GET and POST handlers are exported.
 *   3. X-Org-Id is ALWAYS the organisation of the caller's signed-in session (the database's answer, not the profile row's copy, not a
 *      request header, not a query string, not the body). A forged X-Org-Id / X-Organization-Id header, ?org_id=, and a body
 *      organization_id are all ignored; the body is rebuilt from a schema so unknown fields never reach the engine.
 *   4. The shared COSTING_ENGINE_TOKEN is read from the server environment only, sent only as the outbound Authorization header
 *      (a client-supplied Authorization / Cookie is never relayed), and never appears in a response, an error answer or a log line;
 *      neither does the engine URL. Upstream error text is never relayed (fixed messages by status).
 *   5. POST body: 10 KB limit (declared and actual), JSON and schema validated, cross-site POST refused before the sign-in check.
 *   6. The server-side caller used by the AI helper Approve route (lib/server/costing-engine.ts) sends the same three things (token,
 *      X-Org-Id = the organisation it was given, fixed routes) and leaks nothing in its errors.
 *   7. No browser bundle can read the token or URL: no 'use client' file, nor anything it imports, mentions COSTING_ENGINE_*, and the
 *      only files that do are the three server files listed (static check, no network).
 *
 * WHAT THE ENGINE (services/costing-engine, Python) MUST SHOW BEFORE IT IS ACTIVATED (services/costing-engine/tests/trusted_caller_proof.py;
 * attach its output to the go-live gate):
 *   E1. Token-only trust: every /api/* route returns 401 without `Authorization: Bearer <COSTING_ENGINE_TOKEN>` and with a wrong or
 *       empty token (constant-time compare, e.g. hmac.compare_digest); it fails closed (refuses to start, or 503) when the token is
 *       unset or empty; /docs, /openapi.json and /redoc are off or behind the token in production; no endpoint is open to the internet
 *       without the token (network allow-list to the app's egress if the host supports it).
 *   E2. Organisation id ONLY from X-Org-Id: a request without it (or with a non-UUID) is 400; it is never read from the body, the query
 *       string, a cookie or another header; every query filters by it (or runs under a per-request scoped session / RLS), including
 *       joins, aggregates, lookups by id and writes.
 *   E3. Two-company isolation test: seed company A and company B with overlapping part ids and numbers; as A, GET /parts, /materials,
 *       /machines return only A's rows; POST calculate-detailed with B's part_id returns 404 (not a price, not B's data); B likewise;
 *       a part id that exists only in B is indistinguishable from one that does not exist; response bodies and error text contain none of
 *       B's names, rates or ids. Run it against the real database, not mocks.
 *   E4. No cross-organisation cache: any in-process / Redis / lru_cache / HTTP cache of parts, rates or results is keyed by the
 *       organisation id (or absent); show a test where A's cached result is not returned to B for the same part id and quantity; the
 *       responses carry no shared Cache-Control that a CDN could reuse across companies.
 *   E5. Dependencies and logs: `pip-audit` (or `pip-audit -r requirements.txt --strict`) clean or each finding triaged; the token and
 *       X-Org-Id values are not written to logs in full; error responses carry no stack trace, SQL or connection string.
 *
 * App-side facts the engine proof can rely on: the app never forwards the browser's query string, cookies or headers, only
 * Accept, Authorization, X-Org-Id (and Content-Type on POST); org ids come from Supabase's `my_session` / `current_user_organization_id`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

let who: { role: string; active: boolean };
let level: "aal1" | "aal2";
let support: boolean;
let signedIn: boolean;
let sessionOrg: string;
let currentOrgOverride: string | null;
const PROFILE_ROW_ORG = "org-profile-row-copy";

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
    from: () => chain({ id: "user-1", email: "a@example.test", full_name: "A", role: who.role, secondary_role: null, organization_id: PROFILE_ROW_ORG, active: true, must_change_password: false }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "current_user_organization_id") return { data: currentOrgOverride ?? sessionOrg, error: null };
      if (name === "my_session") {
        return { data: { user_id: "user-1", organization_id: sessionOrg, role: who.role, support, read_only: false, platform_admin: support }, error: null };
      }
      if (name === "has_org_role") return { data: who.active && ((args.allowed_roles as string[]) ?? []).includes(who.role), error: null };
      return { data: null, error: null };
    },
  }),
}));

import * as proxy from "@/app/api/costing/[...path]/route";
import { GET as statusGET } from "@/app/api/costing/status/route";
import { serverCostingDeps } from "@/lib/server/costing-engine";

const ENGINE_URL = "https://engine.internal.example/";
const TOKEN = "tok_SECRET_value_9f3a1c";
const ENV = ["COSTING_ENGINE_URL", "COSTING_ENGINE_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "REQUIRE_ADMIN_MFA"];
const saved: Record<string, string | undefined> = {};

const fetchMock = vi.fn();
let logged: string[];

const ok = (payload: unknown = []) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
const params = (p: string[]) => ({ params: Promise.resolve({ path: p }) });
const url = (p: string, query = "") => `https://app.test/api/costing/${p}${query}`;
const get = (p: string[], init: RequestInit = {}, query = "") => proxy.GET(new Request(url(p.join("/"), query), { method: "GET", ...init }), params(p));
const post = (p: string[], body: unknown, init: RequestInit = {}) =>
  proxy.POST(new Request(url(p.join("/")), { method: "POST", headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) }, body: typeof body === "string" ? body : JSON.stringify(body) }), params(p));
const CALC = ["quotes", "calculate-detailed"];
const goodBody = { part_id: 7, quantity: 10, margin_pct: 0.2 };

function sentHeaders(call = 0): Record<string, string> {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return Object.fromEntries(Object.entries(init.headers as Record<string, string>));
}
const sentUrl = (call = 0) => String(fetchMock.mock.calls[call][0]);
const sentBody = (call = 0) => (fetchMock.mock.calls[call][1] as RequestInit).body as string | undefined;

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.COSTING_ENGINE_URL = ENGINE_URL;
  process.env.COSTING_ENGINE_TOKEN = TOKEN;
  who = { role: "office", active: true };
  level = "aal1";
  support = false;
  signedIn = true;
  sessionOrg = "org-session";
  currentOrgOverride = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ok([{ id: 1 }]));
  vi.stubGlobal("fetch", fetchMock);
  logged = [];
  const capture = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")); };
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "log").mockImplementation(capture);
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Nothing the app says or logs may contain the token, the engine host, or the engine URL. */
async function expectNoLeak(response: Response) {
  const text = await response.clone().text();
  const heads = JSON.stringify([...response.headers.entries()]);
  for (const hay of [text, heads, logged.join("\n")]) {
    expect(hay).not.toContain(TOKEN);
    expect(hay).not.toContain("engine.internal.example");
    expect(hay).not.toContain("Bearer");
  }
}

describe("who may reach the engine", () => {
  it("no session: 401, nothing fetched", async () => {
    signedIn = false;
    const r = await get(["parts"]);
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["workshop", "viewer", "driver"])("%s: 403, nothing fetched (GET and POST)", async (role) => {
    who = { role, active: true };
    expect((await get(["parts"])).status).toBe(403);
    expect((await post(CALC, goodBody)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an office user whose membership is no longer active: 403", async () => {
    who = { role: "office", active: false };
    expect((await get(["parts"])).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["admin", "office"])("%s: allowed", async (role) => {
    who = { role, active: true };
    expect((await get(["parts"])).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a support (platform admin) session without aal2: 403 mfa_required, nothing fetched", async () => {
    support = true;
    const r = await get(["parts"]);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: "mfa_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a support session at aal2 is the visited company's session: it reaches the engine with THAT company's id only", async () => {
    support = true;
    level = "aal2";
    sessionOrg = "org-visited-by-support";
    expect((await get(["parts"])).status).toBe(200);
    expect(sentHeaders()["X-Org-Id"]).toBe("org-visited-by-support");
  });

  it("the status route: 401 / 403 as above, and it never reveals the token or URL", async () => {
    signedIn = false;
    expect((await statusGET()).status).toBe(401);
    signedIn = true;
    who = { role: "workshop", active: true };
    expect((await statusGET()).status).toBe(403);
    who = { role: "office", active: true };
    const r = await statusGET();
    expect(r.status).toBe(200);
    expect(await r.clone().json()).toEqual({ configured: true });
    await expectNoLeak(r);
    delete process.env.COSTING_ENGINE_TOKEN;
    expect(await (await statusGET()).json()).toEqual({ configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("route and method allowlist", () => {
  it("only GET and POST handlers are exported", () => {
    const handlers = Object.keys(proxy).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k)).sort();
    expect(handlers).toEqual(["GET", "POST"]);
  });

  it.each([
    [["parts"]], [["materials"]], [["machines"]],
  ])("listed GET %j is forwarded to /api/<route> with no query string", async (p) => {
    const r = await get(p, {}, "?org_id=org-evil&x=1");
    expect(r.status).toBe(200);
    expect(sentUrl()).toBe(`https://engine.internal.example/api/${p.join("/")}`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it.each([
    [["health"]], [["docs"]], [["openapi.json"]], [["admin"]], [["admin", "users"]], [["quotes"]], [["quotes", "calculate"]],
    [["parts", "1"]], [["parts", ""]], [["parts", ".."]], [["parts", "..", "admin"]], [["..", "admin"]], [["Parts"]], [["PARTS"]], [["parts%2F..%2Fadmin"]],
    [["materials", "1", "prices"]], [["machines", "export"]], [[]], [[""]], [["quotes", "calculate-detailed", "x"]],
    [["constructor"]], [["__proto__"]], [["toString"]], [["hasOwnProperty"]], [["parts?org_id=x"]], [["parts#x"]], [["parts "]], [["//evil.example", "parts"]],
  ])("unlisted engine route %j: 404 and never forwarded (GET)", async (p) => {
    const r = await get(p);
    expect(r.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectNoLeak(r);
  });

  it("an unlisted route is refused for POST too, and the body is not even read into a request", async () => {
    for (const p of [["parts", "1"], ["admin"], ["machines", "1"], ["quotes", "calculate"], ["health"]]) {
      expect((await post(p, goodBody)).status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the wrong method on a listed route is 404: POST to a read route, GET to the calculate route", async () => {
    expect((await post(["parts"], goodBody)).status).toBe(404);
    expect((await post(["materials"], goodBody)).status).toBe(404);
    expect((await post(["machines"], goodBody)).status).toBe(404);
    expect((await get(CALC)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an engine URL with a trailing slash does not produce //api", async () => {
    await get(["parts"]);
    expect(sentUrl()).not.toContain("//api");
  });
});

describe("tenant: X-Org-Id is always the session's company", () => {
  it("GET: the header is the session's organisation, not the profile row's copy", async () => {
    await get(["machines"]);
    const h = sentHeaders();
    expect(h["X-Org-Id"]).toBe("org-session");
    expect(h["X-Org-Id"]).not.toBe(PROFILE_ROW_ORG);
  });

  it("GET: a forged X-Org-Id / X-Organization-Id / X-Forwarded-* header and ?org_id= / ?organization_id= are ignored", async () => {
    await get(["parts"], { headers: { "X-Org-Id": "org-victim", "x-organization-id": "org-victim", "x-forwarded-for": "9.9.9.9", "x-org": "org-victim" } }, "?org_id=org-victim&organization_id=org-victim&X-Org-Id=org-victim");
    const h = sentHeaders();
    expect(h["X-Org-Id"]).toBe("org-session");
    expect(Object.keys(h).filter((k) => /org/i.test(k))).toEqual(["X-Org-Id"]);
    expect(sentUrl()).not.toContain("org-victim");
  });

  it("POST: a forged X-Org-Id header and a body organization_id / org_id / X-Org-Id are ignored, and the body never carries them on", async () => {
    const r = await post(CALC, { ...goodBody, organization_id: "org-victim", org_id: "org-victim", "X-Org-Id": "org-victim", organizationId: "org-victim" }, { headers: { "X-Org-Id": "org-victim", "x-organization-id": "org-victim" } });
    expect(r.status).toBe(200);
    const h = sentHeaders();
    expect(h["X-Org-Id"]).toBe("org-session");
    expect(Object.keys(h).filter((k) => /org/i.test(k))).toEqual(["X-Org-Id"]);
    expect(sentBody()).toBe(JSON.stringify(goodBody));
    expect(sentBody()).not.toContain("org-victim");
  });

  it("two companies in a row: each call carries its own session's id (no value is kept between calls)", async () => {
    sessionOrg = "org-A";
    await get(["parts"]);
    sessionOrg = "org-B";
    await get(["parts"]);
    expect(sentHeaders(0)["X-Org-Id"]).toBe("org-A");
    expect(sentHeaders(1)["X-Org-Id"]).toBe("org-B");
  });

  it("the database naming a different current company than the session record: refused (403), nothing fetched", async () => {
    currentOrgOverride = "org-other";
    expect((await get(["parts"])).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("token: server only, never echoed", () => {
  it("is sent only as the outbound Authorization header; a client Authorization / Cookie / API-key is never relayed", async () => {
    await post(CALC, goodBody, { headers: { authorization: "Bearer client-supplied", cookie: "sb-access-token=abc", "x-api-key": "client-key", "x-forwarded-host": "evil.example" } });
    const h = sentHeaders();
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(h).sort()).toEqual(["Accept", "Authorization", "Content-Type", "X-Org-Id"]);
    expect(JSON.stringify(h)).not.toContain("client-supplied");
    expect(JSON.stringify(h)).not.toContain("sb-access-token");
  });

  it("GET forwards only Accept, Authorization and X-Org-Id", async () => {
    await get(["parts"], { headers: { cookie: "sb=1", "x-api-key": "k" } });
    expect(Object.keys(sentHeaders()).sort()).toEqual(["Accept", "Authorization", "X-Org-Id"]);
  });

  it("a successful answer carries the engine's payload and no-store, and no token, URL or auth header", async () => {
    const r = await get(["parts"]);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.clone().json()).toEqual([{ id: 1 }]);
    await expectNoLeak(r);
  });

  it.each([400, 401, 403, 404, 422, 429, 500, 502, 503])("an engine %i whose body echoes the token and URL: a fixed message, nothing leaked", async (status) => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ detail: `bad token ${TOKEN} at ${ENGINE_URL} Authorization: Bearer ${TOKEN}`, trace: "File engine.internal.example/app.py" }), { status }));
    const r = await get(["parts"]);
    expect(r.status).toBe({ 400: 400, 422: 400, 404: 404, 429: 429 }[status] ?? 502);
    const body = await r.clone().json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(["Invalid request", "Not found", "Too many requests", "Costing engine unavailable"]).toContain(body.error);
    await expectNoLeak(r);
  });

  it("a network failure whose message names the token and URL: 502 fixed message, nothing leaked or logged", async () => {
    fetchMock.mockImplementation(async () => { throw new Error(`connect ECONNREFUSED ${ENGINE_URL} with Bearer ${TOKEN}`); });
    const r = await post(CALC, goodBody);
    expect(r.status).toBe(502);
    expect(await r.clone().json()).toEqual({ error: "Costing engine unavailable" });
    await expectNoLeak(r);
  });

  it("an engine answer that is not JSON: 502, nothing leaked", async () => {
    fetchMock.mockImplementation(async () => new Response(`<html>${TOKEN} ${ENGINE_URL}</html>`, { status: 200 }));
    const r = await get(["parts"]);
    expect(r.status).toBe(502);
    await expectNoLeak(r);
  });

  it("not configured (either value missing): 503 fixed message, nothing fetched", async () => {
    for (const k of ["COSTING_ENGINE_URL", "COSTING_ENGINE_TOKEN"]) {
      const was = process.env[k];
      delete process.env[k];
      const r = await get(["parts"]);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "Costing engine not configured" });
      process.env[k] = was;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST body", () => {
  it("a valid body is rebuilt from the schema (margin defaults to 0.15) and forwarded as JSON", async () => {
    await post(CALC, { part_id: 3, quantity: 5 });
    expect(JSON.parse(sentBody() as string)).toEqual({ part_id: 3, quantity: 5, margin_pct: 0.15 });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("over 10 KB: 413, declared by Content-Length or not, nothing fetched", async () => {
    const big = JSON.stringify({ ...goodBody, pad: "x".repeat(11 * 1024) });
    expect((await post(CALC, big)).status).toBe(413);
    expect((await post(CALC, goodBody, { headers: { "content-length": "20000" } })).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{nope"], ["array", "[]"], ["null", "null"], ["empty", ""],
    ["string part id", { part_id: "7", quantity: 1 }], ["zero quantity", { part_id: 7, quantity: 0 }], ["fractional quantity", { part_id: 7, quantity: 1.5 }],
    ["huge quantity", { part_id: 7, quantity: 1_000_001 }], ["negative part", { part_id: -1, quantity: 1 }], ["margin over 5", { part_id: 7, quantity: 1, margin_pct: 6 }],
    ["negative margin", { part_id: 7, quantity: 1, margin_pct: -0.1 }],
  ])("invalid body (%s): 400, nothing fetched", async (_n, body) => {
    expect((await post(CALC, body as string | object)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a cross-site or foreign-origin POST is refused (403) before the sign-in check, nothing fetched", async () => {
    signedIn = false;
    const cross = await proxy.POST(new Request(url("quotes/calculate-detailed"), { method: "POST", headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: JSON.stringify(goodBody) }), params(CALC));
    expect(cross.status).toBe(403);
    const foreign = await proxy.POST(new Request(url("quotes/calculate-detailed"), { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify(goodBody) }), params(CALC));
    expect(foreign.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("serverCostingDeps (the AI helper Approve route's own caller)", () => {
  const engine = vi.fn();
  beforeEach(() => { engine.mockReset(); engine.mockImplementation(async () => ok([])); });

  it("sends the token and the organisation it was given, to the fixed routes only", async () => {
    const deps = serverCostingDeps("org-given", engine as unknown as typeof fetch);
    await deps.parts();
    await deps.calculate(4, 2, 0.2);
    expect(engine.mock.calls[0][0]).toBe("https://engine.internal.example/api/parts");
    expect(engine.mock.calls[1][0]).toBe("https://engine.internal.example/api/quotes/calculate-detailed");
    for (const [, init] of engine.mock.calls as Array<[string, RequestInit]>) {
      const h = init.headers as Record<string, string>;
      expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(h["X-Org-Id"]).toBe("org-given");
    }
    expect(JSON.parse((engine.mock.calls[1][1] as RequestInit).body as string)).toEqual({ part_id: 4, quantity: 2, margin_pct: 0.2 });
  });

  it("an engine error and a missing configuration give messages without the token or URL", async () => {
    engine.mockImplementation(async () => new Response(`${TOKEN} ${ENGINE_URL}`, { status: 500 }));
    const deps = serverCostingDeps("org-given", engine as unknown as typeof fetch);
    const err = await deps.parts().catch((e: Error) => e);
    expect((err as Error).message).toBe("Costing engine status 500");
    delete process.env.COSTING_ENGINE_TOKEN;
    const off = serverCostingDeps("org-given", engine as unknown as typeof fetch);
    expect(await off.configured()).toBe(false);
    const err2 = await off.parts().catch((e: Error) => e);
    expect((err2 as Error).message).toBe("Costing engine not configured");
    expect(engine).toHaveBeenCalledTimes(1);
  });
});

// ---- No browser bundle can read the token or URL ------------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "tests", "supabase", "public"]);
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((e) => base + e), ...["index.ts", "index.tsx"].map((i) => path.join(base, i))]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
/** Value imports only: `import type ...` is erased by the compiler and puts nothing in the bundle. */
function valueImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    if (/^\s*(import|export)\s+type\b/.test(m[0])) continue;
    out.push((m[1] ?? m[2]) as string);
  }
  return out;
}
/** True when the name appears in CODE (an identifier or a string/template literal), not in a comment. */
function codeMentions(source: string, needle: RegExp): boolean {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (needle.test(n.text)) { found = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
const isClientFile = (source: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(source);

describe("no client bundle reads COSTING_ENGINE_TOKEN / COSTING_ENGINE_URL", () => {
  const files = ["app", "components", "lib", "hooks", "utils", "src"].map((d) => path.join(ROOT, d)).filter(existsSync).flatMap((d) => walk(d));
  const rootFiles = readdirSync(ROOT).filter((f) => /^(middleware|proxy|instrumentation)\.(ts|js)$/.test(f)).map((f) => path.join(ROOT, f));
  const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

  it("scans a real set of files and finds the 'use client' ones (the scanner is not vacuous)", () => {
    const clients = files.filter((f) => isClientFile(readFileSync(f, "utf8")));
    expect(files.length).toBeGreaterThan(100);
    expect(clients.length).toBeGreaterThan(20);
    expect(rel(path.join(ROOT, "lib/costing.ts"))).toBe("lib/costing.ts");
    expect(isClientFile(readFileSync(path.join(ROOT, "lib/costing.ts"), "utf8"))).toBe(true);
  });

  it("the only files that mention COSTING_ENGINE_* are the proxy, the status route and the server caller", () => {
    const mentioning = [...files, ...rootFiles].filter((f) => codeMentions(readFileSync(f, "utf8"), /COSTING_ENGINE/)).map(rel).sort();
    expect(mentioning).toEqual(["app/api/costing/[...path]/route.ts", "app/api/costing/status/route.ts", "lib/server/costing-engine.ts"]);
  });

  it("nothing is exposed to the browser by name: no NEXT_PUBLIC_COSTING*, and no `env` block in the Next config naming it", () => {
    for (const f of [...files, ...rootFiles]) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/NEXT_PUBLIC_COSTING/);
    for (const name of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
      const p = path.join(ROOT, name);
      if (existsSync(p)) expect(readFileSync(p, "utf8")).not.toMatch(/COSTING/);
    }
  });

  it("every file reachable from a 'use client' file by value imports is free of COSTING_ENGINE_* and does not import a server-only module", () => {
    const sources = new Map<string, string>();
    const src = (f: string) => { if (!sources.has(f)) sources.set(f, readFileSync(f, "utf8")); return sources.get(f) as string; };
    const roots = files.filter((f) => isClientFile(src(f)));
    const seen = new Set<string>();
    const stack = [...roots];
    const reachedFrom = new Map<string, string>();
    while (stack.length) {
      const f = stack.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of valueImports(src(f))) {
        const target = resolveImport(f, spec);
        if (target && !seen.has(target)) { reachedFrom.set(target, f); stack.push(target); }
      }
    }
    expect(seen.size).toBeGreaterThan(roots.length);
    const bad: string[] = [];
    for (const f of seen) {
      const s = src(f);
      if (codeMentions(s, /COSTING_ENGINE/)) bad.push(`${rel(f)} mentions COSTING_ENGINE (reached from ${rel(reachedFrom.get(f) ?? f)})`);
      if (/["']server-only["']/.test(s)) bad.push(`${rel(f)} is server-only but reachable from the browser (via ${rel(reachedFrom.get(f) ?? f)})`);
      for (const spec of valueImports(s)) {
        if (spec === "@/lib/server/costing-engine" || /lib\/server\/costing-engine$/.test(spec)) bad.push(`${rel(f)} imports the server costing caller`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the scanner would catch a leak: a synthetic client file importing the server caller is flagged", () => {
    const synthetic = `"use client";\nimport { serverCostingDeps } from "@/lib/server/costing-engine";\nconst t = process.env.COSTING_ENGINE_TOKEN;\n`;
    expect(isClientFile(synthetic)).toBe(true);
    expect(valueImports(synthetic)).toContain("@/lib/server/costing-engine");
    expect(codeMentions(synthetic, /COSTING_ENGINE/)).toBe(true);
    expect(codeMentions(`"use client";\n// reads COSTING_ENGINE_URL on the server\nconst a = 1;`, /COSTING_ENGINE/)).toBe(false);
    expect(valueImports(`import type { X } from "@/lib/server/costing-engine";`)).toEqual([]);
  });
});
