/**
 * The platform owner's "New company" in the database (migration 039): public.platform_create_organization(name, slug, admin e-mail),
 * through the real API path (Supabase Auth + PostgREST with the anon key and a signed-in synthetic user, as the route does with the
 * owner's own session).
 *
 *   * The platform owner at aal2 creates a company and exactly one PLATFORM_CREATE_ORGANIZATION audit row is written, in the new
 *     company's audit chain, which still verifies.
 *   * The owner at aal1 is refused with mfa_required; company users (admin, office, workshop, viewer), the service role and anon are
 *     refused; nothing is created and nothing is recorded for any of them.
 *   * A duplicate slug or an invalid e-mail leaves no company and no audit row. The company the owner's session is in (an ordinary
 *     viewer membership, or read-only support) does not stop them: the new company is not that company.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generatePassword } from "@/lib/password";

import { isolatedBackend, SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { enrolTotp, passSecondStep } from "../support/totp";
import { type SyntheticUser, type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, leftoverRows, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let owner: SyntheticUser;
let ownerFactor: { factorId: string; secret: string };

const sql = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, params)).rows);
const slugFor = (label: string) => `${SYNTHETIC_SLUG_PREFIX}${world.runId}-${label}`;
const companies = async (slug: string) => (await sql("select id from public.organizations where slug = $1", [slug])).length;
const auditRows = (slug: string) => sql<{ organization_id: string; actor_user_id: string; actor_email: string; entity_table: string; entity_id: string; metadata: Record<string, unknown> }>(
  "select organization_id, actor_user_id, actor_email, entity_table, entity_id, metadata from security_audit.audit_log where action = 'PLATFORM_CREATE_ORGANIZATION' and metadata ->> 'slug' = $1",
  [slug],
);
const create = (c: SupabaseClient, label: string, adminEmail = `first-admin.${world.runId}@example.test`) =>
  c.rpc("platform_create_organization", { p_name: `New Company ${label} ${world.runId}`, p_slug: slugFor(label), p_admin_email: adminEmail });

/** The owner's sign-in session after the second step (aal2). */
async function ownerAal2() {
  const c = await signedInClient(owner);
  await passSecondStep(c, ownerFactor.factorId, ownerFactor.secret);
  await c.auth.refreshSession();
  return c;
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  const email = `owner.${world.runId}@example.test`;
  const password = generatePassword(16);
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Owner Person" } });
  if (error || !data.user) throw new Error(`createUser owner: ${error?.message}`);
  owner = { id: data.user.id, email, password, role: "admin" };
  // A platform owner is a signed-in person with a profile: here from a viewer membership of one test company, as in two-level-access.
  expect((await adminClient().rpc("add_member", { p_org: world.tenants.alpha.id, p_email: email, p_role: "viewer" })).data).toBe("member");
  // The platform owner list is written by the database owner only (the SQL editor): that is what this does.
  await sql("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner (039)')", [owner.id]);
  ownerFactor = await enrolTotp(await signedInClient(owner));
});

afterAll(async () => {
  if (!world) return;
  await destroySyntheticWorld(world.runId);
  expect(await leftoverRows(world.runId)).toEqual({});
});

