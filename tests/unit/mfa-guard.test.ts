/**
 * Admin two-step sign-in in the API guard: with REQUIRE_ADMIN_MFA on, an admin whose session is not aal2 is refused on every
 * route behind requireProfile (settings, users, payments, year-end, mail, anything admin-only) and one with aal2 is let in;
 * other roles are unaffected; the switch defaults to on in Vercel Production only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

let who: { role: string; secondary?: string | null };
let level: "aal1" | "aal2";
let levelError: boolean;
const rpcCalls: string[] = [];
const resolved: Array<Record<string, unknown>> = [];

const chain = (result: unknown) => {
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" || prop === "single" ? () => Promise.resolve({ data: result, error: null }) : () => c) });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "a@example.test" } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => (levelError ? { data: null, error: { message: "boom" } } : { data: { currentLevel: level, nextLevel: "aal2" }, error: null }) },
    },
    from: () => chain({ id: "user-1", email: "a@example.test", full_name: "A", role: who.role, secondary_role: who.secondary ?? null, organization_id: "org-1", active: true, must_change_password: false }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push(name);
      if (name === "current_user_organization_id") return { data: "org-1", error: null };
      if (name === "has_org_role") return { data: ((args.allowed_roles as string[]) ?? []).includes(who.role) || ((args.allowed_roles as string[]) ?? []).includes(who.secondary ?? "-"), error: null };
      if (name === "admin_mfa_overview") return { data: { require_admin_mfa: false, can_require: true, admins: [] }, error: null };
      if (name === "resolve_job_email") { resolved.push(args); return { data: args.p_history, error: null }; }
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({ auth: { admin: { mfa: { listFactors: async () => ({ data: { factors: [] }, error: null }) } } }, from: () => chain(null) }) }));

import { POST as alertTest } from "@/app/api/admin/alert-test/route";
import { POST as mfaReset } from "@/app/api/admin/users/mfa-reset/route";
import { POST as setPassword } from "@/app/api/admin/users/password/route";
import { POST as resolveJob } from "@/app/api/send-job/resolve/route";
import { POST as mailSend } from "@/app/api/mail/send/route";
import { adminMfaRequired, holdsAdmin } from "@/lib/mfa-policy";
import { requireProfile } from "@/lib/server/auth";

const ENV = ["REQUIRE_ADMIN_MFA", "VERCEL_ENV", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "ALERT_EMAIL_TO"];
const saved: Record<string, string | undefined> = {};
const HISTORY = "11111111-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const post = (url: string, body: unknown = {}) => new Request(`https://app.test${url}`, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  who = { role: "admin" };
  level = "aal1";
  levelError = false;
  rpcCalls.length = 0;
  resolved.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

describe("the switch", () => {
  it("explicit true/false win; unset means off everywhere, Production included (switched on deliberately at go-live)", () => {
    expect(adminMfaRequired({ REQUIRE_ADMIN_MFA: "true" })).toBe(true);
    expect(adminMfaRequired({ REQUIRE_ADMIN_MFA: "TRUE", VERCEL_ENV: "preview" })).toBe(true);
    expect(adminMfaRequired({ REQUIRE_ADMIN_MFA: "false", VERCEL_ENV: "production" })).toBe(false);
    expect(adminMfaRequired({ VERCEL_ENV: "production" })).toBe(false);
    expect(adminMfaRequired({ VERCEL_ENV: "preview" })).toBe(false);
    expect(adminMfaRequired({})).toBe(false);
  });

  it("holdsAdmin looks at the role and the second role", () => {
    expect(holdsAdmin({ role: "admin" })).toBe(true);
    expect(holdsAdmin({ role: "office", secondary_role: "admin" })).toBe(true);
    expect(holdsAdmin({ role: "office", secondary_role: "workshop" })).toBe(false);
    expect(holdsAdmin(null)).toBe(false);
  });
});

describe("requireProfile with the second step required", () => {
  it("an admin at aal1 is refused with mfa_required; at aal2 they pass", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    const refused = await requireProfile(["admin"]);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(403);
    expect(await (refused as Response).json()).toMatchObject({ code: "mfa_required" });
    level = "aal2";
    const allowed = await requireProfile(["admin"]);
    expect(allowed).not.toBeInstanceOf(Response);
  });

  it("an error reading the assurance level refuses (fails closed)", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    levelError = true;
    expect(((await requireProfile(["admin"])) as Response).status).toBe(403);
  });

  it("an admin by second role is held to it too; office, workshop and viewer are not asked", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    who = { role: "office", secondary: "admin" };
    expect(((await requireProfile(["office"])) as Response).status).toBe(403);
    for (const role of ["office", "workshop", "viewer"]) {
      who = { role };
      expect(await requireProfile([role])).not.toBeInstanceOf(Response);
    }
  });

  it("off (local development, tests): an admin at aal1 is let in", async () => {
    process.env.REQUIRE_ADMIN_MFA = "false";
    expect(await requireProfile(["admin"])).not.toBeInstanceOf(Response);
  });

  it("off in Vercel Production until REQUIRE_ADMIN_MFA is set (so a deploy can't lock admins out), on once it is", async () => {
    process.env.VERCEL_ENV = "production";
    expect(await requireProfile(["admin"])).not.toBeInstanceOf(Response);
    process.env.REQUIRE_ADMIN_MFA = "true";
    expect(((await requireProfile(["admin"])) as Response).status).toBe(403);
  });
});

describe("privileged routes", () => {
  it("settle an unknown e-mail, the alert test, mail send and resetting someone's two-step: refused at aal1 with nothing done", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    const attempts: Array<[string, () => Promise<Response>]> = [
      ["send-job/resolve", () => resolveJob(post("/api/send-job/resolve", { historyId: HISTORY, as: "failed" }))],
      ["admin/alert-test", () => alertTest(post("/api/admin/alert-test"))],
      ["mail/send", () => mailSend(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }))],
      ["admin/users/mfa-reset", () => mfaReset(post("/api/admin/users/mfa-reset", { userId: "22222222-4f50-4a6b-8c7d-9e0f1a2b3c4d" }))],
    ];
    for (const [name, attempt] of attempts) {
      const response = await attempt();
      expect({ name, status: response.status, code: (await response.json()).code }).toEqual({ name, status: 403, code: "mfa_required" });
    }
    expect(resolved).toEqual([]);
  });

  it("with aal2 the same routes get past the guard", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    level = "aal2";
    const response = await resolveJob(post("/api/send-job/resolve", { historyId: HISTORY, as: "failed" }));
    expect(response.status).toBe(200);
    expect(resolved).toHaveLength(1);
    // The alert test now reaches its own rule (alerts are not switched on here).
    expect(await (await alertTest(post("/api/admin/alert-test"))).json()).toMatchObject({ sent: false, reason: "disabled" });
  });
});

describe("handing over a login always needs the second step (audit item 4)", () => {
  it("REQUIRE_ADMIN_MFA unset: an admin at aal1 is refused Reset two-step sign-in and Set password with mfa_required; nothing is read", async () => {
    // beforeEach leaves REQUIRE_ADMIN_MFA unset (off), so requireProfile itself lets an aal1 admin in.
    expect(await requireProfile(["admin"])).not.toBeInstanceOf(Response);
    for (const response of [
      await mfaReset(post("/api/admin/users/mfa-reset", { userId: "22222222-4f50-4a6b-8c7d-9e0f1a2b3c4d" })),
      await setPassword(post("/api/admin/users/password", { user_id: "22222222-4f50-4a6b-8c7d-9e0f1a2b3c4d", password: "Correct-Horse-Battery-9", must_change_password: true })),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mfa_required" });
    }
  });

  it("REQUIRE_ADMIN_MFA unset: at aal2 Reset two-step sign-in gets past the guard (here: nobody to reset, 404)", async () => {
    level = "aal2";
    const response = await mfaReset(post("/api/admin/users/mfa-reset", { userId: "22222222-4f50-4a6b-8c7d-9e0f1a2b3c4d" }));
    expect(response.status).toBe(404);
  });

  it("an error reading the assurance level refuses (fails closed)", async () => {
    level = "aal2";
    levelError = true;
    const response = await mfaReset(post("/api/admin/users/mfa-reset", { userId: "22222222-4f50-4a6b-8c7d-9e0f1a2b3c4d" }));
    expect(await response.json()).toMatchObject({ code: "mfa_required" });
  });
});
