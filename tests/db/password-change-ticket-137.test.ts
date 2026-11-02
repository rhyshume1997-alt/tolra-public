/**
 * Migration 137 (G1, review Pack 19c): a password is changed only through Tolra's own server routes. A signed-in person could call
 * Supabase Auth directly (supabase.auth.updateUser, PUT /auth/v1/user with their own token) and skip /api/auth/change-password with its
 * current-password and 15-minute authenticator-code rules. Auth stores a password with one UPDATE of auth.users.encrypted_password
 * (GoTrue models.User.UpdatePassword); 137's trigger refuses that UPDATE unless the app's server issued a single-use ticket for that
 * login after its own checks (issue_password_change_ticket, service role only), and uses the ticket up.
 *
 * Plain SQL with synthetic logins (no Auth API here): Auth's UPDATE is made as Auth's own database role (supabase_auth_admin) where this
 * database has one the test may use, otherwise as the connecting role (the trigger asks every role alike). The real Auth API path (PUT
 * /user with and without a ticket) is tests/db/password-gate.test.ts. Everything runs in transactions that are rolled back, except the
 * two-connection race, whose logins are removed afterwards.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const run = randomUUID().slice(0, 8);
const EMAIL_SUFFIX = `.${run}@example.test`;
const REFUSED = { code: "42501", hint: "password_change_ticket_required" };
let authRole: string | null = null;

/** fn inside one transaction that is always rolled back. */
async function rolledBack<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { code?: string; hint?: string; message: string };
  }
};
const hash = async (db: Client, password: string) => (await db.query<{ h: string }>("select extensions.crypt($1, extensions.gen_salt('bf')) as h", [password])).rows[0].h;

/** A login as Auth stores one: confirmed e-mail and a password (or none, or an unconfirmed invite). */
async function login(db: Client, label: string, opts: { password?: string | null; confirmed?: boolean; invited?: boolean } = {}) {
  const id = randomUUID();
  const password = opts.password === undefined ? `Old-${label}-Password-1` : opts.password;
  await db.query(
    `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, invited_at)
     values ($1, 'authenticated', 'authenticated', $2, $3, $4, $5)`,
    [id, `${label}${EMAIL_SUFFIX}`, password === null ? null : await hash(db, password), opts.confirmed === false ? null : new Date(), opts.invited ? new Date() : null]);
  return id;
}
const passwordIs = async (db: Client, id: string, password: string) =>
  (await db.query<{ ok: boolean }>("select encrypted_password = extensions.crypt($2, encrypted_password) as ok from auth.users where id = $1", [id, password])).rows[0].ok;

/** One statement as a role, inside a savepoint; the rows, or the error (the savepoint is rolled back on error). */
async function asRole<T extends Record<string, unknown>>(db: Client, role: string | null, text: string, values: unknown[] = []) {
  await db.query("savepoint s");
  try {
    if (role) {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(role === "authenticated" ? { sub: randomUUID(), role } : { role })]);
      await db.query(`set local role ${role}`);
    }
    const rows = (await db.query<T>(text, values)).rows;
    await db.query("reset role");
    await db.query("release savepoint s");
    return { rows, error: null };
  } catch (error) {
    await db.query("rollback to savepoint s");
    return { rows: [] as T[], error: error as { code?: string; hint?: string; message: string } };
  }
}
/** Auth's own write of a new password (GoTrue UpdatePassword: the hash and the cleared tokens, in one UPDATE). */
async function authSetsPassword(db: Client, id: string, password: string) {
  const h = await hash(db, password);
  return asRole(db, authRole,
    "update auth.users set encrypted_password = $2, recovery_token = '', confirmation_token = '', reauthentication_token = '' where id = $1", [id, h]);
}
const issue = (db: Client, id: string, purpose = "own_change", role: string | null = "service_role") =>
  asRole<{ t: string }>(db, role, "select public.issue_password_change_ticket($1, $2) as t", [id, purpose]);
const tickets = async (db: Client, id: string) =>
  (await db.query<{ purpose: string; used: boolean; live: boolean }>(
    "select purpose, used_at is not null as used, expires_at > now() as live from security_audit.password_change_tickets where user_id = $1 order by created_at, id", [id])).rows;

beforeAll(async () => {
  await verifyBackendIdentity();
  authRole = await withDb(async (db) => {
    const r = await db.query<{ ok: boolean }>(
      "select exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') and pg_has_role(current_user, 'supabase_auth_admin', 'MEMBER') and has_table_privilege('supabase_auth_admin', 'auth.users', 'UPDATE') as ok");
    return r.rows[0].ok ? "supabase_auth_admin" : null;
  });
});

