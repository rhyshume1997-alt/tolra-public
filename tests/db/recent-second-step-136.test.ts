/**
 * Migration 136 (G1): giving or taking admin needs an authenticator (TOTP) code from the last 15 minutes in the TOKEN, in the database
 * too, so a signed-in browser calling set_member_access / admin_set_company_access directly is held to the same rule as the app's
 * routes (lib/server/admin-users.ts requireRecentAal2). The rule lives in a trigger on organization_members, so it covers every
 * function that writes there for a signed-in caller. It applies in a company whose organizations.require_admin_mfa is on (033), judged
 * on the company of the membership being changed.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API): the claims carry aal and an amr list, as a Supabase access
 * token does ({ method: "totp", timestamp: <seconds> }).
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
const now = () => Math.floor(Date.now() / 1000);

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `136 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-136-${label}-${counter}`]);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string, extra: { secondary?: string; active?: boolean } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $2, $3, $4, true, false) on conflict (id) do nothing`, [p.id, p.email, role, org]);
  await db.query(
    "insert into public.organization_members (user_id, organization_id, role, secondary_role, active) values ($1, $2, $3, $4, $5)",
    [p.id, org, role, extra.secondary ?? null, extra.active ?? true]);
}

async function choose(db: Client, p: Person, org: string) {
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

type Amr = unknown;
const FRESH = (): Amr => [{ method: "password", timestamp: now() - 120 }, { method: "totp", timestamp: now() - 60 }];
const STALE = (): Amr => [{ method: "password", timestamp: now() - 3600 }, { method: "totp", timestamp: now() - 16 * 60 }];

async function signIn(db: Client, p: Person, aal: string, amr: Amr | undefined) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
    [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal, email: p.email, ...(amr === undefined ? {} : { amr }), ...(p.session ? { session_id: p.session } : {}) }), p.id]);
}

/** Runs `fn` in a transaction as the signed-in `p` (aal2 unless said), then commits; a failure rolls back and rethrows. */
async function as<T>(p: Person, amr: Amr | undefined, fn: (db: Client) => Promise<T>, aal = "aal2"): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await signIn(db, p, aal, amr);
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
const REFUSED = { code: "42501", hint: "mfa_recent_required" };

const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);
const membership = async (org: string, user: string) =>
  (await sql<{ role: string; secondary_role: string | null; active: boolean }>("select role, secondary_role, active from public.organization_members where organization_id = $1 and user_id = $2", [org, user]))[0];
const memberAccess = (db: Client, user: string, args: { role?: string | null; secondary?: string | null; clear?: boolean; active?: boolean | null; hidden?: string[] | null }) =>
  db.query("select public.set_member_access($1, $2, $3, $4, $5, $6)", [user, args.role ?? null, args.active ?? null, args.secondary ?? null, args.clear ?? false, args.hidden ?? null]);
const companyAccess = (db: Client, org: string, user: string, args: { role?: string | null; secondary?: string | null; clear?: boolean; active?: boolean | null }) =>
  db.query("select public.admin_set_company_access($1, $2, $3, $4, $5, $6)", [org, user, args.role ?? null, args.secondary ?? null, args.clear ?? false, args.active ?? null]);

// A and C require the second step (033); L does not. `admin` administers A, C and L and works in A; `other` is A's second admin
// (so the last-admin rule never interferes); `outsider` administers B only (a second tenant); targets are ordinary members.
const W = {
  A: "", B: "", C: "", L: "",
  admin: person("admin"), other: person("other-admin"), outsider: person("b-admin"),
  office: person("office"), second: person("second-admin"), cOffice: person("c-office"), lOffice: person("l-office"), bOffice: person("b-office"), offB: person("off"),
};

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.B = await makeOrg(db, "b");
    W.C = await makeOrg(db, "c");
    W.L = await makeOrg(db, "loose");
    await member(db, W.A, W.admin, "admin");
    await member(db, W.C, W.admin, "admin");
    await member(db, W.L, W.admin, "admin");
    await member(db, W.A, W.other, "admin");
    await member(db, W.B, W.outsider, "admin");
    await member(db, W.A, W.office, "office");
    await member(db, W.A, W.second, "admin");
    await member(db, W.C, W.cOffice, "office");
    await member(db, W.L, W.lOffice, "office");
    await member(db, W.B, W.bOffice, "office");
    await member(db, W.A, W.offB, "workshop");
    // Each target also belongs to L (which the admin administers), so switching one company off never removes a login's last one.
    for (const p of [W.second, W.office, W.offB, W.cOffice]) await db.query("insert into public.organization_members (user_id, organization_id, role) values ($1, $2, 'viewer')", [p.id, W.L]);
    await choose(db, W.admin, W.A);
    await choose(db, W.outsider, W.B);
  });
  await setRequireAdminMfaForTest(W.A, true);
  await setRequireAdminMfaForTest(W.C, true);
  await setRequireAdminMfaForTest(W.B, true);
});

