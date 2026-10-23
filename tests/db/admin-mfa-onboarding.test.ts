/**
 * Migration 065: admin two-step sign-in onboarding, in the database.
 *
 *   - organizations.require_admin_mfa can't be turned on while any active admin of that company (role or second role) has no
 *     verified authenticator factor, whoever tries (database owner, service role); turning it off always works.
 *   - Being given admin by another admin sets organization_members.mfa_enrolment_required (unless already enrolled); losing
 *     admin clears it; a signed-in session can't clear it.
 *   - Promoting a not-yet-enrolled person while the rule is on is allowed (flagged; the 033 rule refuses them at aal1 anyway).
 *   - admin_mfa_overview(): admins only, own company only. my_mfa_enrolment_required(): never TRUE for the last usable admin.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), so it runs on the local stack and on a plain Postgres
 * rebuild with Supabase stand-ins. Factors are rows in auth.mfa_factors, as the Auth service writes them.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { destroySyntheticWorld, setRequireAdminMfaForTest, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
type Person = { id: string; email: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}.${run}@example.test` });
const alpha = { id: randomUUID(), admin: person("a-admin"), office: person("a-office"), second: person("a-second"), idle: person("a-idle") };
const beta = { id: randomUUID(), admin: person("b-admin"), office: person("b-office") };

async function addPerson(db: Client, org: string, p: Person, role: string, extra: { secondary?: string; active?: boolean } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $2, $3, $4, true, false)
     on conflict (id) do update set email = excluded.email, role = excluded.role, organization_id = excluded.organization_id, active = true, must_change_password = false`,
    [p.id, p.email, role, org]);
  await db.query(
    "insert into public.organization_members (user_id, organization_id, role, secondary_role, active) values ($1, $2, $3, $4, $5)",
    [p.id, org, role, extra.secondary ?? null, extra.active ?? true]);
}

const enrol = (db: Client, p: Person, status: "verified" | "unverified" = "verified") =>
  db.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, $3, 'totp', $4, now(), now())",
    [randomUUID(), p.id, `test-${status}-${randomUUID().slice(0, 6)}`, status]);
const unenrol = (db: Client, p: Person) => db.query("delete from auth.mfa_factors where user_id = $1", [p.id]);

/** Runs `fn` inside a transaction as the signed-in `p` (role authenticated), then rolls back unless `keep`. */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>, opts: { aal?: string; keep?: boolean } = {}): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: opts.aal ?? "aal1" }), p.id]);
      const result = await fn(db);
      await db.query(opts.keep ? "commit" : "rollback");
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

const flag = async (p: Person, org = alpha.id) =>
  withDb(async (db) => (await db.query("select mfa_enrolment_required as f from public.organization_members where user_id = $1 and organization_id = $2", [p.id, org])).rows[0]?.f as boolean);
const setRule = (org: string, on: boolean) => withDb((db) => db.query("update public.organizations set require_admin_mfa = $2 where id = $1", [org, on]));

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    for (const [org, name] of [[alpha.id, "alpha"], [beta.id, "beta"]]) {
      await db.query("insert into public.organizations (id, name, slug) values ($1, $2, $3)", [org, `065 ${name} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-065-${name}`]);
    }
    await addPerson(db, alpha.id, alpha.admin, "admin");
    await addPerson(db, alpha.id, alpha.office, "office");
    await addPerson(db, alpha.id, alpha.second, "office", { secondary: "admin" });
    await addPerson(db, alpha.id, alpha.idle, "admin", { active: false });
    // Also in beta, so switching alpha off again below never removes their last company (066).
    await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, 'office', true)", [alpha.idle.id, beta.id]);
    await addPerson(db, beta.id, beta.admin, "admin");
    await addPerson(db, beta.id, beta.office, "office");
  });
});

afterAll(async () => {
  await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = any($1)", [[alpha.id, beta.id]]));
  await destroySyntheticWorld(run);
});

