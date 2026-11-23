/**
 * The owner-only Roadmap and Rollouts routes (/api/platform/roadmap, /api/platform/rollouts). The real routes, requirePlatformOwner and the input checks
 * run against a fake of the caller's session and of the service role. Proves: both routes are 404 unless their own server flag is exactly "true", before
 * anything else runs; non-owners and password-only sessions are refused before any roadmap or rollout call; the roadmap calls only the owner's own
 * session (the service role is never used for it); a bad body is refused before the database; a rollout of an unlisted switch is refused before the
 * database; turning ON needs a code under 15 minutes old and sends nothing without it; turning OFF needs no fresh code; the service role is used for
 * exactly one apply call that names the verified user as the actor; database refusals get fixed wording; no database message reaches the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "44444444-4444-4444-8444-444444444444";
const now = () => Math.floor(Date.now() / 1000);

const state = {
  signedIn: true, owner: true, level: "aal2", amr: [] as unknown[],
  rpcError: null as null | { code: string; message: string; hint?: string },
  adminError: null as null | { code: string; message: string; hint?: string },
  calls: [] as Array<{ fn: string; args: unknown }>,
  adminCalls: [] as Array<{ fn: string; args: unknown }>,
};

const caller = {
  auth: {
    getUser: async () => ({ data: { user: state.signedIn ? { id: "u1", email: "owner@example.test" } : null }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.level, currentAuthenticationMethods: state.amr }, error: null }) },
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { active: true, must_change_password: false }, error: null }) }) }) }),
  rpc: async (fn: string, args?: unknown) => {
    state.calls.push({ fn, args });
    if (fn === "is_platform_admin") return { data: state.owner, error: null };
    if (fn === "platform_list_organizations") return { data: [{ organization_id: ORG, name: "JNR", slug: "jnr", status: "active" }], error: null };
    if (state.rpcError) return { data: null, error: state.rpcError };
    if (fn === "platform_roadmap_list") return { data: [{ id: ORG, title: "T", description: "", status: "idea", sort_order: 1, target_kind: "all", target_orgs: [], created_at: "2026-11-01T00:00:00Z", shipped_at: null }], error: null };
    if (fn === "platform_roadmap_save" || fn === "platform_roadmap_move") return { data: { id: ORG }, error: null };
    if (fn === "platform_rollout_overview") return { data: { companies: [{ organization_id: ORG, name: "JNR", slug: "jnr", status: "active", on: ["reports:on"] }], log: [] }, error: null };
    return { data: null, error: null };
  },
};
const admin = {
  rpc: async (fn: string, args?: unknown) => {
    state.adminCalls.push({ fn, args });
    if (state.adminError) return { data: null, error: state.adminError };
    return { data: { log_id: ORG, switch: "reports:on", turned_on: true, requested: 1, changed: 1, changed_org_ids: [ORG] }, error: null };
  },
};

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/auth", async (original) => {
  const real = await original<typeof import("@/lib/server/auth")>();
  return { ...real, createSupabaseServerClient: async () => caller };
});

const roadmap = await import("@/app/api/platform/roadmap/route");
const rollouts = await import("@/app/api/platform/rollouts/route");

const FRESH = () => [{ method: "password", timestamp: now() - 120 }, { method: "totp", timestamp: now() - 60 }];
const STALE = () => [{ method: "password", timestamp: now() - 3600 }, { method: "totp", timestamp: now() - 16 * 60 }];
const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const req = (url: string, method: string, body?: unknown) => new Request(`http://localhost${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const dbCalls = (prefix: string) => state.calls.filter((c) => c.fn.startsWith(prefix));
const applyBody = { switchMarker: "reports:on", organizationIds: [ORG], on: true, phase: "Phase 1" };

beforeEach(() => {
  Object.assign(state, { signedIn: true, owner: true, level: "aal2", amr: FRESH(), rpcError: null, adminError: null, calls: [], adminCalls: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("flags", () => {
  it("both routes are 404 when their flag is off, before any session or database call", async () => {
    for (const res of [await roadmap.GET(req("/api/platform/roadmap", "GET")), await roadmap.POST(req("/api/platform/roadmap", "POST", {})), await rollouts.GET(req("/api/platform/rollouts", "GET")), await rollouts.POST(req("/api/platform/rollouts", "POST", applyBody))]) expect(res.status).toBe(404);
    expect(state.calls).toEqual([]);
    expect(state.adminCalls).toEqual([]);
  });
  it("one flag does not switch on the other screen", async () => {
    vi.stubEnv("PLATFORM_ROADMAP_ENABLED", "true");
    expect((await rollouts.GET(req("/api/platform/rollouts", "GET"))).status).toBe(404);
    vi.stubEnv("PLATFORM_ROADMAP_ENABLED", "");
    vi.stubEnv("PLATFORM_ROLLOUTS_ENABLED", "true");
    expect((await roadmap.GET(req("/api/platform/roadmap", "GET"))).status).toBe(404);
  });
});

describe("roadmap route", () => {
  beforeEach(() => vi.stubEnv("PLATFORM_ROADMAP_ENABLED", "true"));
  it("refuses a non-owner and a password-only session before any roadmap call", async () => {
    state.owner = false;
    expect((await roadmap.GET(req("/api/platform/roadmap", "GET"))).status).toBe(403);
    state.owner = true; state.level = "aal1";
    expect((await roadmap.POST(req("/api/platform/roadmap", "POST", { action: "move", id: ORG, direction: "up" }))).status).toBe(403);
    state.signedIn = false;
    expect((await roadmap.GET(req("/api/platform/roadmap", "GET"))).status).toBe(401);
    expect(dbCalls("platform_roadmap")).toEqual([]);
  });
  it("lists the items with the company names, through the owner's own session only", async () => {
    const res = await roadmap.GET(req("/api/platform/roadmap", "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.companies).toEqual([{ organizationId: ORG, name: "JNR" }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.adminCalls).toEqual([]);
  });
  it("refuses a bad body before the database", async () => {
    const res = await roadmap.POST(req("/api/platform/roadmap", "POST", { action: "save", title: "", status: "idea", targetKind: "all", targetOrgIds: [] }));
    expect(res.status).toBe(400);
    expect(dbCalls("platform_roadmap")).toEqual([]);
  });
  it("saves and moves with one call each, as the owner, and never uses the service role", async () => {
    const save = await roadmap.POST(req("/api/platform/roadmap", "POST", { action: "save", title: "New", description: "d", status: "building", targetKind: "one", targetOrgIds: [ORG] }));
    expect(save.status).toBe(200);
    expect(dbCalls("platform_roadmap_save")).toEqual([{ fn: "platform_roadmap_save", args: { p_id: null, p_title: "New", p_description: "d", p_status: "building", p_target_kind: "one", p_target_orgs: [ORG] } }]);
    const move = await roadmap.POST(req("/api/platform/roadmap", "POST", { action: "move", id: ORG, direction: "down" }));
    expect(move.status).toBe(200);
    expect(dbCalls("platform_roadmap_move")).toEqual([{ fn: "platform_roadmap_move", args: { p_id: ORG, p_direction: "down" } }]);
    expect(state.adminCalls).toEqual([]);
  });
  it("gives fixed wording for a database refusal and never its message", async () => {
    state.rpcError = { code: "P0002", message: "SECRET detail", hint: "item_not_found" };
    const res = await roadmap.POST(req("/api/platform/roadmap", "POST", { action: "move", id: ORG, direction: "up" }));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET");
  });
});

describe("rollouts route", () => {
  beforeEach(() => vi.stubEnv("PLATFORM_ROLLOUTS_ENABLED", "true"));
  it("refuses a non-owner and a password-only session before any rollout call", async () => {
    state.owner = false;
    expect((await rollouts.GET(req("/api/platform/rollouts", "GET"))).status).toBe(403);
    expect((await rollouts.POST(req("/api/platform/rollouts", "POST", applyBody))).status).toBe(403);
    state.owner = true; state.level = "aal1";
    expect((await rollouts.POST(req("/api/platform/rollouts", "POST", applyBody))).status).toBe(403);
    expect(dbCalls("platform_rollout")).toEqual([]);
    expect(state.adminCalls).toEqual([]);
  });
  it("shows the overview through the owner's own session", async () => {
    const res = await rollouts.GET(req("/api/platform/rollouts", "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).companies[0]).toMatchObject({ organizationId: ORG, on: ["reports:on"] });
    expect(state.adminCalls).toEqual([]);
  });
  it("refuses an unlisted switch and a bad body before the database", async () => {
    expect((await rollouts.POST(req("/api/platform/rollouts", "POST", { ...applyBody, switchMarker: "sales-orders:on" }))).status).toBe(400);
    expect((await rollouts.POST(req("/api/platform/rollouts", "POST", { ...applyBody, organizationIds: [] }))).status).toBe(400);
    expect((await rollouts.POST(req("/api/platform/rollouts", "POST", { ...applyBody, actor: "someone-else" }))).status).toBe(400);
    expect(state.adminCalls).toEqual([]);
  });
  it("turning ON needs a fresh code: a stale or missing one is refused with the code the browser acts on, and nothing is sent", async () => {
    for (const amr of [STALE(), []]) {
      state.amr = amr;
      const res = await rollouts.POST(req("/api/platform/rollouts", "POST", applyBody));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("mfa_recent_required");
    }
    expect(state.adminCalls).toEqual([]);
  });
  it("turning ON with a fresh code makes exactly one apply call, naming the verified user, and answers with counts", async () => {
    const res = await rollouts.POST(req("/api/platform/rollouts", "POST", applyBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, logId: ORG, switchMarker: "reports:on", turnedOn: true, requested: 1, changed: 1 });
    expect(state.adminCalls).toEqual([{ fn: "platform_rollout_apply", args: { p_actor: "u1", p_actor_email: "owner@example.test", p_switch: "reports:on", p_orgs: [ORG], p_on: true, p_phase: "Phase 1" } }]);
  });
  it("turning OFF needs no fresh code, so the safe direction is always one click", async () => {
    state.amr = STALE();
    const res = await rollouts.POST(req("/api/platform/rollouts", "POST", { ...applyBody, on: false }));
    expect(res.status).toBe(200);
    expect(state.adminCalls).toHaveLength(1);
    expect((state.adminCalls[0].args as { p_on: boolean }).p_on).toBe(false);
  });
  it("gives fixed wording for a database refusal and never its message", async () => {
    state.adminError = { code: "22023", message: "SECRET detail", hint: "company_not_active" };
    const res = await rollouts.POST(req("/api/platform/rollouts", "POST", applyBody));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET");
    state.adminError = { code: "XX000", message: "SECRET detail" };
    const other = await rollouts.POST(req("/api/platform/rollouts", "POST", applyBody));
    expect(other.status).toBe(500);
    expect(JSON.stringify(await other.json())).not.toContain("SECRET");
  });
});