afterAll(async () => {
  await destroySyntheticWorld(run);
});

async function reset() {
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query("update public.organization_members set role = 'office', secondary_role = null, active = true where organization_id = $1 and user_id = $2", [W.A, W.office.id]);
    await db.query("update public.organization_members set role = 'admin', secondary_role = null, active = true where organization_id = $1 and user_id = $2", [W.A, W.second.id]);
    await db.query("update public.organization_members set role = 'office', secondary_role = null, active = true where organization_id in ($1, $2) and user_id in ($3, $4)", [W.C, W.L, W.cOffice.id, W.lOffice.id]);
    await db.query("update public.organization_members set role = 'workshop', secondary_role = null, active = true where organization_id = $1 and user_id = $2", [W.A, W.offB.id]);
    await db.query("commit");
  });
}

describe("set_member_access: giving admin", () => {
  it("a code under 15 minutes old: allowed; the role changes", async () => {
    await reset();
    await as(W.admin, FRESH(), (db) => memberAccess(db, W.office.id, { role: "admin" }));
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "admin" });
  });
  it("a code over 15 minutes old: refused with 42501 / mfa_recent_required; nothing changes", async () => {
    await reset();
    expect(await errorOf(as(W.admin, STALE(), (db) => memberAccess(db, W.office.id, { role: "admin" })))).toMatchObject(REFUSED);
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "office", secondary_role: null, active: true });
  });
  it("the same for a second role of admin", async () => {
    await reset();
    expect(await errorOf(as(W.admin, STALE(), (db) => memberAccess(db, W.office.id, { secondary: "admin" })))).toMatchObject(REFUSED);
    expect(await membership(W.A, W.office.id)).toMatchObject({ secondary_role: null });
    await as(W.admin, FRESH(), (db) => memberAccess(db, W.office.id, { secondary: "admin" }));
    expect(await membership(W.A, W.office.id)).toMatchObject({ secondary_role: "admin" });
  });
  it("the edges of the window: 14 minutes allowed, 16 refused; 30 seconds ahead (clock skew) allowed, an hour ahead refused", async () => {
    await reset();
    await as(W.admin, [{ method: "totp", timestamp: now() - 14 * 60 }], (db) => memberAccess(db, W.office.id, { role: "admin" }));
    await reset();
    expect(await errorOf(as(W.admin, [{ method: "totp", timestamp: now() - 16 * 60 }], (db) => memberAccess(db, W.office.id, { role: "admin" })))).toMatchObject(REFUSED);
    await as(W.admin, [{ method: "totp", timestamp: now() + 30 }], (db) => memberAccess(db, W.office.id, { role: "admin" }));
    await reset();
    expect(await errorOf(as(W.admin, [{ method: "totp", timestamp: now() + 3600 }], (db) => memberAccess(db, W.office.id, { role: "admin" })))).toMatchObject(REFUSED);
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "office" });
  });
  it("what does not count as a recent code: none, a password entry only, a non-array, no time, a text time, a non-object entry", async () => {
    await reset();
    const bad: Array<[string, Amr | undefined]> = [
      ["no amr claim", undefined], ["empty list", []], ["password only", [{ method: "password", timestamp: now() }]],
      ["not an array", { method: "totp", timestamp: now() }], ["no time", [{ method: "totp" }]],
      ["time as text", [{ method: "totp", timestamp: String(now()) }]], ["other entries", [null, "totp", 7, { method: "otp", timestamp: now() }]],
    ];
    for (const [name, amr] of bad) {
      expect(await errorOf(as(W.admin, amr, (db) => memberAccess(db, W.office.id, { role: "admin" }))), name).toMatchObject(REFUSED);
    }
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "office" });
  });
  it("the method may be spelled mfa/totp; an old entry beside a fresh one is fine", async () => {
    await reset();
    await as(W.admin, [{ method: "totp", timestamp: now() - 3000 }, { method: "mfa/totp", timestamp: now() - 5 }], (db) => memberAccess(db, W.office.id, { role: "admin" }));
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "admin" });
  });
  it("at aal1 the existing mfa_required comes first (033's statement trigger), not mfa_recent_required", async () => {
    await reset();
    expect(await errorOf(as(W.admin, [{ method: "password", timestamp: now() }], (db) => memberAccess(db, W.office.id, { role: "admin" }), "aal1"))).toMatchObject({ code: "42501", hint: "mfa_required" });
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "office" });
  });
});

