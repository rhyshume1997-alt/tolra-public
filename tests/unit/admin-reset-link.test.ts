/**
 * Admin > Users, "Send password reset e-mail". The REAL guard runs (admin only, same origin, no support session, aal2 whatever
 * REQUIRE_ADMIN_MFA says); Auth, the limiter and the caller's database are fakes. The reset e-mail is sent by Supabase Auth
 * (resetPasswordForEmail) to the person's own address; the link is never built, returned or logged by us.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";
const ELSEWHERE = "55555555-5555-4555-8555-555555555555";
const EMAIL = "jane.smith@example.com";

type Membership = { user_id: string; organization_id: string; support: boolean; active: boolean };
const state = {
  role: "admin",
  support: false,
  aal: "aal2",
  memberships: [] as Membership[],
  emails: {} as Record<string, string | null>,
  owners: new Set<string>(),
  rpcMissing: false,
  limitCalls: [] as Array<{ bucket: string; key: string; window: number; max: number }>,
  limitDenied: null as string | null,
  limiterDown: false,
  resetCalls: [] as Array<{ email: string; options: { redirectTo?: string } }>,
  resetError: null as { status: number } | null,
  redirect: "https://tolra.example/auth/set-password" as string | null,
  audited: [] as Array<{ action: string; entityId: string; newData: Record<string, unknown> }>,
};

const ordinary = (user_id: string, organization_id: string, extra: Partial<Membership> = {}): Membership =>
  ({ user_id, organization_id, support: false, active: true, ...extra });

const admin = {
  from: (table: string) => {
    if (table !== "organization_members") throw new Error(`unexpected table ${table}`);
    const filters: Array<[string, unknown]> = [];
    const rows = () => state.memberships.filter((m) => filters.every(([c, v]) => (m as Record<string, unknown>)[c] === v));
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
      then: (resolve: (value: { data: Membership[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
    };
    return chain;
  },
  auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email: state.emails[id] ?? null } }, error: null }) } },
};

const supabase = {
  auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal, nextLevel: "aal2" }, error: null }) } },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn === "write_audit") { state.audited.push({ action: String(args.p_action), entityId: String(args.p_entity_id), newData: args.p_new as Record<string, unknown> }); return { data: null, error: null }; }
    if (fn !== "admin_login_is_protected") throw new Error(`unexpected rpc ${fn}`);
    if (state.rpcMissing) return { data: null, error: { code: "PGRST202" } };
    const id = String(args.p_user);
    return { data: !state.memberships.some((m) => m.user_id === id && m.organization_id === ORG) || state.owners.has(id), error: null };
  },
};

// The real guard in lib/server/admin-users.ts calls these; requireProfile is the only thing faked (it answers what the real one does for a role).
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return {
    ...actual,
    requireProfile: async () => (state.role === "admin"
      ? { user: { id: ADMIN }, profile: { organization_id: ORG }, supabase, session: state.support ? { support: true } : null }
      : NextResponse.json({ error: "Forbidden" }, { status: 403 })),
  };
});
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/login", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/login")>("@/lib/server/login");
  return {
    ...actual,
    withinLimit: async (_a: unknown, bucket: string, key: string, window: number, max: number) => {
      if (state.limiterDown) throw new actual.LimiterUnavailableError("down");
      state.limitCalls.push({ bucket, key, window, max });
      return state.limitDenied !== bucket;
    },
  };
});
vi.mock("@/lib/auth-links", () => ({ setPasswordUrl: () => state.redirect }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      resetPasswordForEmail: async (email: string, options: { redirectTo?: string }) => {
        state.resetCalls.push({ email, options });
        return { data: {}, error: state.resetError };
      },
    },
  }),
}));

const { POST } = await import("@/app/api/admin/users/reset-link/route");

const send = (userId: unknown = USER) =>
  POST(new Request("https://app.test/api/admin/users/reset-link", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://app.test", host: "app.test" }, body: JSON.stringify({ userId }) }));

beforeEach(() => {
  Object.assign(state, {
    role: "admin", support: false, aal: "aal2", rpcMissing: false, limitCalls: [], limitDenied: null, limiterDown: false,
    resetCalls: [], resetError: null, redirect: "https://tolra.example/auth/set-password", audited: [], owners: new Set<string>(),
    memberships: [ordinary(ADMIN, ORG), ordinary(USER, ORG)],
    emails: { [USER]: EMAIL, [OTHER]: EMAIL },
  });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tolra.example";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const untouched = () => {
  expect(state.resetCalls).toEqual([]);
  expect(state.audited).toEqual([]);
};

describe("who may send a reset e-mail", () => {
  it("a non-admin is refused", async () => {
    state.role = "office";
    expect((await send()).status).toBe(403);
    untouched();
  });

  it("a support session (the platform owner inside a company) is refused", async () => {
    state.support = true;
    expect((await send()).status).toBe(403);
    untouched();
  });

  it("an admin session that hasn't passed the second step (aal1) is refused, whatever REQUIRE_ADMIN_MFA says", async () => {
    state.aal = "aal1";
    for (const setting of ["false", "true", undefined]) {
      if (setting === undefined) delete process.env.REQUIRE_ADMIN_MFA; else process.env.REQUIRE_ADMIN_MFA = setting;
      const response = await send();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mfa_required" });
    }
    untouched();
  });

  it("a cross-site request is refused", async () => {
    const response = await POST(new Request("https://app.test/api/admin/users/reset-link", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://evil.test", host: "app.test" }, body: JSON.stringify({ userId: USER }) }));
    expect(response.status).toBe(403);
    untouched();
  });

  it("someone who isn't a member of the admin's company (another company's person) is not found", async () => {
    state.memberships.push(ordinary(OTHER, ELSEWHERE));
    expect((await send(OTHER)).status).toBe(404);
    untouched();
  });

  it("a login shared with another company is refused: only its owner can reset it", async () => {
    state.memberships.push(ordinary(USER, ELSEWHERE, { active: false }));
    const response = await send();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("also uses Tolra with another company");
    untouched();
  });

  it("a support membership (window open or over) is a protected login", async () => {
    state.memberships.push(ordinary(OTHER, ORG, { support: true, active: false }));
    expect((await send(OTHER)).status).toBe(403);
    untouched();
  });

  it("a platform owner's login (093) is refused; so is an unanswerable check (fail closed)", async () => {
    state.memberships.push(ordinary(OTHER, ORG));
    state.owners.add(OTHER);
    expect((await send(OTHER)).status).toBe(403);
    state.rpcMissing = true;
    expect((await send()).status).toBe(500);
    untouched();
  });

  it("not yourself, not a deactivated member, not a login with no e-mail, not a bad id", async () => {
    expect((await send(ADMIN)).status).toBe(409);
    state.memberships = [ordinary(ADMIN, ORG), ordinary(USER, ORG, { active: false })];
    expect((await send()).status).toBe(409);
    state.memberships = [ordinary(ADMIN, ORG), ordinary(USER, ORG)];
    state.emails[USER] = null;
    expect((await send()).status).toBe(409);
    expect((await send("not-a-uuid")).status).toBe(400);
    untouched();
  });
});

describe("sending", () => {
  it("asks Supabase Auth to e-mail the person's own address, redirecting to set-password; audits; never returns the link or the full address", async () => {
    const response = await send();
    expect(response.status).toBe(200);
    expect(state.resetCalls).toEqual([{ email: EMAIL, options: { redirectTo: "https://tolra.example/auth/set-password" } }]);
    const body = await response.json();
    expect(body).toEqual({ ok: true, sentTo: "j***@example.com" });
    expect(JSON.stringify(body)).not.toContain(EMAIL);
    expect(state.audited).toEqual([{ action: "PASSWORD_RESET_PREPARED", entityId: USER, newData: { via: "email" } }]);
    expect(JSON.stringify(state.audited)).not.toContain("example.com");
  });

  it("no site URL (setPasswordUrl null or empty): 500, nothing sent, nothing audited", async () => {
    for (const value of [null, ""]) {
      state.redirect = value;
      expect((await send()).status).toBe(500);
    }
    untouched();
  });

  it("Auth refusing the e-mail is reported and nothing is audited", async () => {
    state.resetError = { status: 429 };
    const response = await send();
    expect(response.status).toBe(502);
    expect(state.audited).toEqual([]);
  });
});

describe("rate limit", () => {
  it("counts per admin and per person, and the send follows only when both allow", async () => {
    await send();
    expect(state.limitCalls).toEqual([
      { bucket: "admin_reset_link_admin", key: ADMIN, window: 900, max: 10 },
      { bucket: "admin_reset_link_person", key: USER, window: 900, max: 3 },
    ]);
  });

  it("over the admin's or the person's limit: 429 and no e-mail", async () => {
    for (const bucket of ["admin_reset_link_admin", "admin_reset_link_person"]) {
      state.limitDenied = bucket;
      expect((await send()).status).toBe(429);
    }
    untouched();
  });

  it("limiter unavailable: fails closed with 503 and no e-mail", async () => {
    state.limiterDown = true;
    expect((await send()).status).toBe(503);
    untouched();
  });
});