describe("the company rule can't turn on while an admin has not enrolled", () => {
  it("refuses while any active admin (role or second role) has no verified factor, naming them; inactive admins and non-admins don't count", async () => {
    let error = await errorOf(setRule(alpha.id, true));
    expect(error).toMatchObject({ code: "23514", hint: "admins_not_enrolled" });
    expect(error!.message).toContain(alpha.admin.email);
    expect(error!.message).toContain(alpha.second.email);
    expect(error!.message).not.toContain(alpha.idle.email);
    expect(error!.message).not.toContain(alpha.office.email);

    // An unverified (abandoned) set-up is not enrolment.
    await withDb(async (db) => {
      await enrol(db, alpha.admin);
      await enrol(db, alpha.second, "unverified");
    });
    error = await errorOf(setRule(alpha.id, true));
    expect(error).toMatchObject({ code: "23514" });
    expect(error!.message).toContain(alpha.second.email);
    expect(error!.message).not.toContain(alpha.admin.email);
  });

  it("the service role is refused the same way", async () => {
    const error = await errorOf(withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role service_role");
        await db.query("update public.organizations set require_admin_mfa = true where id = $1", [alpha.id]);
      } finally {
        await db.query("rollback");
      }
    }));
    expect(error).toMatchObject({ code: "23514", hint: "admins_not_enrolled" });
  });

  it("turns on once every admin has enrolled; turning off is never refused; another company is unaffected", async () => {
    await withDb((db) => enrol(db, alpha.second));
    expect(await errorOf(setRule(alpha.id, true))).toBeNull();
    expect(await errorOf(setRule(beta.id, true))).toMatchObject({ code: "23514" });
    await withDb((db) => unenrol(db, alpha.second));
    // Already on: changing other columns, or turning it off, is not checked again.
    expect(await errorOf(withDb((db) => db.query("update public.organizations set name = name where id = $1", [alpha.id])))).toBeNull();
    expect(await errorOf(setRule(alpha.id, false))).toBeNull();
    expect(await errorOf(setRule(alpha.id, true))).toMatchObject({ code: "23514" });
    await withDb((db) => enrol(db, alpha.second));
    expect(await errorOf(setRule(alpha.id, true))).toBeNull();
    await setRule(alpha.id, false);
  });

  it("no setting skips the check; only the test fixture's replica-mode transaction (triggers off) gets past it", async () => {
    const skipped = await errorOf(withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local tolra.skip_admin_enrolment_check = 'on'");
        await db.query("update public.organizations set require_admin_mfa = true where id = $1", [beta.id]);
      } finally {
        await db.query("rollback");
      }
    }));
    expect(skipped).toMatchObject({ code: "23514" });
    await setRequireAdminMfaForTest(beta.id, true);
    expect((await withDb((db) => db.query("select require_admin_mfa as r from public.organizations where id = $1", [beta.id]))).rows[0].r).toBe(true);
    await setRule(beta.id, false);
    expect(await errorOf(setRule(beta.id, true))).toMatchObject({ code: "23514" });
  });
});

describe("enrolment required when someone is given admin", () => {
  it("promoting a person who has not enrolled flags them; losing admin clears it; an enrolled person is not flagged", async () => {
    expect(await flag(alpha.office)).toBe(false);
    await as(alpha.admin, (db) => db.query("select public.set_member_access($1, 'admin')", [alpha.office.id]), { keep: true });
    expect(await flag(alpha.office)).toBe(true);
    // Another change while still admin keeps it.
    await as(alpha.admin, (db) => db.query("select public.set_member_access($1, p_hidden_sections => '{}'::text[])", [alpha.office.id]), { keep: true });
    expect(await flag(alpha.office)).toBe(true);
    await as(alpha.admin, (db) => db.query("select public.set_member_access($1, 'office')", [alpha.office.id]), { keep: true });
    expect(await flag(alpha.office)).toBe(false);

    // Second role admin, already enrolled: not flagged.
    await withDb((db) => enrol(db, alpha.office));
    await as(alpha.admin, (db) => db.query("select public.set_member_access($1, p_secondary_role => 'admin')", [alpha.office.id]), { keep: true });
    expect(await flag(alpha.office)).toBe(false);
    await as(alpha.admin, (db) => db.query("select public.set_member_access($1, p_clear_secondary => true)", [alpha.office.id]), { keep: true });
    await withDb((db) => unenrol(db, alpha.office));
  });

  it("reactivating an admin membership counts as being given admin", async () => {
    await as(alpha.admin, (db) => db.query("select public.set_member_access($1, p_active => true)", [alpha.idle.id]), { keep: true });
    expect(await flag(alpha.idle)).toBe(true);
    await as(alpha.admin, (db) => db.query("select public.set_member_access($1, p_active => false)", [alpha.idle.id]), { keep: true });
    expect(await flag(alpha.idle)).toBe(false);
  });

  it("a signed-in session can't write the flag; the service role (the app's create and reset paths) can", async () => {
    const direct = await errorOf(as(alpha.second, (db) => db.query("update public.organization_members set mfa_enrolment_required = false where user_id = $1", [alpha.second.id])));
    expect(direct).toMatchObject({ code: "42501" });
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("update public.organization_members set mfa_enrolment_required = true where user_id = $1 and organization_id = $2", [alpha.second.id, alpha.id]);
      await db.query("commit");
    });
    expect(await flag(alpha.second)).toBe(true);
    // Even the service role can't keep it on someone who no longer holds admin.
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role service_role");
      const { rows } = await db.query("update public.organization_members set mfa_enrolment_required = true where user_id = $1 and organization_id = $2 returning mfa_enrolment_required as f", [alpha.office.id, alpha.id]);
      await db.query("rollback");
      expect(rows[0].f).toBe(false);
    });
  });

  it("while the rule is on, promoting a not-yet-enrolled person is allowed (aal2 admin) and flags them", async () => {
    await withDb(async (db) => {
      await unenrol(db, alpha.second);
      await enrol(db, alpha.second);
    });
    await setRule(alpha.id, true);
    try {
      // At aal1 the acting admin is refused by 033's rule, as before.
      expect(await errorOf(as(alpha.admin, (db) => db.query("select public.set_member_access($1, 'admin')", [alpha.office.id])))).toMatchObject({ code: "42501" });
      await as(alpha.admin, (db) => db.query("select public.set_member_access($1, 'admin')", [alpha.office.id]), { aal: "aal2", keep: true });
      expect(await flag(alpha.office)).toBe(true);
      await as(alpha.admin, (db) => db.query("select public.set_member_access($1, 'office')", [alpha.office.id]), { aal: "aal2", keep: true });
    } finally {
      await setRule(alpha.id, false);
    }
  });
});