describe("set_member_access: taking admin, including switching an admin off", () => {
  it("demoting an admin: stale refused (they stay admin), fresh allowed", async () => {
    await reset();
    expect(await errorOf(as(W.admin, STALE(), (db) => memberAccess(db, W.second.id, { role: "office" })))).toMatchObject(REFUSED);
    expect(await membership(W.A, W.second.id)).toMatchObject({ role: "admin" });
    await as(W.admin, FRESH(), (db) => memberAccess(db, W.second.id, { role: "office" }));
    expect(await membership(W.A, W.second.id)).toMatchObject({ role: "office" });
  });
  it("removing a second role of admin: stale refused, fresh allowed", async () => {
    await reset();
    await withDb((db) => db.query("update public.organization_members set secondary_role = 'admin' where organization_id = $1 and user_id = $2", [W.A, W.office.id]));
    expect(await errorOf(as(W.admin, STALE(), (db) => memberAccess(db, W.office.id, { clear: true })))).toMatchObject(REFUSED);
    expect(await membership(W.A, W.office.id)).toMatchObject({ secondary_role: "admin" });
    await as(W.admin, FRESH(), (db) => memberAccess(db, W.office.id, { clear: true }));
    expect(await membership(W.A, W.office.id)).toMatchObject({ secondary_role: null });
  });
  it("deactivating an admin counts as taking admin: stale refused (still active), fresh allowed; reactivating likewise", async () => {
    await reset();
    expect(await errorOf(as(W.admin, STALE(), (db) => memberAccess(db, W.second.id, { active: false })))).toMatchObject(REFUSED);
    expect(await membership(W.A, W.second.id)).toMatchObject({ active: true });
    await as(W.admin, FRESH(), (db) => memberAccess(db, W.second.id, { active: false }));
    expect(await membership(W.A, W.second.id)).toMatchObject({ active: false });
    expect(await errorOf(as(W.admin, STALE(), (db) => memberAccess(db, W.second.id, { active: true })))).toMatchObject(REFUSED);
    expect(await membership(W.A, W.second.id)).toMatchObject({ active: false });
    await as(W.admin, FRESH(), (db) => memberAccess(db, W.second.id, { active: true }));
    expect(await membership(W.A, W.second.id)).toMatchObject({ active: true });
  });
});

describe("changes that do not give or take admin are not asked, even with a stale code", () => {
  it("a role between two non-admin roles, a non-admin second role, pages, and deactivating/reactivating a non-admin", async () => {
    await reset();
    const stale = STALE();
    await as(W.admin, stale, (db) => memberAccess(db, W.offB.id, { role: "viewer" }));
    expect(await membership(W.A, W.offB.id)).toMatchObject({ role: "viewer" });
    await as(W.admin, stale, (db) => memberAccess(db, W.offB.id, { secondary: "office" }));
    expect(await membership(W.A, W.offB.id)).toMatchObject({ secondary_role: "office" });
    await as(W.admin, stale, (db) => memberAccess(db, W.offB.id, { hidden: ["invoices"] }));
    await as(W.admin, stale, (db) => memberAccess(db, W.offB.id, { active: false }));
    expect(await membership(W.A, W.offB.id)).toMatchObject({ active: false });
    await as(W.admin, stale, (db) => memberAccess(db, W.offB.id, { active: true }));
    expect(await membership(W.A, W.offB.id)).toMatchObject({ active: true });
  });
  it("an admin kept as admin (pages changed) is not asked", async () => {
    await reset();
    await as(W.admin, STALE(), (db) => memberAccess(db, W.second.id, { hidden: ["invoices"] }));
    expect(await membership(W.A, W.second.id)).toMatchObject({ role: "admin", active: true });
  });
  it("an admin whose second role is swapped for another while the role stays admin is not asked", async () => {
    await reset();
    await as(W.admin, STALE(), (db) => memberAccess(db, W.second.id, { secondary: "office" }));
    expect(await membership(W.A, W.second.id)).toMatchObject({ role: "admin", secondary_role: "office" });
  });
});