afterAll(async () => {
  await withDb(async (db) => {
    const ids = (await db.query<{ id: string }>("select id from auth.users where email like $1", [`%${EMAIL_SUFFIX}`])).rows.map((r) => r.id);
    if (ids.length) {
      await db.query("delete from security_audit.password_change_tickets where user_id = any($1::uuid[])", [ids]);
      await db.query("delete from auth.users where id = any($1::uuid[])", [ids]);
    }
  });
});

describe("a password change without a ticket is refused", () => {
  it("Auth's direct update (what PUT /auth/v1/user with a person's own token does): refused, 42501 / password_change_ticket_required; the password is unchanged", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "direct");
      const { error } = await authSetsPassword(db, me, "Attacker-Chosen-Password-1");
      expect(error).toMatchObject(REFUSED);
      expect(await passwordIs(db, me, "Old-direct-Password-1")).toBe(true);
    });
  });
  it("the same from the database owner (the SQL editor): every role is asked", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "anyrole");
      const h = await hash(db, "Another-Password-123");
      expect((await asRole(db, null, "update auth.users set encrypted_password = $2 where id = $1", [me, h])).error).toMatchObject(REFUSED);
      expect(await passwordIs(db, me, "Old-anyrole-Password-1")).toBe(true);
    });
  });
});

describe("a ticket allows exactly one change", () => {
  it("a fresh ticket: allowed once; the ticket is marked used; a second change is refused", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "once");
      expect((await issue(db, me)).error).toBeNull();
      expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: false, live: true }]);
      expect((await authSetsPassword(db, me, "New-Password-Once-1")).error).toBeNull();
      expect(await passwordIs(db, me, "New-Password-Once-1")).toBe(true);
      expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: true, live: true }]);
      expect((await authSetsPassword(db, me, "Second-Password-2")).error).toMatchObject(REFUSED);
      expect(await passwordIs(db, me, "New-Password-Once-1")).toBe(true);
    });
  });
  it("an expired ticket is refused (and stays unused)", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "expired");
      await issue(db, me);
      await db.query("update security_audit.password_change_tickets set expires_at = now() - interval '1 second' where user_id = $1", [me]);
      expect((await authSetsPassword(db, me, "Too-Late-Password-1")).error).toMatchObject(REFUSED);
      expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: false, live: false }]);
      expect(await passwordIs(db, me, "Old-expired-Password-1")).toBe(true);
    });
  });
  it("a ticket expires 60 seconds after it is issued", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "ttl");
      await issue(db, me);
      const { rows } = await asRole<{ s: number }>(db, null, "select extract(epoch from expires_at - created_at)::int as s from security_audit.password_change_tickets where user_id = $1", [me]);
      expect(rows[0].s).toBe(60);
    });
  });
  it("a ticket for another login is refused; that login's ticket stays unused for its own change", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "me");
      const other = await login(db, "other");
      await issue(db, other, "admin_set");
      expect((await authSetsPassword(db, me, "Borrowed-Ticket-Password-1")).error).toMatchObject(REFUSED);
      expect(await tickets(db, other)).toEqual([{ purpose: "admin_set", used: false, live: true }]);
      expect((await authSetsPassword(db, other, "Other-Own-Password-1")).error).toBeNull();
    });
  });
  it("a change that fails later in Auth's transaction (rolled back) leaves the ticket unused", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "rollback");
      await issue(db, me);
      await db.query("savepoint auth_tx");
      expect((await authSetsPassword(db, me, "Rolled-Back-Password-1")).error).toBeNull();
      await db.query("rollback to savepoint auth_tx");
      expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: false, live: true }]);
      expect(await passwordIs(db, me, "Old-rollback-Password-1")).toBe(true);
    });
  });
  it("revoke drops an unused ticket (true) and keeps a used one (false); after a revoke the change is refused", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "revoke");
      const first = (await issue(db, me)).rows[0].t;
      expect((await asRole<{ r: boolean }>(db, "service_role", "select public.revoke_password_change_ticket($1) as r", [first])).rows[0].r).toBe(true);
      expect((await authSetsPassword(db, me, "After-Revoke-Password-1")).error).toMatchObject(REFUSED);
      const second = (await issue(db, me)).rows[0].t;
      expect((await authSetsPassword(db, me, "With-Ticket-Password-1")).error).toBeNull();
      expect((await asRole<{ r: boolean }>(db, "service_role", "select public.revoke_password_change_ticket($1) as r", [second])).rows[0].r).toBe(false);
      expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: true, live: true }]);
    });
  });
  it("two changes at once with one ticket (two connections): the first is allowed, the second (waiting on the row) is refused once the first commits", async () => {
    const me = await withDb(async (db) => {
      await db.query("begin");
      const id = await login(db, "race");
      await issue(db, id);
      await db.query("commit");
      return id;
    });
    const [h1, h2] = await withDb(async (db) => [await hash(db, "Race-Password-One-1"), await hash(db, "Race-Password-Two-2")]);
    await withDb(async (a) => withDb(async (b) => {
      await a.query("begin");
      await b.query("begin");
      try {
        if (authRole) { await a.query(`set local role ${authRole}`); await b.query(`set local role ${authRole}`); }
        await a.query("update auth.users set encrypted_password = $2 where id = $1", [me, h1]);
        // b would have to wait for the row lock on auth.users, so it is sent without waiting and judged after a commits.
        const second = errorOf(b.query("update auth.users set encrypted_password = $2 where id = $1", [me, h2]));
        await a.query("commit");
        expect(await second).toMatchObject(REFUSED);
      } finally {
        await a.query("rollback").catch(() => undefined);
        await b.query("rollback").catch(() => undefined);
      }
    }));
    await withDb(async (db) => {
      expect(await passwordIs(db, me, "Race-Password-One-1")).toBe(true);
      expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: true, live: true }]);
    });
  });
});

