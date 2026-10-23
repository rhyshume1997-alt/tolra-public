/**
 * Migration 093: a company admin can never act on the platform owner's login (external read-only audit, HIGH).
 *
 *   - admin_set_company_access (066 + one refusal, 42501 hint protected_login): never for a platform owner's login, nor for a login with
 *     any support membership (active or switched off, window open or over), unless it is the caller themself. 066's own refusals come
 *     first (unknown_login, support_membership), so nothing new is revealed about anyone outside the caller's people.
 *   - admin_login_is_protected(p_user), signed-in only: TRUE for a platform owner or a login with any support membership; FALSE only
 *     for one of the caller's people who is neither; TRUE (fail closed, no oracle) for anyone else, for a non-admin, and for NULL.
 *   - set_member_access (066 + the same refusal; review round 2): the session company's edit of such a login is refused, except switching
 *     its membership there off and nothing else (Revoke support access, Deactivate); never switched on, never a role or pages.
 *   - Legitimate paths unchanged: an admin changes an ordinary member's role, gives them another company, removes it, changes their own.
 *
 * Mirrors the raw-SQL proof of the 093 review pack. Plain SQL with synthetic rows and forged session claims (no Auth API), so it runs on
 * the local stack and on a plain Postgres rebuild with Supabase stand-ins.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `093 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-093-${label}-${counter}`]);
  return id;
}

/** A login (created on first use) with a membership in `org`. A support row is written as 036 leaves it: active, its window `ended` or not. */
async function member(db: Client, org: string, p: Person, role: string, extra: { support?: boolean; ended?: boolean } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $2, $3, $4, true, false) on conflict (id) do nothing`, [p.id, p.email, role, org]);
  await db.query(
    `insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
     values ($1, $2, $3, true, $4, case when $4 then now() + case when $5 then interval '-3 days' else interval '2 hours' end end,
             case when $4 then gen_random_uuid() end)`,
    [p.id, org, role, extra.support ?? false, extra.ended ?? true]);
}

async function choose(db: Client, p: Person, org: string) {
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

async function as<T>(p: Person, fn: (db: Client) => Promise<T>, aal = "aal2"): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal, email: p.email, ...(p.session ? { session_id: p.session } : {}) }), p.id]);
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

const setAccess = (db: Client, org: string, user: string, role: string | null, active: boolean | null, secondary: string | null = null) =>
  db.query<{ r: { action: string | null } }>("select public.admin_set_company_access($1, $2, $3, $4, false, $5) as r", [org, user, role, secondary, active]).then((res) => res.rows[0].r);
const setMember = (db: Client, user: string, args: { role?: string | null; active?: boolean | null; sections?: string[] | null }) =>
  db.query("select public.set_member_access($1, $2, $3, null, false, $4)", [user, args.role ?? null, args.active ?? null, args.sections ?? null]);
const isProtected = (db: Client, user: string | null) =>
  db.query<{ v: boolean }>("select public.admin_login_is_protected($1) as v", [user]).then((res) => res.rows[0].v);
const rows = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);
const membershipsOf = (user: string) =>
  rows<{ organization_id: string; role: string; active: boolean; support: boolean }>(
    "select organization_id, role, active, support from public.organization_members where user_id = $1 order by organization_id", [user]);

// A, B, C. aAdmin: admin of A. dual: admin of A and C. mem: ordinary member of A.
// owner1: platform owner, no ordinary membership, a leftover support row in A (window over, still active: the reported path).
// owner2: platform owner, ordinary office member of A. former: not on the list, office in C, a leftover support row in A.
const W = { A: "", B: "", C: "", aAdmin: person("a-admin"), dual: person("dual"), mem: person("mem"), owner1: person("owner1"), owner2: person("owner2"), former: person("former"),
  // Round 2: fmr not on the list, office in A and C, a leftover support row in B; owner3 platform owner, office in A and C.
  fmr: person("fmr"), owner3: person("owner3") };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.B = await makeOrg(db, "b");
    W.C = await makeOrg(db, "c");
    await member(db, W.A, W.aAdmin, "admin");
    await member(db, W.A, W.dual, "admin");
    await member(db, W.C, W.dual, "admin");
    await member(db, W.A, W.mem, "workshop");
    await member(db, W.A, W.owner1, "admin", { support: true, ended: true });
    await member(db, W.A, W.owner2, "office");
    await member(db, W.C, W.former, "office");
    await member(db, W.A, W.former, "admin", { support: true, ended: true });
    await member(db, W.A, W.fmr, "office");
    await member(db, W.C, W.fmr, "office");
    await member(db, W.B, W.fmr, "admin", { support: true, ended: true });
    await member(db, W.A, W.owner3, "office");
    await member(db, W.C, W.owner3, "office");
    await db.query("insert into security_audit.platform_admins (user_id) values ($1), ($2), ($3)", [W.owner1.id, W.owner2.id, W.owner3.id]);
    await choose(db, W.aAdmin, W.A);
    await choose(db, W.dual, W.A);
    await choose(db, W.mem, W.A);
  });
});

afterAll(async () => {
  await withDb((db) => db.query("delete from security_audit.platform_admins where user_id = any($1)", [[W.owner1.id, W.owner2.id, W.owner3.id]]));
  await destroySyntheticWorld(run);
});

describe("admin_set_company_access never acts on a platform owner's login or a support login", () => {
  it("the reported shape (support row only) is still refused by 066's unknown_login first", async () => {
    expect(await errorOf(as(W.aAdmin, (db) => setAccess(db, W.A, W.owner1.id, "admin", true)))).toMatchObject({ code: "42501", hint: "unknown_login" });
  });

  it("a platform owner who is an ordinary member of A: no role change in A, not pulled into C; nothing written", async () => {
    expect(await errorOf(as(W.aAdmin, (db) => setAccess(db, W.A, W.owner2.id, "admin", true)))).toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.C, W.owner2.id, "admin", true)))).toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await membershipsOf(W.owner2.id)).toEqual([{ organization_id: W.A, role: "office", active: true, support: false }]);
  });

  it("a login with a support row in A (window over) can't be changed in C; its support row stays support_membership", async () => {
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.C, W.former.id, "admin", true)))).toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await errorOf(as(W.dual, (db) => setAccess(db, W.A, W.former.id, "office", true)))).toMatchObject({ code: "42501", hint: "support_membership" });
    expect((await membershipsOf(W.former.id)).find((m) => m.organization_id === W.C)).toMatchObject({ role: "office" });
  });

  it("no audit row is written for any refused change", async () => {
    expect(await rows("select 1 from security_audit.audit_log where entity_id = any($1) and action in ('GRANT_COMPANY_ACCESS', 'CHANGE_COMPANY_ROLE', 'REMOVE_COMPANY_ACCESS')",
      [[W.owner1.id, W.owner2.id, W.former.id]])).toEqual([]);
  });

  it("legitimate paths: an ordinary member's role, another company and its removal, the caller's own role; aal1 where A doesn't require it", async () => {
    expect(await as(W.aAdmin, (db) => setAccess(db, W.A, W.mem.id, "office", true))).toMatchObject({ action: "CHANGE_COMPANY_ROLE" });
    expect(await as(W.dual, (db) => setAccess(db, W.C, W.mem.id, "workshop", true))).toMatchObject({ action: "GRANT_COMPANY_ACCESS" });
    expect(await as(W.dual, (db) => setAccess(db, W.C, W.mem.id, null, false))).toMatchObject({ action: "REMOVE_COMPANY_ACCESS" });
    expect(await as(W.dual, (db) => setAccess(db, W.C, W.dual.id, "admin", true, "office"))).toMatchObject({ action: "CHANGE_COMPANY_ROLE" });
    expect(await as(W.aAdmin, (db) => setAccess(db, W.A, W.mem.id, "workshop", true), "aal1")).toMatchObject({ action: "CHANGE_COMPANY_ROLE" });
  });
});

describe("set_member_access (the session company): such a login can only be switched off", () => {
  const rowIn = async (org: string, user: string) => (await rows<{ role: string; active: boolean; hidden_sections: string[] }>(
    "select role, active, hidden_sections from public.organization_members where organization_id = $1 and user_id = $2", [org, user]))[0];

  it("a platform owner's role, a support-row login's pages, a switch-off with a role change: refused protected_login, nothing written", async () => {
    expect(await errorOf(as(W.aAdmin, (db) => setMember(db, W.owner3.id, { role: "admin" })))).toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await errorOf(as(W.aAdmin, (db) => setMember(db, W.fmr.id, { sections: ["quotes"] })))).toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await errorOf(as(W.aAdmin, (db) => setMember(db, W.owner3.id, { role: "viewer", active: false })))).toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await rowIn(W.A, W.owner3.id)).toMatchObject({ role: "office", active: true });
    expect(await rowIn(W.A, W.fmr.id)).toMatchObject({ role: "office", active: true, hidden_sections: [] });
  });

  it("switching their membership in the caller's company off is allowed; switching it back on is refused", async () => {
    await as(W.aAdmin, (db) => setMember(db, W.fmr.id, { active: false }));
    await as(W.aAdmin, (db) => setMember(db, W.owner3.id, { active: false }));
    expect(await rowIn(W.A, W.fmr.id)).toMatchObject({ role: "office", active: false });
    expect(await rowIn(W.A, W.owner3.id)).toMatchObject({ role: "office", active: false });
    expect(await errorOf(as(W.aAdmin, (db) => setMember(db, W.fmr.id, { active: true })))).toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await errorOf(as(W.aAdmin, (db) => setMember(db, W.owner3.id, { active: true })))).toMatchObject({ code: "42501", hint: "protected_login" });
    expect(await rowIn(W.A, W.fmr.id)).toMatchObject({ active: false });
  });

  it("an ordinary member is edited as before; a support row in A is still only switched off (066)", async () => {
    await as(W.aAdmin, (db) => setMember(db, W.mem.id, { role: "office", sections: ["quotes"] }));
    expect(await rowIn(W.A, W.mem.id)).toMatchObject({ role: "office", active: true, hidden_sections: ["quotes"] });
    await as(W.aAdmin, (db) => setMember(db, W.mem.id, { role: "workshop", sections: [] }));
    expect(await errorOf(as(W.aAdmin, (db) => setMember(db, W.former.id, { role: "office" })))).toMatchObject({ code: "42501" });
  });
});

describe("admin_login_is_protected: the question the service-role routes ask with the caller's token", () => {
  it("TRUE for both platform owners and the support login; FALSE for an ordinary member of A", async () => {
    expect(await as(W.aAdmin, (db) => isProtected(db, W.owner1.id))).toBe(true);
    expect(await as(W.aAdmin, (db) => isProtected(db, W.owner2.id))).toBe(true);
    expect(await as(W.aAdmin, (db) => isProtected(db, W.former.id))).toBe(true);
    expect(await as(W.aAdmin, (db) => isProtected(db, W.mem.id))).toBe(false);
  });

  it("fail closed, no oracle: someone outside the caller's people, NULL, and any question from a non-admin answer TRUE", async () => {
    expect(await as(W.aAdmin, (db) => isProtected(db, randomUUID()))).toBe(true);
    expect(await as(W.aAdmin, (db) => isProtected(db, null))).toBe(true);
    expect(await as(W.mem, (db) => isProtected(db, W.mem.id))).toBe(true);
    expect(await as(W.mem, (db) => isProtected(db, W.owner2.id))).toBe(true);
  });

  it("anon can't call it", async () => {
    const refused = await errorOf(withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role anon");
        return await isProtected(db, W.mem.id);
      } finally {
        await db.query("rollback");
      }
    }));
    expect(refused).toMatchObject({ code: "42501" });
  });
});
