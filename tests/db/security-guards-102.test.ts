/**
 * Migration 102: database guards from the pre-go-live security review.
 *
 *   - Z4: only an admin changes organization_settings.archive_after_months, directly through the API too (update and insert); office
 *     still writes the row's other choices; an admin changes it.
 *   - Z3: "Admins update org members" reaches only the admin's own people: an ACTIVE, NON-SUPPORT member of the session company with
 *     no membership anywhere else, and not a protected login (093). A platform owner's login (support row, or an ordinary membership),
 *     a login shared with another company and a switched-off member are not updated (no row). Their own profile stays theirs.
 *     "Admins read org members" no longer lists a protected login or a shared one (T2: no stale organization_id / organization).
 *   - The same through the API with the two synthetic companies (alpha, beta), a login shared by both and a platform owner.
 *   - T1: user_profiles_guard refuses another person's full_name, organization and workshop_email when they belong to another company,
 *     even where row security is bypassed; the person changes their own.
 *   - S2/S3: no signed-in user may execute ai_helper_settle (privilege and a real call); the service role settles, and the audit row
 *     names the person who asked; ai_helper_reserve's answer carries no key.
 *   - T3: the quote-attachments bucket is private, and the release makes it private again.
 *   - supabase/verify/security_guards_102.sql answers TRUE on every row; the rollback puts 058's, 012's, 007's and 101's objects back
 *     (inside a transaction that is rolled back) and the release then applies again cleanly, twice.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 093 and 101 suites do.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });
const KEY_ENC = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc";
const DIGEST = "c".repeat(64);

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `102 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-102-${label}-${counter}`]);
  return id;
}

/** A login (created on first use) with a membership in `org`. A support row is written as 036 leaves it (active, window over). */
async function member(db: Client, org: string, p: Person, role: string, extra: { support?: boolean; active?: boolean } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $2, $3, $4, true, false) on conflict (id) do nothing`, [p.id, p.email, role, org]);
  await db.query(
    `insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
     values ($1, $2, $3, $4, $5, case when $5 then now() - interval '3 days' end, case when $5 then gen_random_uuid() end)`,
    [p.id, org, role, extra.active ?? true, extra.support ?? false]);
}

async function choose(db: Client, p: Person, org: string) {
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

const claims = (p: Person) => JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, ...(p.session ? { session_id: p.session } : {}) });

/**
 * One API request as the person (role authenticated, their claims), in its own transaction. With `bypass`, the same claims but the
 * database owner's role: row security does not apply, triggers (the profile guard) still do.
 */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>, opts: { bypass?: boolean } = {}): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      if (!opts.bypass) await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [claims(p), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

/** One call as the server's service role (no person), in its own transaction. */
async function asService<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { code?: string; message: string; hint?: string };
  }
};

const rows = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);
const profile = (id: string) => rows<{ full_name: string; workshop_email: string | null; organization: string | null; mfa_required: boolean | null }>(
  "select full_name, workshop_email, organization, mfa_required from public.user_profiles where id = $1", [id]).then((r) => r[0]);
/** The rows a profile UPDATE reached (0 = row security refused it). */
const updated = (p: Person, target: string, set: string, value: unknown) =>
  as(p, async (db) => (await db.query(`update public.user_profiles set ${set} = $2 where id = $1`, [target, value])).rowCount);

// A and C. aAdmin, aOffice: admin and office of A. staff: workshop of A only. inactive: A only, switched off. shared: office of A and C.
// owner1: platform owner with only a leftover support row in A. owner2: platform owner, ordinary office member of A. cAdmin: admin of C.
const W = { A: "", C: "", aAdmin: person("a-admin"), aOffice: person("a-office"), staff: person("staff"), inactive: person("inactive"),
  shared: person("shared"), owner1: person("owner1"), owner2: person("owner2"), cAdmin: person("c-admin") };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.C = await makeOrg(db, "c");
    await member(db, W.A, W.aAdmin, "admin");
    await member(db, W.A, W.aOffice, "office");
    await member(db, W.A, W.staff, "workshop");
    await member(db, W.A, W.inactive, "workshop", { active: false });
    await member(db, W.A, W.shared, "office");
    await member(db, W.C, W.shared, "office");
    await member(db, W.A, W.owner1, "admin", { support: true });
    await member(db, W.A, W.owner2, "office");
    await member(db, W.C, W.cAdmin, "admin");
    await db.query("insert into security_audit.platform_admins (user_id) values ($1), ($2)", [W.owner1.id, W.owner2.id]);
    await choose(db, W.aAdmin, W.A);
    await choose(db, W.aOffice, W.A);
    await choose(db, W.shared, W.A);
    await choose(db, W.cAdmin, W.C);
  });
});

afterAll(async () => {
  await withDb((db) => db.query("delete from security_audit.platform_admins where user_id = any($1)", [[W.owner1.id, W.owner2.id]]));
  await destroySyntheticWorld(run);
});

describe("Z4: archive_after_months is admin only", () => {
  const settings = () => rows<{ archive_after_months: number; hidden_columns: unknown }>(
    "select archive_after_months, hidden_columns from public.organization_settings where organization_id = $1", [W.A]).then((r) => r[0]);

  it("office can't change it directly (update, or an insert that sets it); office still writes the row's other choices", async () => {
    await withDb((db) => db.query("delete from public.organization_settings where organization_id = $1", [W.A]));
    // An insert by office that sets it is refused; one that leaves it at 028's default (12) is fine.
    expect(await errorOf(as(W.aOffice, (db) => db.query("insert into public.organization_settings (organization_id, archive_after_months) values ($1, 6)", [W.A]))))
      .toMatchObject({ code: "42501", message: "Only admins can change when finished records move to Archived" });
    await as(W.aOffice, (db) => db.query("insert into public.organization_settings (organization_id, hidden_columns) values ($1, '{\"jobs\": [\"notes\"]}'::jsonb)", [W.A]));
    expect(await settings()).toMatchObject({ archive_after_months: 12, hidden_columns: { jobs: ["notes"] } });
    // An update by office that changes it is refused, the row unchanged; one that changes only other choices goes through.
    for (const months of [1, 6, 120]) {
      expect(await errorOf(as(W.aOffice, (db) => db.query("update public.organization_settings set archive_after_months = $2 where organization_id = $1", [W.A, months]))))
        .toMatchObject({ code: "42501" });
    }
    expect(await errorOf(as(W.aOffice, (db) => db.query("update public.organization_settings set archive_after_months = 3, hidden_columns = '{}'::jsonb where organization_id = $1", [W.A]))))
      .toMatchObject({ code: "42501" });
    expect(await settings()).toMatchObject({ archive_after_months: 12, hidden_columns: { jobs: ["notes"] } });
    await as(W.aOffice, (db) => db.query("update public.organization_settings set hidden_columns = '{}'::jsonb where organization_id = $1", [W.A]));
    // The upsert the Settings screen sends, as office: refused.
    expect(await errorOf(as(W.aOffice, (db) => db.query(
      "insert into public.organization_settings (organization_id, archive_after_months) values ($1, 6) on conflict (organization_id) do update set archive_after_months = excluded.archive_after_months", [W.A]))))
      .toMatchObject({ code: "42501" });
    expect(await settings()).toMatchObject({ archive_after_months: 12, hidden_columns: {} });
  });

  it("an admin changes it (update and the Settings screen's upsert); office may then write the row without touching it", async () => {
    await as(W.aAdmin, (db) => db.query("update public.organization_settings set archive_after_months = 6 where organization_id = $1", [W.A]));
    expect((await settings()).archive_after_months).toBe(6);
    await as(W.aAdmin, (db) => db.query(
      "insert into public.organization_settings (organization_id, archive_after_months) values ($1, 24) on conflict (organization_id) do update set archive_after_months = excluded.archive_after_months", [W.A]));
    expect((await settings()).archive_after_months).toBe(24);
    // Setting it to the value it already has is no change.
    await as(W.aOffice, (db) => db.query("update public.organization_settings set archive_after_months = 24, hidden_columns = '{}'::jsonb where organization_id = $1", [W.A]));
    expect((await settings()).archive_after_months).toBe(24);
  });

  it("the server's own writes (no person) are not affected", async () => {
    await withDb((db) => db.query("update public.organization_settings set archive_after_months = 12 where organization_id = $1", [W.A]));
    expect((await settings()).archive_after_months).toBe(12);
  });
});

describe("Z3: an admin updates only their own company's people", () => {
  it("their own staff: name, workshop e-mail and the two-step flag, as before", async () => {
    expect(await updated(W.aAdmin, W.staff.id, "full_name", "Staff Renamed")).toBe(1);
    expect(await updated(W.aAdmin, W.staff.id, "workshop_email", "bench@example.test")).toBe(1);
    expect(await updated(W.aAdmin, W.staff.id, "mfa_required", true)).toBe(1);
    expect(await profile(W.staff.id)).toMatchObject({ full_name: "Staff Renamed", workshop_email: "bench@example.test", mfa_required: true });
  });

  it("never a platform owner (support row or ordinary membership), a shared login or a switched-off member: no row, nothing changed", async () => {
    for (const target of [W.owner1, W.owner2, W.shared, W.inactive]) {
      const before = await profile(target.id);
      for (const [set, value] of [["full_name", "Taken over"], ["workshop_email", "attacker@example.test"], ["organization", "Not theirs"], ["mfa_required", false]] as const) {
        expect(await updated(W.aAdmin, target.id, set, value), `${target.email} ${set}`).toBe(0);
      }
      expect(await profile(target.id), target.email).toEqual(before);
    }
  });

  it("another company's admin, and office, reach nobody in A", async () => {
    expect(await updated(W.cAdmin, W.staff.id, "full_name", "From C")).toBe(0);
    expect(await updated(W.cAdmin, W.shared.id, "full_name", "From C")).toBe(0);
    expect(await updated(W.aOffice, W.staff.id, "full_name", "From office")).toBe(0);
    expect((await profile(W.staff.id)).full_name).toBe("Staff Renamed");
  });

  it("everyone still changes their own profile (000's policy), a shared login included", async () => {
    expect(await updated(W.aAdmin, W.aAdmin.id, "full_name", "Admin Self")).toBe(1);
    expect(await updated(W.shared, W.shared.id, "full_name", "Shared Self")).toBe(1);
    expect(await updated(W.shared, W.shared.id, "workshop_email", "shared@example.test")).toBe(1);
    expect(await profile(W.shared.id)).toMatchObject({ full_name: "Shared Self", workshop_email: "shared@example.test" });
  });

  it("admin_may_edit_profile answers TRUE only for the caller's own people; never for anon", async () => {
    const may = (p: Person, target: string | null) => as(p, async (db) => (await db.query<{ v: boolean }>("select public.admin_may_edit_profile($1) as v", [target])).rows[0].v);
    expect(await may(W.aAdmin, W.staff.id)).toBe(true);
    expect(await may(W.aAdmin, W.aOffice.id)).toBe(true);
    for (const target of [W.owner1, W.owner2, W.shared, W.inactive, W.cAdmin]) expect(await may(W.aAdmin, target.id), target.email).toBe(false);
    expect(await may(W.aAdmin, null)).toBe(false);
    expect(await may(W.aOffice, W.staff.id)).toBe(false);
    expect(await may(W.cAdmin, W.staff.id)).toBe(false);
    const [grants] = await rows<{ anon: boolean; authed: boolean }>(
      "select has_function_privilege('anon', 'public.admin_may_edit_profile(uuid)', 'EXECUTE') as anon, has_function_privilege('authenticated', 'public.admin_may_edit_profile(uuid)', 'EXECUTE') as authed");
    expect(grants).toEqual({ anon: false, authed: true });
  });

  it("the admin read policy lists own staff and switched-off members; never a protected or shared login (T2: no stale company columns)", async () => {
    const seen = await as(W.aAdmin, async (db) => (await db.query<{ id: string }>("select id from public.user_profiles where id = any($1)",
      [[W.staff.id, W.inactive.id, W.shared.id, W.owner1.id, W.owner2.id, W.cAdmin.id]])).rows.map((r) => r.id).sort());
    expect(seen).toEqual([W.staff.id, W.inactive.id].sort());
    expect(await as(W.aAdmin, async (db) => (await db.query("select organization_id, organization from public.user_profiles where id = $1", [W.shared.id])).rows)).toEqual([]);
    // The shared person still reads their own row (000's policy).
    expect(await as(W.shared, async (db) => (await db.query<{ id: string }>("select id from public.user_profiles where id = $1", [W.shared.id])).rows)).toEqual([{ id: W.shared.id }]);
  });

  it("admin_may_read_profile answers TRUE only for the caller's own (single-company, unprotected) people; never for anon", async () => {
    const may = (p: Person, target: string | null) => as(p, async (db) => (await db.query<{ v: boolean }>("select public.admin_may_read_profile($1) as v", [target])).rows[0].v);
    for (const target of [W.staff, W.inactive, W.aOffice]) expect(await may(W.aAdmin, target.id), target.email).toBe(true);
    for (const target of [W.owner1, W.owner2, W.shared, W.cAdmin]) expect(await may(W.aAdmin, target.id), target.email).toBe(false);
    expect(await may(W.aAdmin, null)).toBe(false);
    expect(await may(W.aOffice, W.staff.id)).toBe(false);
    expect(await may(W.cAdmin, W.staff.id)).toBe(false);
    const [grants] = await rows<{ anon: boolean; authed: boolean }>(
      "select has_function_privilege('anon', 'public.admin_may_read_profile(uuid)', 'EXECUTE') as anon, has_function_privilege('authenticated', 'public.admin_may_read_profile(uuid)', 'EXECUTE') as authed");
    expect(grants).toEqual({ anon: false, authed: true });
  });
});

describe("T1: the profile guard keeps a shared login's name and e-mail settings to its owner", () => {
  it("refused for a person who also belongs to another company, even with row security bypassed", async () => {
    const before = await profile(W.shared.id);
    for (const [set, value] of [["full_name", "Renamed by A"], ["workshop_email", "x@example.test"], ["organization", "Company A"]] as const) {
      expect(await errorOf(as(W.aAdmin, (db) => db.query(`update public.user_profiles set ${set} = $2 where id = $1`, [W.shared.id, value]), { bypass: true })), set)
        .toMatchObject({ code: "42501" });
    }
    expect(await profile(W.shared.id)).toEqual(before);
    // A platform owner with a support row in A counts as belonging elsewhere too only if they have another company; owner1 has only
    // A's support row, so the guard leaves the decision to the policy (above: no row).
  });

  it("allowed for the admin's own single-company staff, and for the person themself", async () => {
    await as(W.aAdmin, (db) => db.query("update public.user_profiles set full_name = 'Staff Again' where id = $1", [W.staff.id]), { bypass: true });
    expect((await profile(W.staff.id)).full_name).toBe("Staff Again");
    await as(W.shared, (db) => db.query("update public.user_profiles set full_name = 'Shared Again' where id = $1", [W.shared.id]), { bypass: true });
    expect((await profile(W.shared.id)).full_name).toBe("Shared Again");
  });
});

describe("S2/S3: the AI helper key and settle", () => {
  let request = "";
  beforeAll(async () => {
    await withDb(async (db) => {
      await db.query("insert into public.ai_helper_settings (organization_id, rfq_enabled, monthly_cap_pence) values ($1, true, 500)", [W.A]);
      await db.query("insert into public.ai_helper_secrets (organization_id, api_key_enc) values ($1, $2)", [W.A, KEY_ENC]);
    });
  });

  it("reserve's answer carries no key", async () => {
    const value = await as(W.aOffice, async (db) => (await db.query<{ v: Record<string, unknown> }>("select public.ai_helper_reserve('rfq', 5, $1, 10) as v", [DIGEST])).rows[0].v);
    expect(value).toMatchObject({ ok: true });
    expect(Object.keys(value).sort()).toEqual(["ok", "request_id"]);
    expect(JSON.stringify(value)).not.toContain(KEY_ENC);
    request = String(value.request_id);
  });

  it("no signed-in user may execute settle: not the requester, not an admin (privilege and a real call); nothing is settled", async () => {
    const [grants] = await rows<{ anon: boolean; authed: boolean; service: boolean; pub: boolean }>(
      "select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authed, " +
      "has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service, " +
      "exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub",
      ["public.ai_helper_settle(uuid,text,text,integer,text,jsonb)"]);
    expect(grants).toEqual({ anon: false, authed: false, service: true, pub: false });
    for (const p of [W.aOffice, W.aAdmin]) {
      expect(await errorOf(as(p, (db) => db.query("select public.ai_helper_settle($1, 'suggested', null, 0, 'made-up-model', '{\"kind\": \"rfq\", \"lines\": []}'::jsonb)", [request]))))
        .toMatchObject({ code: "42501", message: expect.stringMatching(/^permission denied for function ai_helper_settle/) });
    }
    expect((await rows<{ status: string }>("select status from public.ai_helper_requests where id = $1", [request]))[0].status).toBe("reserved");
    expect(await rows("select 1 from security_audit.audit_log where entity_id = $1 and action = 'ai_helper_suggested'", [request])).toEqual([]);
  });

  it("the service role settles once: actual cost to spent, the audit row names the person who asked; the key is readable by it", async () => {
    await asService((db) => db.query("select public.ai_helper_settle($1, 'suggested', null, 3, 'claude-opus-5-5', '{\"kind\": \"rfq\", \"lines\": [{}]}'::jsonb)", [request]));
    expect((await rows("select status, cost_pence, model from public.ai_helper_requests where id = $1", [request]))[0]).toEqual({ status: "suggested", cost_pence: 3, model: "claude-opus-5-5" });
    expect((await rows<{ reserved_pence: number; spent_pence: number }>("select reserved_pence, spent_pence from public.ai_helper_usage where organization_id = $1", [W.A]))[0])
      .toEqual({ reserved_pence: 0, spent_pence: 3 });
    const audit = await rows<{ actor_user_id: string; actor_email: string; metadata: Record<string, unknown> }>(
      "select actor_user_id, actor_email, metadata from security_audit.audit_log where entity_id = $1 and action = 'ai_helper_suggested'", [request]);
    expect(audit).toEqual([{ actor_user_id: W.aOffice.id, actor_email: W.aOffice.email, metadata: { feature: "rfq", model: "claude-opus-5-5", cost_pence: 3, lines: 1, source: "ai_helper" } }]);
    // Once only; a bad shape is refused.
    expect(await errorOf(asService((db) => db.query("select public.ai_helper_settle($1, 'failed', 'invalid', 0, null, null)", [request])))).toMatchObject({ code: "42501" });
    expect(await errorOf(asService((db) => db.query("select public.ai_helper_settle($1, 'suggested', 'invalid', 0, null, '{}'::jsonb)", [request])))).toMatchObject({ code: "22023" });
    // The server reads the company's key with the service role; no signed-in user can.
    expect(await asService(async (db) => (await db.query<{ k: string }>("select api_key_enc as k from public.ai_helper_secrets where organization_id = $1", [W.A])).rows)).toEqual([{ k: KEY_ENC }]);
    expect(await errorOf(as(W.aAdmin, (db) => db.query("select api_key_enc from public.ai_helper_secrets")))).toMatchObject({ code: "42501" });
  });
});

describe("T3: the quote-attachments bucket", () => {
  it("is private, and the release makes it private again (inside a rolled-back transaction)", async () => {
    expect(await rows("select public from storage.buckets where id = 'quote-attachments'")).toEqual([{ public: false }]);
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("update storage.buckets set public = true where id = 'quote-attachments'");
        await db.query(unwrapped(read("supabase/release/102_security_guards.release.sql")));
        expect((await db.query("select public from storage.buckets where id = 'quote-attachments'")).rows).toEqual([{ public: false }]);
      } finally {
        await db.query("rollback");
      }
    });
  });
});

/**
 * The same rules through the API (PostgREST, real sign-ins) with the two synthetic companies: alpha, beta, a login shared by both
 * (alpha's viewer, also given beta), and a platform owner with a support row in alpha.
 */
describe("two companies through the API (alpha, beta, a shared login, a platform owner)", () => {
  let world: SyntheticWorld;
  const c = {} as Record<"alphaAdmin" | "alphaOffice" | "betaAdmin", SupabaseClient>;
  let owner = "";
  const service = () => adminClient();
  const nameOf = async (id: string) => (await service().from("user_profiles").select("full_name").eq("id", id).single()).data!.full_name as string;

  beforeAll(async () => {
    world = await createSyntheticWorld();
    c.alphaAdmin = await signedInClient(world.tenants.alpha.users.admin);
    c.alphaOffice = await signedInClient(world.tenants.alpha.users.office);
    c.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
    expect((await service().rpc("add_member", { p_org: world.tenants.beta.id, p_email: world.tenants.alpha.users.viewer.email, p_role: "viewer" })).error).toBeNull();
    const created = await service().auth.admin.createUser({ email: `owner.platform.${world.runId}@example.test`, password: `Pw-${randomUUID()}`, email_confirm: true });
    expect(created.error).toBeNull();
    owner = created.data.user!.id;
    await withDb(async (db) => {
      await db.query(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
                      values ($1, $2, 'Tolra Support', 'admin', $3, true, false) on conflict (id) do nothing`, [owner, `owner.platform.${world.runId}@example.test`, world.tenants.alpha.id]);
      await db.query(`insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
                      values ($1, $2, 'admin', true, true, now() + interval '2 hours', gen_random_uuid())`, [owner, world.tenants.alpha.id]);
      await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [owner]);
    });
  });

  afterAll(async () => {
    if (owner) await withDb((db) => db.query("delete from security_audit.platform_admins where user_id = $1", [owner]));
    if (world) await destroySyntheticWorld(world.runId);
  });

  it("alpha's admin can't update, or read the stale company columns of, a beta-only login or the shared login", async () => {
    const betaOnly = world.tenants.beta.users.office.id;
    const shared = world.tenants.alpha.users.viewer.id;
    for (const id of [betaOnly, shared]) {
      const before = await nameOf(id);
      const update = await c.alphaAdmin.from("user_profiles").update({ full_name: "Renamed by alpha" }).eq("id", id).select("id");
      expect(update.data ?? []).toEqual([]);
      const mail = await c.alphaAdmin.from("user_profiles").update({ workshop_email: "alpha@example.test" }).eq("id", id).select("id");
      expect(mail.data ?? []).toEqual([]);
      expect(await nameOf(id)).toBe(before);
      const read = await c.alphaAdmin.from("user_profiles").select("organization_id, organization").eq("id", id);
      expect(read.error).toBeNull();
      expect(read.data).toEqual([]);
    }
    // Nor can beta's admin read the shared login's stale columns (they may name alpha).
    expect((await c.betaAdmin.from("user_profiles").select("organization_id, organization").eq("id", shared)).data).toEqual([]);
  });

  it("alpha's admin can't edit or read the platform owner's profile (support row in alpha)", async () => {
    const before = await nameOf(owner);
    const update = await c.alphaAdmin.from("user_profiles").update({ full_name: "Taken over" }).eq("id", owner).select("id");
    expect(update.data ?? []).toEqual([]);
    expect(await nameOf(owner)).toBe(before);
    expect((await c.alphaAdmin.from("user_profiles").select("email").eq("id", owner)).data).toEqual([]);
  });

  it("alpha's admin still edits and reads its own alpha-only staff", async () => {
    const staff = world.tenants.alpha.users.workshop.id;
    const update = await c.alphaAdmin.from("user_profiles").update({ full_name: "Wendy Workshop" }).eq("id", staff).select("id");
    expect(update.error).toBeNull();
    expect(update.data).toEqual([{ id: staff }]);
    expect(await nameOf(staff)).toBe("Wendy Workshop");
    expect((await c.alphaAdmin.from("user_profiles").select("id").eq("id", staff)).data).toEqual([{ id: staff }]);
  });

  it("alpha's office can't change archive_after_months (the Settings screen's upsert); alpha's admin can", async () => {
    const upsert = (client: SupabaseClient, months: number) =>
      client.from("organization_settings").upsert({ organization_id: world.tenants.alpha.id, archive_after_months: months }, { onConflict: "organization_id" });
    expect((await upsert(c.alphaOffice, 3)).error).toMatchObject({ code: "42501" });
    expect((await upsert(c.alphaAdmin, 18)).error).toBeNull();
    expect((await upsert(c.alphaOffice, 3)).error).toMatchObject({ code: "42501" });
    expect((await service().from("organization_settings").select("archive_after_months").eq("organization_id", world.tenants.alpha.id).single()).data)
      .toEqual({ archive_after_months: 18 });
  });

  it("no signed-in user can execute ai_helper_settle; reserve's answer carries no key", async () => {
    await withDb(async (db) => {
      await db.query("insert into public.ai_helper_settings (organization_id, rfq_enabled, monthly_cap_pence) values ($1, true, 100)", [world.tenants.alpha.id]);
      await db.query("insert into public.ai_helper_secrets (organization_id, api_key_enc) values ($1, $2)", [world.tenants.alpha.id, KEY_ENC]);
    });
    const reserved = await c.alphaOffice.rpc("ai_helper_reserve", { p_feature: "rfq", p_estimate_pence: 1, p_input_digest: "d".repeat(64), p_input_bytes: 1 });
    expect(reserved.error).toBeNull();
    expect(Object.keys(reserved.data as Record<string, unknown>).sort()).toEqual(["ok", "request_id"]);
    expect(JSON.stringify(reserved.data)).not.toContain(KEY_ENC);
    const id = (reserved.data as { request_id: string }).request_id;
    for (const client of [c.alphaOffice, c.alphaAdmin, c.betaAdmin]) {
      const settled = await client.rpc("ai_helper_settle", { p_request: id, p_status: "suggested", p_failure: null, p_cost_pence: 0, p_model: "made-up", p_output: { kind: "rfq", lines: [] } });
      expect(settled.error).toMatchObject({ code: "42501" });
    }
    expect((await service().from("ai_helper_requests").select("status").eq("id", id).single()).data).toEqual({ status: "reserved" });
    // The server's service role settles it.
    expect((await service().rpc("ai_helper_settle", { p_request: id, p_status: "failed", p_failure: "unavailable", p_cost_pence: 0, p_model: null, p_output: null })).error).toBeNull();
    expect((await service().from("ai_helper_requests").select("status").eq("id", id).single()).data).toEqual({ status: "failed" });
  });

  it("the quote-attachments bucket is private", async () => {
    expect(await rows("select public from storage.buckets where id = 'quote-attachments'")).toEqual([{ public: false }]);
    const { data } = await service().storage.getBucket("quote-attachments");
    expect(data?.public).toBe(false);
  });
});