describe("a failed password update does not burn the ticket (Pack 19d, 1)", () => {
  /** Commits fn's work (the logins are removed in afterAll). */
  const committed = <T>(fn: (db: Client) => Promise<T>) => withDb(async (db) => {
    await db.query("begin");
    try {
      const out = await fn(db);
      await db.query("commit");
      return out;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
  for (const [when, timing] of [["a later BEFORE trigger", "before"], ["an AFTER trigger", "after"]] as const) {
    it(`Auth's UPDATE fails after 137's trigger ran (${when} raises): the ticket stays unused and works in a fresh transaction within 60 seconds`, async () => {
      const me = await committed(async (db) => {
        const id = await login(db, `burn-${timing}`);
        expect((await issue(db, id)).error).toBeNull();
        return id;
      });
      // Auth's transaction: 137's trigger takes the ticket, then something later in the same transaction fails; all of it rolls back.
      const failure = await withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query(`create function pg_temp.t137_fail() returns trigger language plpgsql as $f$ begin raise exception 'later failure' using errcode = 'XX137'; end $f$`);
          // BEFORE triggers fire in name order, so "zz_..." runs after password_change_ticket.
          await db.query(`create trigger zz_t137_fail ${timing} update on auth.users for each row when (old.id = '${me}') execute function pg_temp.t137_fail()`);
          const { error } = await authSetsPassword(db, me, "Failed-Attempt-Password-1");
          return error;
        } finally {
          await db.query("rollback");
        }
      });
      expect(failure).toMatchObject({ code: "XX137" });
      await withDb(async (db) => {
        expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: false, live: true }]);
        expect(await passwordIs(db, me, `Old-burn-${timing}-Password-1`)).toBe(true);
        expect(await db.query("select 1 from pg_trigger where tgname = 'zz_t137_fail'").then((r) => r.rowCount)).toBe(0);
      });
      // The retry, in a fresh transaction, with the same ticket: allowed, and the ticket is now used.
      await committed(async (db) => {
        expect((await authSetsPassword(db, me, "Retry-Password-OK-1")).error).toBeNull();
      });
      await withDb(async (db) => {
        expect(await passwordIs(db, me, "Retry-Password-OK-1")).toBe(true);
        expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: true, live: true }]);
      });
    });
  }
});

