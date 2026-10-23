/**
 * Migration 066: per-company access in Admin > Users.
 *
 *   - my_admin_companies(): only the companies where the caller is an active, non-support admin of an active company.
 *   - admin_company_access(p_user): that login's membership in those companies only.
 *   - admin_set_company_access(p_org, ...): the 036 safeguards checked against p_org (admin of p_org, p_org's second-step rule,
 *     last admin, no self-demotion or self-removal, support memberships untouched), plus "a login keeps at least one company";
 *     grant inserts or reactivates (065 flags an admin grant), removal only deactivates and moves the profile's current company;
 *     one audit row in p_org's own hash-chained log. Concurrent calls queue on row locks and the loser is refused.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), so it runs on the local stack and on a plain Postgres
 * rebuild with Supabase stand-ins. Each caller works in a chosen company (a session row, as the app's sign-in makes).
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { destroySyntheticWorld, setRequireAdminMfaForTest, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

async function makeOrg(db: Client, label: string, status = "active") {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, $4)",
    [id, `066 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-066-${label}-${counter}`, status]);
  return id;
}

/** A login (created on first use) with a membership in `org`; its profile's current company is the first one it is given. */
async function member(db: Client, org: string, p: Person, role: string, extra: { secondary?: string; active?: boolean; support?: boolean } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $2, $3, $4, true, false) on conflict (id) do nothing`, [p.id, p.email, role, org]);
  await db.query(
    `insert into public.organization_members (user_id, organization_id, role, secondary_role, active, support, expires_at, support_grant)
     values ($1, $2, $3, $4, $5, $6, case when $6 then now() + interval '2 hours' end, case when $6 then gen_random_uuid() end)`,
    [p.id, org, role, extra.secondary ?? null, extra.active ?? true, extra.support ?? false]);
}

/** The company this person's sign-in session works in (security_audit.session_company, as switch_organization writes it). */
async function choose(db: Client, p: Person, org: string) {
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

async function signIn(db: Client, p: Person, aal: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
    [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal, email: p.email, ...(p.session ? { session_id: p.session } : {}) }), p.id]);
}

/** Runs `fn` in a transaction as the signed-in `p`, then commits (default) or rolls back. */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>, opts: { aal?: string; keep?: boolean } = {}): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await signIn(db, p, opts.aal ?? "aal1");
      const result = await fn(db);
      await db.query(opts.keep === false ? "rollback" : "commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

type Access = { changed: boolean; action: string | null; role: string | null; secondary_role: string | null; active: boolean; was_active: boolean; mfa_enrolment_required: boolean };
const setAccess = (db: Client, org: string, user: string, args: { role?: string | null; secondary?: string | null; clear?: boolean; active?: boolean | null }) =>
  db.query<{ r: Access }>("select public.admin_set_company_access($1, $2, $3, $4, $5, $6) as r",
    [org, user, args.role ?? null, args.secondary ?? null, args.clear ?? false, args.active ?? null]).then((res) => res.rows[0].r);

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { code?: string; message: string; hint?: string };
  }
};

const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);
const membership = async (org: string, user: string) =>
  (await sql<{ role: string; secondary_role: string | null; active: boolean; support: boolean; mfa_enrolment_required: boolean }>(
    "select role, secondary_role, active, support, mfa_enrolment_required from public.organization_members where organization_id = $1 and user_id = $2", [org, user]))[0];
const auditRows = (org: string, user: string) =>
  sql<{ action: string; actor_user_id: string; organization_id: string; old_data: Record<string, unknown> | null; new_data: Record<string, unknown>; metadata: Record<string, unknown>; hash: string; previous_hash: string | null }>(
    `select action, actor_user_id, organization_id, old_data, new_data, metadata, hash, previous_hash from security_audit.audit_log
     where entity_table = 'user_profiles' and entity_id = $2 and action in ('GRANT_COMPANY_ACCESS', 'CHANGE_COMPANY_ROLE', 'REMOVE_COMPANY_ACCESS')
       and organization_id = $1 order by created_at`, [org, user]);

// JNR (A) and Marpet (B): `dual` administers both and works in A; `aAdmin` administers A only; `bAdmin` is B's other admin.
const W = { A: "", B: "", C: "", dual: person("dual"), aAdmin: person("a-admin"), bAdmin: person("b-admin"), cOffice: person("c-office") };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "jnr");
    W.B = await makeOrg(db, "marpet");
    W.C = await makeOrg(db, "other");
    await member(db, W.A, W.dual, "admin");
    await member(db, W.B, W.dual, "office", { secondary: "admin" });
    await member(db, W.C, W.dual, "office");
    await member(db, W.A, W.aAdmin, "admin");
    await member(db, W.B, W.bAdmin, "admin");
    await member(db, W.C, W.cOffice, "office");
    await choose(db, W.dual, W.A);
    await choose(db, W.aAdmin, W.A);
    await choose(db, W.bAdmin, W.B);
  });
});

afterAll(async () => {
  await destroySyntheticWorld(run);
});

async function waitForBlocked(db: Client, pid: number) {
  for (let i = 0; i < 250; i += 1) {
    if ((await db.query("select cardinality(pg_blocking_pids($1)) as n", [pid])).rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected the competing call to wait on a membership row lock");
}

describe("which companies an admin may manage", () => {
  it("my_admin_companies lists only active, non-support admin memberships of active companies", async () => {
    const extra = await withDb(async (db) => {
      const paused = await makeOrg(db, "paused", "paused");
      const idle = await makeOrg(db, "idle");
      const supported = await makeOrg(db, "supported");
      await member(db, paused, W.dual, "admin");
      await member(db, idle, W.dual, "admin", { active: false });
      await member(db, supported, W.dual, "admin", { support: true });
      return { paused, idle, supported };
    });
    const dual = await as(W.dual, async (db) => (await db.query("select organization_id, is_current from public.my_admin_companies()")).rows);
    expect(dual.map((r) => r.organization_id).sort()).toEqual([W.A, W.B].sort());
    expect(dual.find((r) => r.organization_id === W.A)?.is_current).toBe(true);
    expect(dual.find((r) => r.organization_id === W.B)?.is_current).toBe(false);
    for (const id of Object.values(extra)) expect(dual.map((r) => r.organization_id)).not.toContain(id);

    expect((await as(W.aAdmin, async (db) => (await db.query("select organization_id from public.my_admin_companies()")).rows)).map((r) => r.organization_id)).toEqual([W.A]);
    expect(await as(W.cOffice, async (db) => (await db.query("select * from public.my_admin_companies()")).rows)).toEqual([]);
    // A profile that must change its password manages nothing (014).
    await sql("update public.user_profiles set must_change_password = true where id = $1", [W.aAdmin.id]);
    expect(await as(W.aAdmin, async (db) => (await db.query("select * from public.my_admin_companies()")).rows)).toEqual([]);
    await sql("update public.user_profiles set must_change_password = false where id = $1", [W.aAdmin.id]);
  });

  it("anon can't call any of the three; authenticated can", async () => {
    const rows = await sql<{ fn: string; anon: boolean; authed: boolean; definer: boolean }>(
      `select p.proname as fn, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed, p.prosecdef as definer
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('my_admin_companies', 'admin_company_access', 'admin_set_company_access') order by 1`);
    expect(rows).toEqual([
      { fn: "admin_company_access", anon: false, authed: true, definer: true },
      { fn: "admin_set_company_access", anon: false, authed: true, definer: true },
      { fn: "my_admin_companies", anon: false, authed: true, definer: true },
    ]);
  });
});

describe("an admin of A only can't list or change B", () => {
  it("admin_company_access shows A only; granting or removing in B is refused and B is unchanged", async () => {
    const target = person("target-a");
    await withDb((db) => member(db, W.A, target, "office"));
    const seen = await as(W.aAdmin, async (db) => (await db.query("select organization_id from public.admin_company_access($1)", [W.bAdmin.id])).rows);
    expect(seen.map((r) => r.organization_id)).toEqual([W.A]);

    expect(await errorOf(as(W.aAdmin, (db) => setAccess(db, W.B, target.id, { role: "office", active: true }))))
      .toMatchObject({ code: "42501", hint: "not_company_admin" });
    expect(await errorOf(as(W.aAdmin, (db) => setAccess(db, W.B, W.bAdmin.id, { active: false }))))
      .toMatchObject({ code: "42501", hint: "not_company_admin" });
    // Someone who is only office in a company can't change anyone there.
    expect(await errorOf(as(W.cOffice, (db) => setAccess(db, W.C, W.dual.id, { active: false }))))
      .toMatchObject({ code: "42501", hint: "not_company_admin" });
    expect(await membership(W.B, target.id)).toBeUndefined();
    expect((await membership(W.B, W.bAdmin.id)).active).toBe(true);
  });
});

describe("an admin of both grants, changes and removes access in B", () => {
  it("grant inserts an ordinary membership, change updates the role, removal only deactivates; each is audited in B's chain", async () => {
    const target = person("target-both");
    await withDb((db) => member(db, W.A, target, "workshop"));

    const granted = await as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "office", secondary: "workshop", active: true }));
    expect(granted).toMatchObject({ changed: true, action: "GRANT_COMPANY_ACCESS", role: "office", secondary_role: "workshop", active: true, was_active: false, reactivated: false });
    expect(await membership(W.B, target.id)).toMatchObject({ role: "office", secondary_role: "workshop", active: true, support: false });

    const listed = await as(W.dual, async (db) => (await db.query("select organization_id, member, role, active from public.admin_company_access($1)", [target.id])).rows);
    expect(listed.find((r) => r.organization_id === W.B)).toMatchObject({ member: true, role: "office", active: true });

    expect(await as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "viewer", clear: true })))
      .toMatchObject({ changed: true, action: "CHANGE_COMPANY_ROLE", role: "viewer", secondary_role: null, active: true });
    // The same again changes nothing and records nothing.
    expect(await as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "viewer" }))).toMatchObject({ changed: false, action: null });

    expect(await as(W.dual, (db) => setAccess(db, W.B, target.id, { active: false })))
      .toMatchObject({ changed: true, action: "REMOVE_COMPANY_ACCESS", role: "viewer", active: false, was_active: true });
    // Deactivated, never deleted.
    expect(await membership(W.B, target.id)).toMatchObject({ role: "viewer", active: false });
    // Reactivating is a grant again.
    expect(await as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "office", active: true }))).toMatchObject({ action: "GRANT_COMPANY_ACCESS", role: "office", reactivated: true });

    const audit = await auditRows(W.B, target.id);
    expect(audit.map((a) => a.action)).toEqual(["GRANT_COMPANY_ACCESS", "CHANGE_COMPANY_ROLE", "REMOVE_COMPANY_ACCESS", "GRANT_COMPANY_ACCESS"]);
    expect(audit.every((a) => a.organization_id === W.B && a.actor_user_id === W.dual.id && a.metadata.source === "company_access" && a.metadata.session_organization_id === W.A)).toBe(true);
    expect(audit[0].old_data).toBeNull();
    expect(audit[0].new_data).toEqual({ role: "office", secondary_role: "workshop", active: true });
    expect(audit[2].old_data).toEqual({ role: "viewer", secondary_role: null, active: true });
    expect(audit[2].new_data).toEqual({ role: "viewer", secondary_role: null, active: false });
    // Chained in B's log: every row has a hash and points at B's previous row.
    for (let i = 1; i < audit.length; i += 1) expect(audit[i].previous_hash).toBe(audit[i - 1].hash);
    // None of it landed in the session's company (A).
    expect(await auditRows(W.A, target.id)).toEqual([]);
  });

  it("write_audit refuses the three action names from a client: only the function writes them", async () => {
    for (const action of ["GRANT_COMPANY_ACCESS", "CHANGE_COMPANY_ROLE", "REMOVE_COMPANY_ACCESS"]) {
      expect(await errorOf(as(W.dual, (db) => db.query("select public.write_audit($1, 'user_profiles', $2, null, null, '{}'::jsonb, null, null)", [action, W.aAdmin.id]))))
        .toMatchObject({ code: "42501" });
    }
  });
});

describe("B's second-step rule", () => {
  it("B requires admin MFA: refused at aal1 (whatever the session's company says), allowed at aal2", async () => {
    const target = person("target-mfa");
    await withDb((db) => member(db, W.A, target, "office"));
    await setRequireAdminMfaForTest(W.B, true);
    try {
      expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "office", active: true }))))
        .toMatchObject({ code: "42501", hint: "mfa_required" });
      expect(await membership(W.B, target.id)).toBeUndefined();
      expect(await as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "office", active: true }), { aal: "aal2" })).toMatchObject({ changed: true });
    } finally {
      await setRequireAdminMfaForTest(W.B, false);
    }
  });

  it("the session company's own rule still applies (033)", async () => {
    const target = person("target-mfa-a");
    await withDb((db) => member(db, W.A, target, "office"));
    await setRequireAdminMfaForTest(W.A, true);
    try {
      expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "office", active: true }))))
        .toMatchObject({ code: "42501", hint: "mfa_required" });
    } finally {
      await setRequireAdminMfaForTest(W.A, false);
    }
  });
});

describe("the safeguards, against B", () => {
  it("the last active admin of B can't be demoted or removed", async () => {
    const solo = await withDb((db) => makeOrg(db, "solo"));
    const admin = person("solo-admin");
    await withDb(async (db) => {
      await member(db, W.A, admin, "admin");
      await member(db, solo, admin, "admin");
      await choose(db, admin, W.A);
    });
    expect(await errorOf(as(admin, (db) => setAccess(db, solo, admin.id, { role: "office" })))).toMatchObject({ code: "23514", hint: "last_admin" });
    expect(await errorOf(as(admin, (db) => setAccess(db, solo, admin.id, { active: false })))).toMatchObject({ code: "23514", hint: "last_admin" });
    expect(await membership(solo, admin.id)).toMatchObject({ role: "admin", active: true });
  });

  it("nobody removes their own access or their own admin rights, even with another admin present", async () => {
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, W.dual.id, { clear: true })))).toMatchObject({ code: "23514", hint: "self_demotion" });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, W.dual.id, { active: false })))).toMatchObject({ code: "23514", hint: "self_removal" });
    expect(await membership(W.B, W.dual.id)).toMatchObject({ role: "office", secondary_role: "admin", active: true });
  });

  it("a login's last active company can't be removed (a membership in a paused company doesn't count)", async () => {
    const only = person("only-b");
    const suspended = await withDb(async (db) => {
      await member(db, W.B, only, "office");
      const s = await makeOrg(db, "gone", "paused");
      await member(db, s, only, "office");
      return s;
    });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, only.id, { active: false })))).toMatchObject({ code: "23514", hint: "last_company" });
    expect((await membership(W.B, only.id)).active).toBe(true);
    expect((await membership(suspended, only.id)).active).toBe(true);
  });

  it("a support membership is never changed here, and a support session manages nothing", async () => {
    const owner = person("owner");
    await withDb(async (db) => {
      await member(db, W.A, owner, "office");
      await member(db, W.B, owner, "admin", { support: true });
    });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, owner.id, { active: false })))).toMatchObject({ code: "42501", hint: "support_membership" });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, owner.id, { role: "office", active: true })))).toMatchObject({ code: "42501", hint: "support_membership" });
    expect(await membership(W.B, owner.id)).toMatchObject({ support: true, active: true, role: "admin" });
    // As support in B (platform owner, aal2, support membership chosen for the session): nothing to manage, every change refused.
    await withDb(async (db) => {
      await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [owner.id]);
      await choose(db, owner, W.B);
      await db.query("update security_audit.session_company set grant_id = (select support_grant from public.organization_members where user_id = $1 and organization_id = $2) where session_id = $3", [owner.id, W.B, owner.session]);
    });
    expect(await as(owner, async (db) => (await db.query("select * from public.my_admin_companies()")).rows, { aal: "aal2" })).toEqual([]);
    expect(await errorOf(as(owner, (db) => setAccess(db, W.B, W.bAdmin.id, { role: "office" }), { aal: "aal2" }))).toMatchObject({ code: "42501" });
  });

  it("invalid input is refused before anything is written", async () => {
    const target = person("target-input");
    await withDb((db) => member(db, W.A, target, "office"));
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "owner", active: true })))).toMatchObject({ code: "22023" });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, target.id, { active: true })))).toMatchObject({ code: "22023" });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, target.id, { role: "office" })))).toMatchObject({ code: "22023" });
    // No login at all: the same refusal as a login that isn't one of the caller's people (no existence oracle).
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, randomUUID(), { role: "office", active: true })))).toMatchObject({ code: "42501", hint: "unknown_login" });
    expect(await as(W.dual, (db) => setAccess(db, W.B, target.id, { active: false }))).toMatchObject({ changed: false, active: false });
    expect(await membership(W.B, target.id)).toBeUndefined();
  });
});

describe("065 enrolment and the profile's current company", () => {
  it("granting admin in B flags someone with no verified factor; an enrolled person is not flagged", async () => {
    const fresh = person("fresh-admin");
    const enrolled = person("enrolled-admin");
    await withDb(async (db) => {
      await member(db, W.A, fresh, "office");
      await member(db, W.A, enrolled, "office");
      await db.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'test', 'totp', 'verified', now(), now())", [randomUUID(), enrolled.id]);
    });
    expect(await as(W.dual, (db) => setAccess(db, W.B, fresh.id, { role: "admin", active: true }))).toMatchObject({ mfa_enrolment_required: true });
    expect((await membership(W.B, fresh.id)).mfa_enrolment_required).toBe(true);
    expect(await as(W.dual, (db) => setAccess(db, W.B, enrolled.id, { role: "office", secondary: "admin", active: true }))).toMatchObject({ mfa_enrolment_required: false });
    // Losing admin clears it.
    await as(W.dual, (db) => setAccess(db, W.B, fresh.id, { role: "office" }));
    expect((await membership(W.B, fresh.id)).mfa_enrolment_required).toBe(false);
  });

  it("removing the profile's current company moves it to another active company; the B row stays, switched off", async () => {
    const mover = person("mover");
    await withDb(async (db) => {
      await member(db, W.B, mover, "viewer");
      await member(db, W.A, mover, "workshop");
    });
    expect((await sql<{ organization_id: string }>("select organization_id from public.user_profiles where id = $1", [mover.id]))[0].organization_id).toBe(W.B);
    await as(W.dual, (db) => setAccess(db, W.B, mover.id, { active: false }));
    expect(await membership(W.B, mover.id)).toMatchObject({ active: false, role: "viewer" });
    expect((await sql("select organization_id, role from public.user_profiles where id = $1", [mover.id]))[0]).toEqual({ organization_id: W.A, role: "workshop" });
  });
});

describe("only the caller's own people: no oracle, nobody pulled in", () => {
  type Refusal = { code?: string; hint?: string; message: string } | null;
  const shape = (e: Refusal) => e && { code: e.code, hint: e.hint, message: e.message };

  it("a B-only login, a platform owner and a login that doesn't exist all get the same refusal from an admin of A; nothing is written", async () => {
    const bOnly = person("b-only");
    const owner = person("platform-owner");
    await withDb(async (db) => {
      await member(db, W.B, bOnly, "office");
      // A platform owner with an ordinary membership in C only (none in A).
      await member(db, W.C, owner, "admin");
      await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [owner.id]);
    });
    const ghost = randomUUID();
    const refusals: Refusal[] = [];
    for (const id of [bOnly.id, owner.id, ghost]) {
      for (const args of [{ role: "admin", active: true }, { role: "office", active: true }, { active: false }, { role: "viewer" }]) {
        refusals.push(await errorOf(as(W.aAdmin, (db) => setAccess(db, W.A, id, args))));
      }
    }
    expect(refusals[0]).toMatchObject({ code: "42501", hint: "unknown_login" });
    for (const r of refusals) expect(shape(r)).toEqual(shape(refusals[0]));
    expect(await membership(W.A, bOnly.id)).toBeUndefined();
    expect(await membership(W.A, owner.id)).toBeUndefined();
    expect(await membership(W.A, ghost)).toBeUndefined();
    expect(await auditRows(W.A, bOnly.id)).toEqual([]);
    expect(await auditRows(W.A, owner.id)).toEqual([]);
  });

  it("admin_company_access answers the same for a B-only login, a platform owner and a login that doesn't exist", async () => {
    const bOnly = person("b-only-read");
    const owner = person("platform-owner-read");
    await withDb(async (db) => {
      await member(db, W.B, bOnly, "admin", { secondary: "office" });
      await member(db, W.C, owner, "admin");
      await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [owner.id]);
    });
    const read = (id: string) => as(W.aAdmin, async (db) => (await db.query("select * from public.admin_company_access($1)", [id])).rows);
    const ghost = await read(randomUUID());
    expect(ghost).toEqual([expect.objectContaining({ organization_id: W.A, member: false, role: null, secondary_role: null, active: false, support: false })]);
    expect(await read(bOnly.id)).toEqual(ghost);
    expect(await read(owner.id)).toEqual(ghost);
  });

  it("a membership where the caller is not an admin, or a support membership, is no link; a switched-off ordinary membership is", async () => {
    const cOnly = person("c-only");
    const supportOnly = person("support-only");
    const former = person("former");
    await withDb(async (db) => {
      await member(db, W.C, cOnly, "office");
      await member(db, W.C, supportOnly, "office");
      await member(db, W.A, supportOnly, "admin", { support: true });
      await member(db, W.A, former, "workshop", { active: false });
    });
    // dual is only office in C: C's people are not dual's to pull into B. A support membership in A is no link either.
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, cOnly.id, { role: "office", active: true })))).toMatchObject({ code: "42501", hint: "unknown_login" });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, supportOnly.id, { role: "office", active: true })))).toMatchObject({ code: "42501", hint: "unknown_login" });
    expect(await membership(W.B, cOnly.id)).toBeUndefined();
    expect(await membership(W.B, supportOnly.id)).toBeUndefined();
    // A former member of A (switched off there) is still one of A's people: dual may give them B (a new membership, not a reactivation).
    expect(await as(W.dual, (db) => setAccess(db, W.B, former.id, { role: "office", active: true }))).toMatchObject({ changed: true, action: "GRANT_COMPANY_ACCESS", reactivated: false });
  });
});

describe("a login that also belongs to a company the caller doesn't administer can't be granted or switched back on", () => {
  const OTHER = { code: "42501", hint: "other_company_login", message: "This login belongs to another company. An admin of that company must add it." };

  it("an admin of B (and D) only: a login also in A is refused, a grant in D and a reactivation in B; nothing is written", async () => {
    const shared = person("shared-ab");
    const D = await withDb((db) => makeOrg(db, "marpet-two"));
    await withDb(async (db) => {
      await member(db, W.A, shared, "workshop");
      await member(db, W.B, shared, "workshop", { active: false });
      await member(db, D, W.bAdmin, "admin");
    });
    // A new membership in D would make A's login shared with D.
    expect(await errorOf(as(W.bAdmin, (db) => setAccess(db, D, shared.id, { role: "office", active: true })))).toMatchObject(OTHER);
    // Switching B's switched-off membership back on is refused too.
    expect(await errorOf(as(W.bAdmin, (db) => setAccess(db, W.B, shared.id, { active: true })))).toMatchObject(OTHER);
    expect(await membership(D, shared.id)).toBeUndefined();
    expect((await membership(W.B, shared.id)).active).toBe(false);
    expect(await auditRows(D, shared.id)).toEqual([]);
    expect(await auditRows(W.B, shared.id)).toEqual([]);
    // Removing or changing an existing, active membership is not adding: B's admin may still switch it off again later.
    expect(await as(W.dual, (db) => setAccess(db, W.B, shared.id, { active: true }))).toMatchObject({ changed: true, reactivated: true });
    expect(await as(W.bAdmin, (db) => setAccess(db, W.B, shared.id, { role: "viewer" }))).toMatchObject({ changed: true, action: "CHANGE_COMPANY_ROLE" });
    expect(await as(W.bAdmin, (db) => setAccess(db, W.B, shared.id, { active: false }))).toMatchObject({ changed: true, action: "REMOVE_COMPANY_ACCESS" });
  });

  it("an admin of every company the login is in may grant and reactivate it (an admin of both A and B)", async () => {
    const charlie = person("charlie-a");
    await withDb((db) => member(db, W.A, charlie, "workshop"));
    expect(await as(W.dual, (db) => setAccess(db, W.B, charlie.id, { role: "workshop", active: true }))).toMatchObject({ changed: true, action: "GRANT_COMPANY_ACCESS" });
    expect(await as(W.dual, (db) => setAccess(db, W.B, charlie.id, { active: false }))).toMatchObject({ changed: true, action: "REMOVE_COMPANY_ACCESS" });
    expect(await as(W.dual, (db) => setAccess(db, W.B, charlie.id, { active: true }))).toMatchObject({ changed: true, reactivated: true });
  });

  it("a membership where the caller is only office (not admin) counts as another company's", async () => {
    const aAndC = person("a-and-c");
    await withDb(async (db) => {
      await member(db, W.A, aAndC, "workshop");
      await member(db, W.C, aAndC, "office");
    });
    // dual administers A and B but is only office in C.
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.B, aAndC.id, { role: "office", active: true })))).toMatchObject(OTHER);
    expect(await membership(W.B, aAndC.id)).toBeUndefined();
  });
});

describe("Deactivate on the session's company (set_member_access) keeps a login's last company too", () => {
  const deactivate = (db: Client, user: string) => db.query("select public.set_member_access($1, p_active => false)", [user]);

  it("switching off someone's only company is refused (23514, hint last_company); the membership stays on", async () => {
    const only = person("only-a");
    const paused = await withDb(async (db) => {
      await member(db, W.A, only, "office");
      // Neither a paused company nor a support membership counts as another company.
      const p = await makeOrg(db, "paused-sma", "paused");
      await member(db, p, only, "office");
      await member(db, W.B, only, "admin", { support: true });
      return p;
    });
    expect(await errorOf(as(W.aAdmin, (db) => deactivate(db, only.id))))
      .toMatchObject({ code: "23514", hint: "last_company", message: "This login must keep access to at least one company" });
    expect(await membership(W.A, only.id)).toMatchObject({ active: true, role: "office" });
    expect((await membership(paused, only.id)).active).toBe(true);
    // From 093 a login with a support membership (here the one in B) is never changed from Admin > Users except switched off: a role
    // change is refused (protected_login) and the membership stays as it was.
    expect(await errorOf(as(W.aAdmin, (db) => db.query("select public.set_member_access($1, 'viewer')", [only.id]))))
      .toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await membership(W.A, only.id)).toMatchObject({ active: true, role: "office" });
  });

  it("switching off one of two companies still works, and the profile moves to the other one", async () => {
    const two = person("two-companies");
    await withDb(async (db) => {
      await member(db, W.A, two, "office");
      await member(db, W.B, two, "workshop");
    });
    await as(W.aAdmin, (db) => deactivate(db, two.id));
    expect(await membership(W.A, two.id)).toMatchObject({ active: false, role: "office" });
    expect((await sql("select organization_id, role from public.user_profiles where id = $1", [two.id]))[0]).toEqual({ organization_id: W.B, role: "workshop" });
    // B is now their last company: B's admin can't switch it off. Once A is back on, B can be.
    expect(await errorOf(as(W.bAdmin, (db) => deactivate(db, two.id)))).toMatchObject({ code: "23514", hint: "last_company" });
    await as(W.aAdmin, (db) => db.query("select public.set_member_access($1, p_active => true)", [two.id]));
    await as(W.bAdmin, (db) => deactivate(db, two.id));
    expect((await membership(W.B, two.id)).active).toBe(false);
    expect((await membership(W.A, two.id)).active).toBe(true);
  });

  it("a support membership can still be switched off by the company's admin", async () => {
    const owner = person("owner-sma");
    const home = await withDb(async (db) => {
      const p = await makeOrg(db, "owner-home", "paused");
      await member(db, p, owner, "admin");
      await member(db, W.A, owner, "admin", { support: true });
      return p;
    });
    await as(W.aAdmin, (db) => deactivate(db, owner.id));
    expect(await membership(W.A, owner.id)).toMatchObject({ support: true, active: false });
    expect((await membership(home, owner.id)).active).toBe(true);
  });

  it("the 036 rules are unchanged: no self-deactivation, no self-demotion; another admin is demoted and switched off as before", async () => {
    expect(await errorOf(as(W.aAdmin, (db) => deactivate(db, W.aAdmin.id)))).toMatchObject({ code: "23514", message: "You cannot deactivate your own access" });
    expect(await errorOf(as(W.bAdmin, (db) => db.query("select public.set_member_access($1, 'office')", [W.bAdmin.id]))))
      .toMatchObject({ code: "23514", message: "You cannot remove your own admin rights" });
    const solo = await withDb((db) => makeOrg(db, "solo-sma"));
    const lone = person("lone-admin");
    const boss = person("boss-admin");
    await withDb(async (db) => {
      await member(db, solo, lone, "admin");
      await member(db, W.C, lone, "office");
      await member(db, solo, boss, "admin");
      await member(db, W.C, boss, "office");
      await choose(db, boss, solo);
    });
    // boss demotes lone (boss stays admin).
    await as(boss, (db) => db.query("select public.set_member_access($1, 'office')", [lone.id]));
    expect(await membership(solo, lone.id)).toMatchObject({ role: "office", active: true });
    // Switching lone off in solo leaves them C, so the last-company rule allows it.
    await as(boss, (db) => deactivate(db, lone.id));
    expect((await membership(solo, lone.id)).active).toBe(false);
  });

  it("two admins switching off the same login's last two companies at once: the second waits, then is refused", async () => {
    const shared = person("shared-sma");
    await withDb(async (db) => {
      await member(db, W.A, shared, "office");
      await member(db, W.B, shared, "office");
    });
    await withDb(async (a) => withDb(async (b) => {
      await b.query("set statement_timeout = '10s'");
      const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
      await a.query("begin");
      await b.query("begin");
      try {
        await signIn(a, W.aAdmin, "aal1");
        await signIn(b, W.bAdmin, "aal1");
        await deactivate(a, shared.id);
        const second = errorOf(deactivate(b, shared.id));
        await waitForBlocked(a, pid);
        await a.query("commit");
        expect(await second).toMatchObject({ code: "23514", hint: "last_company" });
      } finally {
        await a.query("rollback").catch(() => undefined);
        await b.query("rollback").catch(() => undefined);
      }
    }));
    expect((await membership(W.A, shared.id)).active).toBe(false);
    expect((await membership(W.B, shared.id)).active).toBe(true);
  });

  it("admin_set_company_access and set_member_access racing on the same login: the second waits, then is refused", async () => {
    const shared = person("shared-mixed");
    await withDb(async (db) => {
      await member(db, W.A, shared, "office");
      await member(db, W.B, shared, "office");
    });
    await withDb(async (a) => withDb(async (b) => {
      await b.query("set statement_timeout = '10s'");
      const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
      await a.query("begin");
      await b.query("begin");
      try {
        await signIn(a, W.dual, "aal1");
        await signIn(b, W.aAdmin, "aal1");
        await setAccess(a, W.B, shared.id, { active: false });
        const second = errorOf(deactivate(b, shared.id));
        await waitForBlocked(a, pid);
        await a.query("commit");
        expect(await second).toMatchObject({ code: "23514", hint: "last_company" });
      } finally {
        await a.query("rollback").catch(() => undefined);
        await b.query("rollback").catch(() => undefined);
      }
    }));
    expect((await membership(W.B, shared.id)).active).toBe(false);
    expect((await membership(W.A, shared.id)).active).toBe(true);
  });
});

describe("concurrent changes queue on row locks; the loser is refused", () => {

  it("two admins removing the same login's last two companies at once: one wins, the other is refused (last_company)", async () => {
    const shared = person("shared");
    await withDb(async (db) => {
      await member(db, W.A, shared, "office");
      await member(db, W.B, shared, "office");
    });
    await withDb(async (a) => withDb(async (b) => {
      await b.query("set statement_timeout = '10s'");
      const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
      await a.query("begin");
      await b.query("begin");
      try {
        await signIn(a, W.aAdmin, "aal1");
        await signIn(b, W.bAdmin, "aal1");
        await setAccess(a, W.A, shared.id, { active: false });
        const second = errorOf(setAccess(b, W.B, shared.id, { active: false }));
        await waitForBlocked(a, pid);
        await a.query("commit");
        expect(await second).toMatchObject({ code: "23514", hint: "last_company" });
      } finally {
        await a.query("rollback").catch(() => undefined);
        await b.query("rollback").catch(() => undefined);
      }
    }));
    expect((await membership(W.A, shared.id)).active).toBe(false);
    expect((await membership(W.B, shared.id)).active).toBe(true);
  });

  it("two admins of B demoting each other at once: the second, no longer an admin, is refused", async () => {
    const x = person("x-admin");
    const y = person("y-admin");
    const org = await withDb(async (db) => {
      const o = await makeOrg(db, "pair");
      for (const p of [x, y]) {
        await member(db, W.A, p, "office");
        await member(db, o, p, "admin");
        await choose(db, p, W.A);
      }
      return o;
    });
    await withDb(async (a) => withDb(async (b) => {
      await b.query("set statement_timeout = '10s'");
      const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
      await a.query("begin");
      await b.query("begin");
      try {
        await signIn(a, x, "aal1");
        await signIn(b, y, "aal1");
        await setAccess(a, org, y.id, { role: "office" });
        const second = errorOf(setAccess(b, org, x.id, { role: "office" }));
        await waitForBlocked(a, pid);
        await a.query("commit");
        expect(await second).toMatchObject({ code: "42501", hint: "not_company_admin" });
      } finally {
        await a.query("rollback").catch(() => undefined);
        await b.query("rollback").catch(() => undefined);
      }
    }));
    expect(await membership(org, x.id)).toMatchObject({ role: "admin", active: true });
    expect(await membership(org, y.id)).toMatchObject({ role: "office", active: true });
  });
});