describe("a company whose own switch is off is unchanged", () => {
  it("L (require_admin_mfa off): giving and taking admin works with no recent code (the session company's own aal2 rule, 033, still applies); each company is judged on its own row", async () => {
    await reset();
    await as(W.admin, [{ method: "password", timestamp: now() }], (db) => companyAccess(db, W.L, W.lOffice.id, { role: "admin" }));
    expect(await membership(W.L, W.lOffice.id)).toMatchObject({ role: "admin" });
    await as(W.admin, STALE(), (db) => companyAccess(db, W.L, W.lOffice.id, { role: "office" }));
    expect(await membership(W.L, W.lOffice.id)).toMatchObject({ role: "office" });
  });
});

describe("admin_set_company_access", () => {
  it("giving admin in C: stale refused (nothing written), fresh allowed", async () => {
    await reset();
    expect(await errorOf(as(W.admin, STALE(), (db) => companyAccess(db, W.C, W.cOffice.id, { role: "admin" })))).toMatchObject(REFUSED);
    expect(await membership(W.C, W.cOffice.id)).toMatchObject({ role: "office" });
    await as(W.admin, FRESH(), (db) => companyAccess(db, W.C, W.cOffice.id, { role: "admin" }));
    expect(await membership(W.C, W.cOffice.id)).toMatchObject({ role: "admin" });
  });
  it("taking admin in C and switching an admin of C off: stale refused, fresh allowed", async () => {
    await reset();
    await withDb((db) => db.query("update public.organization_members set role = 'admin' where organization_id = $1 and user_id = $2", [W.C, W.cOffice.id]));
    expect(await errorOf(as(W.admin, STALE(), (db) => companyAccess(db, W.C, W.cOffice.id, { role: "office" })))).toMatchObject(REFUSED);
    expect(await errorOf(as(W.admin, STALE(), (db) => companyAccess(db, W.C, W.cOffice.id, { active: false })))).toMatchObject(REFUSED);
    expect(await membership(W.C, W.cOffice.id)).toMatchObject({ role: "admin", active: true });
    await as(W.admin, FRESH(), (db) => companyAccess(db, W.C, W.cOffice.id, { active: false }));
    expect(await membership(W.C, W.cOffice.id)).toMatchObject({ active: false });
    expect(await errorOf(as(W.admin, STALE(), (db) => companyAccess(db, W.C, W.cOffice.id, { active: true })))).toMatchObject(REFUSED);
    expect(await membership(W.C, W.cOffice.id)).toMatchObject({ active: false });
  });
  it("a non-admin access change in C is not asked, with a stale code", async () => {
    await reset();
    await as(W.admin, STALE(), (db) => companyAccess(db, W.C, W.cOffice.id, { role: "viewer" }));
    expect(await membership(W.C, W.cOffice.id)).toMatchObject({ role: "viewer" });
  });
  it("granting a brand-new membership as admin (an insert) needs the code too; as office it does not", async () => {
    await reset();
    const nobody = person("new-in-c");
    await withDb(async (db) => {
      await db.query("insert into auth.users (id, email) values ($1, $2)", [nobody.id, nobody.email]);
      await db.query("insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, $2, 'office', $3, true, false)", [nobody.id, nobody.email, W.A]);
      await db.query("insert into public.organization_members (user_id, organization_id, role) values ($1, $2, 'office')", [nobody.id, W.A]);
    });
    expect(await errorOf(as(W.admin, STALE(), (db) => companyAccess(db, W.C, nobody.id, { role: "admin", active: true })))).toMatchObject(REFUSED);
    expect(await sql("select 1 from public.organization_members where organization_id = $1 and user_id = $2", [W.C, nobody.id])).toHaveLength(0);
    await as(W.admin, STALE(), (db) => companyAccess(db, W.C, nobody.id, { role: "office", active: true }));
    expect(await membership(W.C, nobody.id)).toMatchObject({ role: "office" });
    expect(await errorOf(as(W.admin, STALE(), (db) => companyAccess(db, W.C, nobody.id, { role: "admin", active: true })))).toMatchObject(REFUSED);
    await as(W.admin, FRESH(), (db) => companyAccess(db, W.C, nobody.id, { role: "admin", active: true }));
    expect(await membership(W.C, nobody.id)).toMatchObject({ role: "admin" });
  });
});