describe("an admin who lost their authenticator is not locked out by 137 (Pack 19d, 3)", () => {
  it("(b) the operator deletes the factor (dashboard: auth.mfa_factors only): 137's trigger does not fire, no ticket is needed or used", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "lost-factor");
      await db.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'phone', 'totp', 'verified', now(), now())", [me]);
      await issue(db, me);
      // No 137 trigger on auth.mfa_factors at all.
      expect((await db.query("select 1 from pg_trigger where tgrelid = 'auth.mfa_factors'::regclass and tgfoid = to_regprocedure('public.auth_users_password_change_ticket()')")).rowCount).toBe(0);
      expect((await asRole(db, authRole, "delete from auth.mfa_factors where user_id = $1", [me])).error).toBeNull();
      // What Auth may also touch on auth.users when a factor goes (updated_at): the password is unchanged, so not asked.
      expect((await asRole(db, authRole, "update auth.users set updated_at = now() where id = $1", [me])).error).toBeNull();
      expect((await db.query("select 1 from auth.mfa_factors where user_id = $1", [me])).rowCount).toBe(0);
      expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: false, live: true }]);
    });
  });
  it("(c) lost password AND authenticator: the operator, in one SQL editor run, issues an operator ticket, sets the password and removes the factors", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "lost-both");
      await db.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'phone', 'totp', 'verified', now(), now())", [me]);
      // Without the ticket the operator's own UPDATE is refused too.
      expect((await asRole(db, null, "update auth.users set encrypted_password = extensions.crypt('Operator-Set-Password-1', extensions.gen_salt('bf')) where id = $1", [me])).error).toMatchObject(REFUSED);
      const { error } = await asRole(db, null, `select public.issue_password_change_ticket('${me}', 'operator');
        update auth.users set encrypted_password = extensions.crypt('Operator-Set-Password-1', extensions.gen_salt('bf')) where id = '${me}';
        delete from auth.mfa_factors where user_id = '${me}';`);
      expect(error).toBeNull();
      expect(await passwordIs(db, me, "Operator-Set-Password-1")).toBe(true);
      expect((await db.query("select 1 from auth.mfa_factors where user_id = $1", [me])).rowCount).toBe(0);
      expect(await tickets(db, me)).toEqual([{ purpose: "operator", used: true, live: true }]);
    });
  });
});

describe("what is not asked", () => {
  it("an UPDATE that leaves the password as it was (sign-in time, ban, metadata, the same hash) is not asked and uses no ticket", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "other-columns");
      await issue(db, me);
      for (const text of [
        "update auth.users set last_sign_in_at = now() where id = $1",
        "update auth.users set banned_until = now() + interval '1 day' where id = $1",
        "update auth.users set raw_app_meta_data = '{\"password_changed_at\":\"x\"}' where id = $1",
        "update auth.users set encrypted_password = encrypted_password where id = $1",
      ]) expect((await asRole(db, authRole, text, [me])).error, text).toBeNull();
      expect(await tickets(db, me)).toEqual([{ purpose: "own_change", used: false, live: true }]);
    });
  });
  it("creating a login with a password (an INSERT: Add user, createUser) is not asked", async () => {
    await rolledBack(async (db) => {
      const id = randomUUID();
      const { error } = await asRole(db, null, "insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at) values ($1, 'authenticated', 'authenticated', $2, $3, now())",
        [id, `insert${EMAIL_SUFFIX}`, await hash(db, "Created-With-Password-1")]);
      expect(error).toBeNull();
    });
  });
  it("Auth's housekeeping: the random password set when an unconfirmed invited login accepts its invite; removing an unconfirmed login's password; a soft delete", async () => {
    await rolledBack(async (db) => {
      const invited = await login(db, "invited", { password: null, confirmed: false, invited: true });
      expect((await authSetsPassword(db, invited, "Random-64-Chars-From-Auth")).error).toBeNull();
      const unconfirmed = await login(db, "unconfirmed", { confirmed: false });
      expect((await asRole(db, authRole, "update auth.users set encrypted_password = null where id = $1", [unconfirmed])).error).toBeNull();
      const deleted = await login(db, "deleted");
      expect((await asRole(db, authRole, "update auth.users set encrypted_password = null, deleted_at = now(), email = 'gone' || $2 where id = $1", [deleted, EMAIL_SUFFIX])).error).toBeNull();
    });
  });
  it("…but not for a confirmed login: removing its password, then setting a 'first' one, are both refused (no way round the ticket)", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "confirmed");
      expect((await asRole(db, authRole, "update auth.users set encrypted_password = null where id = $1", [me])).error).toMatchObject(REFUSED);
      expect((await asRole(db, authRole, "update auth.users set encrypted_password = '' where id = $1", [me])).error).toMatchObject(REFUSED);
      const none = await login(db, "no-password", { password: null });
      expect((await authSetsPassword(db, none, "First-But-Confirmed-1")).error).toMatchObject(REFUSED);
      const invitedConfirmed = await login(db, "invited-confirmed", { password: null, invited: true });
      expect((await authSetsPassword(db, invitedConfirmed, "Invite-Already-Used-1")).error).toMatchObject(REFUSED);
    });
  });
});