describe("platform_create_organization (039)", () => {
  it("the owner at aal2 creates a company and gets exactly one PLATFORM_CREATE_ORGANIZATION row: actor, slug, lower-cased e-mail", async () => {
    const c = await ownerAal2();
    const { data, error } = await create(c, "made", `  First-Admin.${world.runId}@Example.TEST `);
    expect(error).toBeNull();
    expect(typeof data).toBe("string");
    const org = data as string;
    expect(await sql("select name, status from public.organizations where id = $1 and slug = $2", [org, slugFor("made")])).toEqual([{ name: `New Company made ${world.runId}`, status: "active" }]);
    expect(await sql("select email, role from public.organization_invites where organization_id = $1", [org])).toEqual([{ email: `first-admin.${world.runId}@example.test`, role: "admin" }]);
    expect(await auditRows(slugFor("made"))).toEqual([
      {
        organization_id: org, actor_user_id: owner.id, actor_email: owner.email, entity_table: "organizations", entity_id: org,
        metadata: { source: "platform", slug: slugFor("made"), admin_email: `first-admin.${world.runId}@example.test` },
      },
    ]);
    expect(await sql("select count(*)::int as n from security_audit.audit_log where action = 'PLATFORM_CREATE_ORGANIZATION' and organization_id = $1", [org])).toEqual([{ n: 1 }]);
  });

  it("the new company's audit hash chain still verifies (every link and every hash recomputed)", async () => {
    const [{ id: org }] = await sql<{ id: string }>("select id from public.organizations where slug = $1", [slugFor("made")]);
    const result = await withDb(async (db) => {
      await db.query("begin");
      try {
        // set_audit_hash (006) hashes created_at::text; the stack runs in UTC.
        await db.query("set local timezone to 'UTC'");
        return (await db.query<{ total: number; broken_links: number; bad_hashes: number; platform_row_linked: boolean }>(`
          with r as (
            select a.*, lag(a.hash) over (order by a.created_at) as expected_previous
            from security_audit.audit_log a where a.organization_id = $1)
          select count(*)::int as total,
                 count(*) filter (where previous_hash is distinct from expected_previous)::int as broken_links,
                 count(*) filter (where hash is distinct from encode(extensions.digest(
                   coalesce(previous_hash, '') || coalesce(organization_id::text, '') || coalesce(actor_user_id::text, '') || action || entity_table ||
                   coalesce(entity_id, '') || coalesce(old_data::text, '') || coalesce(new_data::text, '') || coalesce(metadata::text, '') || created_at::text,
                   'sha256'), 'hex'))::int as bad_hashes,
                 bool_or(action = 'PLATFORM_CREATE_ORGANIZATION' and hash is not null) as platform_row_linked
          from r`, [org])).rows[0];
      } finally {
        await db.query("rollback");
      }
    });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result).toMatchObject({ broken_links: 0, bad_hashes: 0, platform_row_linked: true });
  });

  it("the owner at aal1 is refused with mfa_required, and nothing is created or recorded", async () => {
    const c = await signedInClient(owner);
    const { error } = await create(c, "aal1");
    expect(error).toMatchObject({ code: "42501", hint: "mfa_required" });
    expect(await companies(slugFor("aal1"))).toBe(0);
    expect(await auditRows(slugFor("aal1"))).toEqual([]);
  });

  for (const role of ["admin", "office", "workshop", "viewer"] as const) {
    it(`a company ${role} is refused (42501), and nothing is created or recorded`, async () => {
      const c = await signedInClient(world.tenants.alpha.users[role]);
      const { error } = await create(c, `by-${role}`);
      expect(error).toMatchObject({ code: "42501" });
      expect(error?.hint).not.toBe("mfa_required");
      expect(await companies(slugFor(`by-${role}`))).toBe(0);
      expect(await auditRows(slugFor(`by-${role}`))).toEqual([]);
    });
  }

  it("anon can't execute it, and the service role (no person) is refused too", async () => {
    const { apiUrl, anonKey } = isolatedBackend();
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const refused = await create(anon, "anon");
    expect(refused.error).toMatchObject({ code: "42501" });
    expect(await sql("select has_function_privilege('anon', 'public.platform_create_organization(text, text, text)', 'EXECUTE') as anon, has_function_privilege('authenticated', 'public.platform_create_organization(text, text, text)', 'EXECUTE') as authed")).toEqual([{ anon: false, authed: true }]);
    expect((await create(adminClient(), "service")).error).toMatchObject({ code: "42501" });
    expect(await companies(slugFor("anon"))).toBe(0);
    expect(await companies(slugFor("service"))).toBe(0);
    expect(await auditRows(slugFor("anon"))).toEqual([]);
    expect(await auditRows(slugFor("service"))).toEqual([]);
  });

  it("a duplicate slug is refused and leaves no second company and no second audit row", async () => {
    const c = await ownerAal2();
    expect((await create(c, "twice")).error).toBeNull();
    const again = await c.rpc("platform_create_organization", { p_name: `Another Name ${world.runId}`, p_slug: slugFor("twice"), p_admin_email: `other.${world.runId}@example.test` });
    expect(again.data).toBeNull();
    expect(again.error?.message).toMatch(/slug .* is already used/);
    expect(await companies(slugFor("twice"))).toBe(1);
    expect(await auditRows(slugFor("twice"))).toHaveLength(1);
  });

  it("an invalid admin e-mail is refused by create_organization and leaves no company and no audit row", async () => {
    const c = await ownerAal2();
    const { error } = await create(c, "bad-email", "not-an-email");
    expect(error?.message).toMatch(/valid admin e-mail/);
    expect(await companies(slugFor("bad-email"))).toBe(0);
    expect(await auditRows(slugFor("bad-email"))).toEqual([]);
  });

  it("restores the session's JWT claims exactly: the same text after the call as before it (one transaction, rolled back)", async () => {
    const c = await ownerAal2();
    const { data } = await c.auth.getSession();
    const claimsText = Buffer.from(data.session!.access_token.split(".")[1], "base64url").toString("utf8");
    const claims = JSON.parse(claimsText) as { aal?: string; sub?: string };
    expect(claims).toMatchObject({ aal: "aal2", sub: owner.id });
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [claimsText]);
        const original = (await db.query<{ v: string }>("select current_setting('request.jwt.claims', true) as v")).rows[0].v;
        expect(original).toBe(claimsText);
        const created = await db.query<{ id: string }>("select public.platform_create_organization($1, $2, $3) as id", [`New Company claims ${world.runId}`, slugFor("claims"), `claims.admin.${world.runId}@example.test`]);
        expect(created.rows[0].id).toEqual(expect.any(String));
        const after = (await db.query<{ v: string }>("select current_setting('request.jwt.claims', true) as v")).rows[0].v;
        expect(after).toBe(original);
      } finally {
        await db.query("rollback");
      }
    });
    expect(await companies(slugFor("claims"))).toBe(0);
    expect(await auditRows(slugFor("claims"))).toEqual([]);
  });

  it("the owner viewing a company as read-only support can still create one, recorded as them; the session's company is unchanged", async () => {
    const c = await ownerAal2();
    expect((await c.rpc("platform_enter_organization", { p_org: world.tenants.beta.id, p_reason: "Checking the new company audit (039 test)", p_hours: 1 })).error).toBeNull();
    // Nothing in the company being viewed (beta) may change because of the new company: same audit rows, settings and members before and after.
    const beta = world.tenants.beta.id;
    const betaCounts = async () => ({
      audit: (await sql<{ n: string }>("select count(*)::text as n from security_audit.audit_log where organization_id = $1", [beta]))[0].n,
      settings: (await sql<{ n: string }>("select count(*)::text as n from public.organization_settings where organization_id = $1", [beta]))[0].n,
      members: (await sql<{ n: string }>("select count(*)::text as n from public.organization_members where organization_id = $1", [beta]))[0].n,
    });
    const before = await betaCounts();
    const { data, error } = await create(c, "in-support");
    expect(error).toBeNull();
    expect(await betaCounts()).toEqual(before);
    expect(await auditRows(slugFor("in-support"))).toMatchObject([{ organization_id: data, actor_user_id: owner.id, actor_email: owner.email }]);
    expect((await c.rpc("current_user_organization_id")).data).toBe(world.tenants.beta.id);
    // Still read-only support in beta.
    expect((await c.rpc("session_read_only")).data).toBe(true);
    await c.rpc("platform_exit_organization");
  });
});