describe("102 release files on the local stack", () => {
  it("the verify script answers TRUE on every row", async () => {
    const result = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/security_guards_102.sql"))).rows);
    expect(result).toHaveLength(10);
    expect(result.filter((r) => !r.ok)).toEqual([]);
  });

  it("the rollback puts 058's, 012's, 007's and 101's objects back; the release then applies again, twice (all rolled back)", async () => {
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query(unwrapped(read("supabase/release/102_security_guards.rollback.sql")));
        const after = Object.fromEntries((await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/security_guards_102.sql"))).rows.map((r) => [r.check_name, r.ok]));
        expect(after).toMatchObject({ org_settings_guard_archive_admin_only: false, admin_update_policy_own_people_only: false, admin_may_edit_profile_signed_in_only: false,
          admin_read_policy_own_people_only: false, admin_may_read_profile_signed_in_only: false, user_profiles_guard_is_102: false, reserve_returns_no_key: false,
          settle_service_role_only: false, quote_attachments_private: true });
        expect((await db.query("select has_function_privilege('authenticated', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE') as v")).rows[0].v).toBe(true);
        // 101's own verify still passes on the rolled-back database.
        expect((await db.query<{ ok: boolean }>(read("supabase/verify/ai_helper_101.sql"))).rows.every((r) => r.ok)).toBe(true);
        await db.query(unwrapped(read("supabase/release/102_security_guards.release.sql")));
        expect((await db.query<{ ok: boolean }>(read("supabase/verify/security_guards_102.sql"))).rows.every((r) => r.ok)).toBe(true);
        await db.query(unwrapped(read("supabase/release/102_security_guards.release.sql")));
        expect((await db.query<{ ok: boolean }>(read("supabase/verify/security_guards_102.sql"))).rows.every((r) => r.ok)).toBe(true);
        // 101's verify passes with 102 applied too.
        expect((await db.query<{ ok: boolean }>(read("supabase/verify/ai_helper_101.sql"))).rows.every((r) => r.ok)).toBe(true);
      } finally {
        await db.query("rollback");
      }
    });
  });
});