describe("who may issue a ticket, and the table itself", () => {
  it("the service role: yes (own_change, admin_set); the owner (SQL editor): yes (operator); a signed-in or anonymous caller: no, even with a grant added", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "issuers");
      expect((await issue(db, me, "own_change")).error).toBeNull();
      expect((await issue(db, me, "admin_set")).error).toBeNull();
      expect((await issue(db, me, "operator", null)).error).toBeNull();
      expect((await issue(db, me, "own_change", "authenticated")).error).toMatchObject({ code: "42501" });
      expect((await issue(db, me, "own_change", "anon")).error).toMatchObject({ code: "42501" });
      expect((await asRole(db, "authenticated", "select public.revoke_password_change_ticket(gen_random_uuid())")).error).toMatchObject({ code: "42501" });
      await db.query("grant execute on function public.issue_password_change_ticket(uuid, text), public.revoke_password_change_ticket(uuid) to authenticated, anon");
      for (const role of ["authenticated", "anon"]) {
        const refused = await issue(db, me, "own_change", role);
        expect(refused.error, role).toMatchObject({ code: "42501", message: "Only the server can allow a password change." });
        expect((await asRole(db, role, "select public.revoke_password_change_ticket(gen_random_uuid())")).error, role).toMatchObject({ code: "42501" });
      }
      expect((await tickets(db, me)).map((t) => t.purpose).sort()).toEqual(["admin_set", "operator", "own_change"]);
    });
  });
  it("an unknown purpose (22023) or login (P0002) is refused", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "bad-args");
      expect((await issue(db, me, "anything")).error).toMatchObject({ code: "22023" });
      expect((await issue(db, randomUUID())).error).toMatchObject({ code: "P0002" });
    });
  });
  it("nobody can read or write the tickets directly (anon, authenticated, service role); nobody can call the trigger function", async () => {
    await rolledBack(async (db) => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await asRole(db, role, "select * from security_audit.password_change_tickets")).error, role).toMatchObject({ code: "42501" });
        expect((await asRole(db, role, "insert into security_audit.password_change_tickets (user_id, purpose, expires_at) values (gen_random_uuid(), 'operator', now() + interval '1 day')")).error, role)
          .toMatchObject({ code: "42501" });
        expect((await asRole<{ x: boolean }>(db, null, "select has_function_privilege($1, 'public.auth_users_password_change_ticket()', 'execute') as x", [role])).rows[0].x).toBe(false);
      }
    });
  });
});

describe("the route path end to end (Auth mocked by its own UPDATE)", () => {
  it("own change: route checks pass > service role issues own_change > Auth stores the password (ticket used) > revoke finds nothing; a direct call afterwards is refused", async () => {
    await rolledBack(async (db) => {
      const me = await login(db, "route-own");
      const ticket = (await issue(db, me, "own_change")).rows[0].t;
      expect((await authSetsPassword(db, me, "Through-The-Route-1")).error).toBeNull();
      expect((await asRole<{ r: boolean }>(db, "service_role", "select public.revoke_password_change_ticket($1) as r", [ticket])).rows[0].r).toBe(false);
      expect(await passwordIs(db, me, "Through-The-Route-1")).toBe(true);
      expect((await authSetsPassword(db, me, "Direct-Afterwards-1")).error).toMatchObject(REFUSED);
    });
  });
  it("admin set (two tenants): company A's admin sets an A member's password with an admin_set ticket; company B's member is not affected by it", async () => {
    await rolledBack(async (db) => {
      const orgs = [randomUUID(), randomUUID()];
      for (const [i, id] of orgs.entries()) {
        await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `137 ${i} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-137-${i}`]);
      }
      const aMember = await login(db, "a-member");
      const bMember = await login(db, "b-member");
      await db.query("insert into public.organization_members (user_id, organization_id, role) values ($1, $2, 'office'), ($3, $4, 'office')", [aMember, orgs[0], bMember, orgs[1]]);
      const ticket = (await issue(db, aMember, "admin_set")).rows[0].t;
      expect((await authSetsPassword(db, bMember, "Cross-Tenant-Password-1")).error).toMatchObject(REFUSED);
      expect((await authSetsPassword(db, aMember, "Admin-Set-Password-1")).error).toBeNull();
      await asRole(db, "service_role", "select public.revoke_password_change_ticket($1)", [ticket]);
      expect(await passwordIs(db, aMember, "Admin-Set-Password-1")).toBe(true);
      expect(await passwordIs(db, bMember, "Old-b-member-Password-1")).toBe(true);
    });
  });
});