describe("what the app reads", () => {
  it("admin_mfa_overview: an admin sees their own company's admins only; office staff and other companies' admins are refused theirs", async () => {
    const mine = await as(alpha.admin, async (db) => (await db.query("select public.admin_mfa_overview() as o")).rows[0].o);
    const ids = (mine.admins as { user_id: string }[]).map((a) => a.user_id).sort();
    expect(ids).toEqual([alpha.admin.id, alpha.second.id].sort());
    expect(mine).toMatchObject({ require_admin_mfa: false });
    const theirs = await as(beta.admin, async (db) => (await db.query("select public.admin_mfa_overview() as o")).rows[0].o);
    expect((theirs.admins as { user_id: string; enrolled: boolean }[])).toEqual([{ user_id: beta.admin.id, enrolled: false, enrolment_required: false }]);
    expect(theirs.can_require).toBe(false);
    expect(await errorOf(as(alpha.office, (db) => db.query("select public.admin_mfa_overview()")))).toMatchObject({ code: "42501" });
    expect(await errorOf(as(beta.office, (db) => db.query("select public.admin_mfa_overview()")))).toMatchObject({ code: "42501" });
  });

  it("my_mfa_enrolment_required: TRUE for a flagged admin without a factor while another admin can sign in; never for the last usable admin", async () => {
    await withDb(async (db) => {
      await db.query("update public.organization_members set mfa_enrolment_required = true where user_id = $1 and organization_id = $2", [alpha.second.id, alpha.id]);
      await unenrol(db, alpha.second);
    });
    const mine = (p: Person) => as(p, async (db) => (await db.query("select public.my_mfa_enrolment_required() as r")).rows[0].r as boolean);
    expect(await mine(alpha.second)).toBe(true);
    expect(await mine(alpha.admin)).toBe(false);
    expect(await mine(alpha.office)).toBe(false);
    // Enrolled: no longer sent to set-up.
    await withDb((db) => enrol(db, alpha.second));
    expect(await mine(alpha.second)).toBe(false);
    await withDb((db) => unenrol(db, alpha.second));
    // The only other admin is flagged and not enrolled either: nobody is sent (no lockout).
    await withDb(async (db) => {
      await unenrol(db, alpha.admin);
      await db.query("update public.organization_members set mfa_enrolment_required = true where user_id = $1 and organization_id = $2", [alpha.admin.id, alpha.id]);
    });
    expect(await mine(alpha.second)).toBe(false);
    expect(await mine(alpha.admin)).toBe(false);
  });

  it("grants: the factor lookup is internal; anon can't call either reader", async () => {
    const grants = await withDb(async (db) => (await db.query(`
      select r.rolname, p.proname, has_function_privilege(r.oid, p.oid, 'execute') as can
      from pg_proc p cross join pg_roles r
      where p.pronamespace = 'public'::regnamespace and p.proname in ('member_has_verified_totp', 'admin_mfa_overview', 'my_mfa_enrolment_required')
        and r.rolname in ('anon', 'authenticated', 'service_role') order by 1, 2`)).rows);
    const can = (role: string, fn: string) => grants.find((g) => g.rolname === role && g.proname === fn)?.can;
    for (const role of ["anon", "authenticated", "service_role"]) expect(can(role, "member_has_verified_totp")).toBe(false);
    expect(can("anon", "admin_mfa_overview")).toBe(false);
    expect(can("anon", "my_mfa_enrolment_required")).toBe(false);
    expect(can("authenticated", "admin_mfa_overview")).toBe(true);
    expect(can("authenticated", "my_mfa_enrolment_required")).toBe(true);
  });
});