describe("two tenants", () => {
  it("an admin of B only can't change A or C even with a fresh code; the existing refusal comes first and nothing changes", async () => {
    await reset();
    const fresh = FRESH();
    expect(await errorOf(as(W.outsider, fresh, (db) => companyAccess(db, W.A, W.office.id, { role: "admin" })))).toMatchObject({ code: "42501", hint: "not_company_admin" });
    expect(await errorOf(as(W.outsider, STALE(), (db) => companyAccess(db, W.C, W.cOffice.id, { role: "admin" })))).toMatchObject({ code: "42501", hint: "not_company_admin" });
    expect(await errorOf(as(W.outsider, fresh, (db) => memberAccess(db, W.office.id, { role: "admin" })))).not.toBeNull();
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "office" });
    expect(await membership(W.C, W.cOffice.id)).toMatchObject({ role: "office" });
  });
  it("B's own rule applies to B: its admin needs a fresh code to give admin in B", async () => {
    await withDb((db) => db.query("update public.organization_members set role = 'office' where organization_id = $1 and user_id = $2", [W.B, W.bOffice.id]));
    expect(await errorOf(as(W.outsider, STALE(), (db) => companyAccess(db, W.B, W.bOffice.id, { role: "admin" })))).toMatchObject(REFUSED);
    await as(W.outsider, FRESH(), (db) => companyAccess(db, W.B, W.bOffice.id, { role: "admin" }));
    expect(await membership(W.B, W.bOffice.id)).toMatchObject({ role: "admin" });
  });
  it("a fresh code in A does not carry to a stale one anywhere else: each call is judged on its own token", async () => {
    await reset();
    await as(W.admin, FRESH(), (db) => memberAccess(db, W.office.id, { role: "admin" }));
    expect(await errorOf(as(W.admin, STALE(), (db) => memberAccess(db, W.second.id, { role: "office" })))).toMatchObject(REFUSED);
  });
});

describe("who is not asked, and the table itself", () => {
  it("the service role and the owner (the app's server work, the SQL editor) are not asked", async () => {
    await reset();
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("update public.organization_members set role = 'admin' where organization_id = $1 and user_id = $2", [W.A, W.office.id]);
      await db.query("commit");
    });
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "admin" });
    await reset();
    await sql("update public.organization_members set role = 'admin' where organization_id = $1 and user_id = $2", [W.A, W.office.id]);
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "admin" });
  });
  it("the trigger holds on the table itself (even where a write grant is added for the test): update, insert, delete; support rows are exempt", async () => {
    await reset();
    const direct = (amr: Amr, text: string, values: unknown[]) =>
      withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query("grant select, insert, update, delete on public.organization_members to authenticated");
          await db.query("create policy t136_all on public.organization_members for all to authenticated using (true) with check (true)");
          await db.query("set local role authenticated");
          await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: W.admin.id, role: "authenticated", aal: "aal2", amr })]);
          const result = await errorOf(db.query(text, values));
          return result;
        } finally {
          await db.query("rollback");
        }
      });
    expect(await direct(STALE(), "update public.organization_members set role = 'admin' where organization_id = $1 and user_id = $2", [W.A, W.office.id])).toMatchObject(REFUSED);
    expect(await direct(FRESH(), "update public.organization_members set role = 'admin' where organization_id = $1 and user_id = $2", [W.A, W.office.id])).toBeNull();
    expect(await direct(STALE(), "delete from public.organization_members where organization_id = $1 and user_id = $2", [W.A, W.second.id])).toMatchObject(REFUSED);
    expect(await direct(STALE(), "delete from public.organization_members where organization_id = $1 and user_id = $2", [W.A, W.offB.id])).toBeNull();
    expect(await direct(STALE(), "insert into public.organization_members (user_id, organization_id, role) values ($1, $2, 'admin')", [W.cOffice.id, W.A])).toMatchObject(REFUSED);
    expect(await direct(STALE(), "insert into public.organization_members (user_id, organization_id, role) values ($1, $2, 'office')", [W.cOffice.id, W.A])).toBeNull();
    // A support membership (the platform owner's) is not this rule's business.
    expect(await direct(STALE(), "insert into public.organization_members (user_id, organization_id, role, support, expires_at, support_grant) values ($1, $2, 'admin', true, now() + interval '2 hours', gen_random_uuid())", [W.cOffice.id, W.A])).toBeNull();
    expect(await membership(W.A, W.office.id)).toMatchObject({ role: "office" });
  });
  it("nobody who is signed in can call the trigger function; it can't be used to read or change anything", async () => {
    const rows = await sql<{ auth: boolean; anon: boolean; svc: boolean; definer: boolean }>(
      `select has_function_privilege('authenticated', 'public.organization_members_recent_second_step()', 'execute') as auth,
              has_function_privilege('anon', 'public.organization_members_recent_second_step()', 'execute') as anon,
              has_function_privilege('service_role', 'public.organization_members_recent_second_step()', 'execute') as svc,
              (select prosecdef from pg_proc where oid = to_regprocedure('public.organization_members_recent_second_step()')) as definer`);
    expect(rows[0]).toEqual({ auth: false, anon: false, svc: false, definer: true });
  });
});