describe("verify, preflight, rollback and release", () => {
  const verify = async (db: Client, file: string) => (await db.query<{ check_name: string; ok: boolean }>(read(file))).rows;
  const preflight = async (db: Client) => {
    const rows = (await db.query<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).rows;
    return { marker136: rows.find((r) => r.check.startsWith("marker 136 "))?.value, marker137: rows.find((r) => r.check.startsWith("marker 137 "))?.value,
      needs137: rows.find((r) => r.check.startsWith("137 needs:"))?.value.split(" / ").slice(0, 3).join(" / ") };
  };
  const gone137 = async (db: Client) => (await db.query<{ gone: boolean }>(
    `select to_regclass('security_audit.password_change_tickets') is null and to_regprocedure('public.issue_password_change_ticket(uuid,text)') is null
       and to_regprocedure('public.revoke_password_change_ticket(uuid)') is null and to_regprocedure('public.auth_users_password_change_ticket()') is null
       and not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'password_change_ticket') as gone`)).rows[0].gone;

  it("verify: TRUE on every row (6); preflight: 137 applied, needs true / 5 / 0", async () => {
    await rolledBack(async (db) => {
      const rows = await verify(db, "supabase/verify/password_change_ticket_137.sql");
      expect(rows).toHaveLength(6);
      expect(rows.filter((r) => !r.ok)).toEqual([]);
      expect(await preflight(db)).toEqual({ marker136: "applied", marker137: "applied", needs137: "true / 5 / 0" });
    });
  });
  it("as the test role, which (like hosted postgres) does not own auth.users: rollback, release with no trigger, release with the trigger present (rolled back)", async () => {
    await rolledBack(async (db) => {
      const who = (await db.query<{ u: string; su: boolean; owner: string; owns: boolean }>(
        `select current_user as u, r.rolsuper as su, pg_get_userbyid(c.relowner) as owner, pg_has_role(current_user, c.relowner, 'USAGE') as owns
         from pg_class c, pg_roles r where c.oid = 'auth.users'::regclass and r.rolname = current_user`)).rows[0];
      // On Supabase's image (CI, hosted) auth.users belongs to supabase_auth_admin and postgres is not a member (revoked in the image's
      // 20250421084701 migration); DROP TRIGGER works through supautils.drop_trigger_grants, CREATE TRIGGER through the TRIGGER privilege.
      // A local stand-in connects as a superuser, which owns everything, so only CI proves the non-owner case.
      if (!who.su) expect({ owner: who.owner, owns: who.owns }).toEqual({ owner: "supabase_auth_admin", owns: false });
      await db.query(unwrapped(read("supabase/release/137_password_change_ticket.rollback.sql")));
      expect((await db.query("select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'password_change_ticket'")).rowCount).toBe(0);
      await db.query(unwrapped(read("supabase/release/137_password_change_ticket.release.sql")));
      await db.query(unwrapped(read("supabase/release/137_password_change_ticket.release.sql")));
      expect((await verify(db, "supabase/verify/password_change_ticket_137.sql")).every((r) => r.ok)).toBe(true);
      const me = await login(db, "after-rerelease");
      expect((await authSetsPassword(db, me, "No-Ticket-After-Rerelease-1")).error).toMatchObject(REFUSED);
    });
  });
  it("rollback (rolled back): everything 137 made is gone, a password changes without a ticket again, 136's verify is unchanged, preflight 137 not applied; the release applies again, twice", async () => {
    await rolledBack(async (db) => {
      const before136 = await verify(db, "supabase/verify/recent_second_step_136.sql");
      await db.query(unwrapped(read("supabase/release/137_password_change_ticket.rollback.sql")));
      expect(await gone137(db)).toBe(true);
      expect(await preflight(db)).toMatchObject({ marker136: "applied", marker137: "not applied" });
      expect(await verify(db, "supabase/verify/recent_second_step_136.sql")).toEqual(before136);
      const me = await login(db, "after-rollback");
      expect((await authSetsPassword(db, me, "No-Ticket-Needed-1")).error).toBeNull();
      for (let i = 0; i < 2; i += 1) {
        await db.query(unwrapped(read("supabase/release/137_password_change_ticket.release.sql")));
        expect((await verify(db, "supabase/verify/password_change_ticket_137.sql")).every((r) => r.ok)).toBe(true);
      }
      expect((await authSetsPassword(db, me, "Ticket-Needed-Again-1")).error).toMatchObject(REFUSED);
    });
  });
  it("ordered rollbacks: 137 then 136, and 136 then 137, both end with neither applied; 137 applies without 136 and 136 again on top", async () => {
    for (const order of [["137", "136"], ["136", "137"]]) {
      await rolledBack(async (db) => {
        const files: Record<string, string> = { "136": "supabase/release/136_recent_second_step_admin_changes.rollback.sql", "137": "supabase/release/137_password_change_ticket.rollback.sql" };
        for (const n of order) await db.query(unwrapped(read(files[n])));
        expect(await gone137(db), order.join(">")).toBe(true);
        expect(await preflight(db)).toMatchObject({ marker136: "not applied", marker137: "not applied" });
        await db.query(unwrapped(read("supabase/release/137_password_change_ticket.release.sql")));
        expect((await verify(db, "supabase/verify/password_change_ticket_137.sql")).every((r) => r.ok)).toBe(true);
        await db.query(unwrapped(read("supabase/release/136_recent_second_step_admin_changes.release.sql")));
        expect((await verify(db, "supabase/verify/recent_second_step_136.sql")).every((r) => r.ok)).toBe(true);
        expect(await preflight(db)).toMatchObject({ marker136: "applied", marker137: "applied" });
      });
    }
  });
  describe("marker 137 reads exactly 137's objects: any change makes it 'not applied' (stop)", () => {
    const MD5 = { trigger: "5fa1d17f4950cdf4e41c8a6fea67b2c5", issue: "a2936196b138dd7dee76db6be3b8ed82", revoke: "42f77209ec079fa354f54ef78784a4b4" };
    const SIG = { trigger: "public.auth_users_password_change_ticket()", issue: "public.issue_password_change_ticket(uuid,text)", revoke: "public.revoke_password_change_ticket(uuid)" };
    /** Replaces a function with its own text plus a harmless comment after its first BEGIN: same behaviour, an unknown body. */
    const alter = (db: Client, sig: string) =>
      db.query(`do $d$ begin execute regexp_replace(pg_get_functiondef(to_regprocedure('${sig}')), E'\\nBEGIN\\n', E'\\nBEGIN\\n  -- an unknown version\\n'); end $d$`);
    const changes: Array<[string, (db: Client) => Promise<unknown>, boolean?]> = [
      ["trigger function body changed", (db) => alter(db, SIG.trigger)],
      ["issue function body changed", (db) => alter(db, SIG.issue)],
      ["revoke function body changed", (db) => alter(db, SIG.revoke)],
      ["issue function missing", (db) => db.query(`drop function ${SIG.issue}`)],
      ["revoke function missing", (db) => db.query(`drop function ${SIG.revoke}`)],
      ["trigger missing", (db) => db.query("drop trigger password_change_ticket on auth.users")],
      // ALTER TABLE ... DISABLE TRIGGER needs ownership of the table, and auth.users belongs to supabase_auth_admin (the test role, like
      // hosted postgres, is not a member). So this one case runs on an identical trigger on a scratch table the test owns, with marker
      // 137's text pointed at that table (see SCRATCH below); 137's real functions are used. Every other change is made on auth.users.
      ["trigger disabled", (db) => db.query("alter table t137_scratch.users disable trigger password_change_ticket"), true],
      ["trigger calls another function", (db) => db.query(`drop trigger password_change_ticket on auth.users;
         create trigger password_change_ticket before update on auth.users for each row execute function public.organization_members_recent_second_step()`)],
      ["trigger fires AFTER, not BEFORE", (db) => db.query(`drop trigger password_change_ticket on auth.users;
         create trigger password_change_ticket after update on auth.users for each row execute function ${SIG.trigger}`)],
    ];
    /** Marker 137 as a preflight text reads it (the real file, or a loosened copy), inside the caller's rolled-back transaction. */
    const marker = async (db: Client, text: string) =>
      (await db.query<{ check: string; value: string }>(text)).rows.find((r) => r.check.startsWith("marker 137 "))?.value;
    /** Every change, each in its own rolled-back transaction: what marker 137 reads after it. */
    /** Marker 137's text (only that marker's block) pointed at the scratch table instead of auth.users. */
    const SCRATCH = (text: string) => {
      const start = text.indexOf("('137 password change ticket'");
      const end = text.indexOf("\n),", start);
      const block = text.slice(start, end);
      expect(block.split("'auth.users'::regclass").length - 1).toBe(1);
      return text.slice(0, start) + block.replace("'auth.users'::regclass", "'t137_scratch.users'::regclass") + text.slice(end);
    };
    /** The same trigger as 137's (BEFORE UPDATE FOR EACH ROW, 137's function, enabled) on a table in a scratch schema (rolled back). */
    const scratchTrigger = (db: Client) => db.query(`create schema t137_scratch; create table t137_scratch.users (id uuid);
      create trigger password_change_ticket before update on t137_scratch.users for each row execute function ${SIG.trigger}`);
    const afterEach = async (text: string) => {
      const seen: Record<string, string | undefined> = {};
      for (const [name, change, scratch] of changes) {
        seen[name] = await rolledBack(async (db) => {
          const read137 = scratch ? SCRATCH(text) : text;
          if (scratch) await scratchTrigger(db);
          expect(await marker(db, read137), `${name}: before the change`).toBe("applied");
          await change(db);
          return marker(db, read137);
        });
      }
      return seen;
    };
    const REAL = read("supabase/verify/release_preflight.sql");

    it("marker 137 names the three exact bodies and the trigger's function and timing", () => {
      const start = REAL.indexOf("('137 password change ticket'");
      const line = REAL.slice(start, REAL.indexOf("\n),", start));
      for (const m of Object.values(MD5)) expect(line).toContain(`= '${m}'`);
      expect(line).toContain("t.tgfoid = to_regprocedure('public.auth_users_password_change_ticket()') AND t.tgtype = 19");
      expect(line).toContain("t.tgenabled = 'O'");
    });
    it("with 137 applied: 'applied'; after each change: 'not applied'", async () => {
      const seen = await afterEach(REAL);
      expect(seen).toEqual(Object.fromEntries(changes.map(([name]) => [name, "not applied"])));
    });
    it("each loosened marker (an existence check in place of a body, a looser trigger check) fails the test above", async () => {
      const loosen = (from: string, to: string) => {
        expect(REAL.split(from).length - 1, from).toBe(1);
        return REAL.replace(from, to);
      };
      const mutants: Array<[string, string]> = [
        ["trigger body: existence only", loosen(`AND md5(regexp_replace(p.prosrc, '\\s', '', 'g')) = '${MD5.trigger}')`, ")")],
        ["issue body: existence only", loosen(`AND md5(regexp_replace(p.prosrc, '\\s', '', 'g')) = '${MD5.issue}')`, ")")],
        ["revoke body: existence only", loosen(`AND md5(regexp_replace(p.prosrc, '\\s', '', 'g')) = '${MD5.revoke}')`, ")")],
        ["revoke not checked", loosen(`AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('${SIG.revoke}') AND md5(regexp_replace(p.prosrc, '\\s', '', 'g')) = '${MD5.revoke}')`, "")],
        ["trigger enabled not checked", loosen("AND t.tgname = 'password_change_ticket' AND t.tgenabled = 'O'\n", "AND t.tgname = 'password_change_ticket'\n")],
        ["trigger function and timing not checked", loosen("AND t.tgfoid = to_regprocedure('public.auth_users_password_change_ticket()') AND t.tgtype = 19))", "))")],
      ];
      for (const [name, text] of mutants) {
        const seen = await afterEach(text);
        expect(Object.values(seen).some((v) => v === "applied"), `${name} is caught`).toBe(true);
      }
    });
  });
  it("the guard stops the release when a stored password is in Auth's encrypted form (sign-in would rewrite it)", async () => {
    await rolledBack(async (db) => {
      await db.query(unwrapped(read("supabase/release/137_password_change_ticket.rollback.sql")));
      await db.query("insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at) values ($1, 'authenticated', 'authenticated', $2, '{\"key_id\":\"k\"}', now())",
        [randomUUID(), `encrypted${EMAIL_SUFFIX}`]);
      const error = await errorOf(db.query(unwrapped(read("supabase/release/137_password_change_ticket.release.sql"))));
      expect(error?.message).toMatch(/137: some stored passwords use Auth's column encryption/);
    });
  });
});