describe("review: real paths only (no test fixture)", () => {
  it("the exact refusal: SQLSTATE 23514, hint admins_not_enrolled, the admins named; an admin's own session can't even try", async () => {
    const owner = await errorOf(setRule(beta.id, true));
    expect(owner).toMatchObject({ code: "23514", hint: "admins_not_enrolled" });
    expect(owner!.message).toBe(`Two-step sign-in can't be required yet: 1 admin(s) have not set up an authenticator app (${beta.admin.email}).`);
    // As the company's own admin through PostgREST (role authenticated): no column privilege at all, whatever the guard says.
    const api = await errorOf(as(beta.admin, (db) => db.query("update public.organizations set require_admin_mfa = true where id = $1", [beta.id]), { aal: "aal2" }));
    expect(api).toMatchObject({ code: "42501" });
    expect(api!.message).toBe("permission denied for table organizations");
    expect((await withDb((db) => db.query("select require_admin_mfa as r from public.organizations where id = $1", [beta.id]))).rows[0].r).toBe(false);
  });

  it("the last admin who can sign in normally is never sent to set-up, even when flagged", async () => {
    await withDb((db) => db.query("update public.organization_members set mfa_enrolment_required = true where user_id = $1 and organization_id = $2", [beta.admin.id, beta.id]));
    expect(await flag(beta.admin, beta.id)).toBe(true);
    expect(await as(beta.admin, async (db) => (await db.query("select public.my_mfa_enrolment_required() as r")).rows[0].r)).toBe(false);
    await withDb((db) => db.query("update public.organization_members set mfa_enrolment_required = false where user_id = $1 and organization_id = $2", [beta.admin.id, beta.id]));
  });

  it("a flagged admin can't clear, delete or replace their own membership to escape the flag; nor can a non-admin", async () => {
    await withDb((db) => db.query("update public.organization_members set mfa_enrolment_required = true where user_id = $1 and organization_id = $2", [alpha.second.id, alpha.id]));
    const tries = [
      "update public.organization_members set mfa_enrolment_required = false where user_id = $1",
      "delete from public.organization_members where user_id = $1",
      `insert into public.organization_members (user_id, organization_id, role, mfa_enrolment_required) values ($1, '${alpha.id}', 'admin', false)
         on conflict (user_id, organization_id) do update set mfa_enrolment_required = false`,
    ];
    for (const text of tries) {
      expect(await errorOf(as(alpha.second, (db) => db.query(text, [alpha.second.id]), { aal: "aal2" }))).toMatchObject({ code: "42501" });
      expect(await errorOf(as(alpha.office, (db) => db.query(text, [alpha.second.id])))).toMatchObject({ code: "42501" });
    }
    // Through the RPCs a signed-in admin may call on themselves: the change goes through, the flag stays.
    await as(alpha.second, (db) => db.query("select public.set_member_access($1, p_hidden_sections => '{}'::text[])", [alpha.second.id]), { keep: true });
    await errorOf(as(alpha.second, (db) => db.query("select public.set_member_inspector($1, true)", [alpha.second.id]), { keep: true }));
    expect(await flag(alpha.second)).toBe(true);
    // Removing their own admin is refused (036), so they can't drop and regain it either.
    expect(await errorOf(as(alpha.second, (db) => db.query("select public.set_member_access($1, p_clear_secondary => true)", [alpha.second.id])))).toMatchObject({ code: "23514" });
    expect(await flag(alpha.second)).toBe(true);
    expect(await as(alpha.second, async (db) => (await db.query("select count(*)::int as n from public.organization_members where user_id = $1", [alpha.second.id])).rows[0].n)).toBe(1);
  });
});
