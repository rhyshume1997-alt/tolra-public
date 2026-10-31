/**
 * S6: session revocation. Mirrors tests/scripts/session-revocation-proof.sql case for case (that script is the same proof, runnable
 * with psql on a plain PostgreSQL copy); this file also runs it against the real Auth service in CI.
 *
 * Two layers, and what each one refuses:
 *   * the DATABASE, on every row read and write (migration 036, _session_membership behind every access helper): a membership
 *     switched off or deleted, a role lowered below the table's, a disabled profile, a forced password change, a company that is
 *     not 'active', a support window that expired / was revoked / was reopened under a new grant, a platform owner without aal2.
 *   * the REQUEST HOOK (017/033, check_request_session -> session_is_active): the token's session no longer exists or is past
 *     its not_after. SQLSTATE 28000 "Your session has ended. Sign in again.". Deliberately not in the row helpers, so a plain SQL
 *     select with a dead session still returns rows here: the hook is what refuses every REST/RPC request (and Storage, 033).
 *   * a sign-in ban (auth.users.banned_until in the future, Admin > Users "Disable sign-in"), from migration 119: session_is_active is
 *     false, so the request hook refuses the live token with 28000, and _session_membership gives nothing, so every row rule
 *     refuses too (case 3; SQL proof tests/scripts/ban-ends-session-119.proof.sql).
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), like company-access.test.ts, plus one test through the
 * real API: a signed-in token whose session row is deleted is refused by PostgREST at once.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session: string };
const person = (label: string): Person => ({ id: randomUUID(), email: `${label}-${(counter += 1)}.${run}@example.test`, session: randomUUID() });

const W = { A: randomUUID(), B: randomUUID(), U: person("u"), V: person("v"), P: person("owner"), grant: randomUUID() };

type Claims = { aal?: "aal1" | "aal2"; session?: string | null };
type Probe = { rows: number; org: "A" | "B" | null; role: string | null; sessionActive: boolean; hook: string };

/** What the database says for this token, after `mutate` has changed the world as the database owner. Always rolled back. */
async function asToken<T>(who: Person, claims: Claims, mutate: string[], fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      for (const statement of mutate) await db.query(statement.replaceAll("$A", `'${W.A}'`).replaceAll("$B", `'${W.B}'`).replaceAll("$U", `'${W.U.id}'`).replaceAll("$P", `'${W.P.id}'`).replaceAll("$SU", `'${W.U.session}'`).replaceAll("$SP", `'${W.P.session}'`));
      await db.query("set local role authenticated");
      const session = claims.session === undefined ? who.session : claims.session;
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.id, role: "authenticated", aud: "authenticated", aal: claims.aal ?? "aal1", ...(session ? { session_id: session } : {}) })]);
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}

const orgLetter = (id: string | null) => (id === W.A ? "A" : id === W.B ? "B" : null);

async function probe(db: Client): Promise<Probe> {
  const rows = Number((await db.query<{ n: string }>("select count(*)::text as n from public.customers")).rows[0].n);
  const ctx = (await db.query<{ org: string | null; role: string | null; active: boolean }>(
    "select public.current_user_organization_id()::text as org, public.current_user_role() as role, public.session_is_active() as active")).rows[0];
  let hook = "ok";
  await db.query("savepoint hook");
  try {
    await db.query("select public.check_request_session()");
  } catch (error) {
    hook = (error as { code?: string }).code ?? "error";
    await db.query("rollback to savepoint hook");
  }
  return { rows, org: orgLetter(ctx.org), role: ctx.role, sessionActive: ctx.active, hook };
}

/** The SQLSTATE of an insert into company `org`'s customers, or "inserted". */
async function insertCode(db: Client, org: string): Promise<string> {
  await db.query("savepoint w");
  try {
    await db.query("insert into public.customers (organization_id, name) values ($1, 'revocation probe')", [org]);
    return "inserted";
  } catch (error) {
    await db.query("rollback to savepoint w");
    return (error as { code?: string }).code ?? "error";
  }
}

const live = (rows: number, org: "A" | "B" | null, role: string | null): Probe => ({ rows, org, role, sessionActive: true, hook: "ok" });
const nothing: Probe = live(0, null, null);

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    for (const [id, label] of [[W.A, "a"], [W.B, "b"]] as const) {
      await db.query("insert into public.organizations (id, name, slug) values ($1, $2, $3)", [id, `S6 company ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-s6-${label}`]);
    }
    for (const [p, org] of [[W.U, W.A], [W.V, W.B], [W.P, W.A]] as const) {
      await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
      await db.query(
        `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
         values ($1, $2, $2, 'admin', $3, true, false) on conflict (id) do update set organization_id = excluded.organization_id, active = true, must_change_password = false`, [p.id, p.email, org]);
      await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
    }
    // U administers A only, V administers B only. P is a platform owner with a two-hour SUPPORT membership in A under one grant,
    // and chose A in their session under that grant.
    await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, 'admin', true), ($3, $4, 'admin', true)", [W.U.id, W.A, W.V.id, W.B]);
    await db.query("insert into security_audit.platform_admins (user_id, note) values ($1, 'S6 synthetic platform owner')", [W.P.id]);
    await db.query(
      `insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
       values ($1, $2, 'admin', true, true, now() + interval '2 hours', $3)`, [W.P.id, W.A, W.grant]);
    await db.query("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [W.P.session, W.P.id, W.A, W.grant]);
    await db.query("insert into public.customers (organization_id, name) values ($1, 'A customer 1'), ($1, 'A customer 2'), ($2, 'B customer 1')", [W.A, W.B]);
  });
});

afterAll(async () => {
  await destroySyntheticWorld(run);
});

describe("0. baseline: a signed-in member of A with a live session", () => {
  it("reads and writes A, cannot write B; another company's admin sees only their own", async () => {
    expect(await asToken(W.U, {}, [], async (db) => [await probe(db), await insertCode(db, W.A), await insertCode(db, W.B)]))
      .toEqual([live(2, "A", "admin"), "inserted", "42501"]);
    expect(await asToken(W.V, {}, [], probe)).toEqual(live(1, "B", "admin"));
  });
});

describe("1. membership or account revoked while the session is still alive: the database refuses every row", () => {
  const refused = (mutate: string[], expected: Probe, write = true) =>
    asToken(W.U, {}, mutate, async (db) => [await probe(db), write ? await insertCode(db, W.A) : null]).then((got) => {
      expect(got[0]).toEqual(expected);
      if (write) expect(got[1]).toBe("42501");
    });

  it("membership switched off, or deleted", async () => {
    await refused(["update public.organization_members set active = false where user_id = $U and organization_id = $A"], nothing);
    await refused(["delete from public.organization_members where user_id = $U and organization_id = $A"], nothing, false);
  });
  it("role lowered below the table's (admin -> workshop, viewer): the office tables close at once", async () => {
    await refused(["update public.organization_members set role = 'workshop' where user_id = $U and organization_id = $A"], live(0, "A", "workshop"));
    await refused(["update public.organization_members set role = 'viewer' where user_id = $U and organization_id = $A"], live(0, "A", "viewer"), false);
  });
  it("profile disabled; forced password change pending", async () => {
    await refused(["update public.user_profiles set active = false where id = $U"], nothing);
    await refused(["update public.user_profiles set must_change_password = true where id = $U"], nothing, false);
  });
  it("company paused or closed", async () => {
    await refused(["update public.organizations set status = 'paused' where id = $A"], nothing, false);
    await refused(["update public.organizations set status = 'closed' where id = $A"], nothing, false);
  });
  it("revoking U in A changes nothing for V in B", async () => {
    expect(await asToken(W.V, {}, ["update public.organization_members set active = false where user_id = $U and organization_id = $A"], probe)).toEqual(live(1, "B", "admin"));
  });
});

describe("2. the session itself ends (sign-out, password change, timeout): the request hook refuses with 28000", () => {
  const ended = (rows: number, org: "A" | "B" | null, role: string | null): Probe => ({ rows, org, role, sessionActive: false, hook: "28000" });

  it("the session row deleted, or past its not_after", async () => {
    expect(await asToken(W.U, {}, ["delete from auth.sessions where id = $SU"], probe)).toEqual(ended(2, "A", "admin"));
    expect(await asToken(W.U, {}, ["update auth.sessions set not_after = now() - interval '1 second' where id = $SU"], probe)).toEqual(ended(2, "A", "admin"));
    expect(await asToken(W.U, {}, ["update auth.sessions set not_after = now() + interval '1 hour' where id = $SU"], probe)).toEqual(live(2, "A", "admin"));
  });
  it("a token carrying another person's live session, no session id, or a session that never existed", async () => {
    expect(await asToken(W.U, { session: W.V.session }, [], probe)).toEqual(ended(2, "A", "admin"));
    expect(await asToken(W.U, { session: null }, [], probe)).toEqual(ended(2, "A", "admin"));
    expect(await asToken(W.U, { session: randomUUID() }, [], probe)).toEqual(ended(2, "A", "admin"));
  });
  it("ending U's session does not end V's", async () => {
    expect(await asToken(W.V, {}, ["delete from auth.sessions where id = $SU"], probe)).toEqual(live(1, "B", "admin"));
  });
  it("the login deleted: the sessions cascade away, and the membership and profile with them", async () => {
    expect(await asToken(W.U, {}, ["delete from auth.users where id = $U"], probe)).toEqual({ ...nothing, sessionActive: false, hook: "28000" });
  });
  it("anon requests are not session-checked", async () => {
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role anon");
        await db.query("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true)");
        await expect(db.query("select public.check_request_session()")).resolves.toBeTruthy();
      } finally {
        await db.query("rollback");
      }
    });
  });
});

describe("3. a sign-in ban ends the session at once (119); Deactivate (membership off) is unchanged", () => {
  const ban = (who = "$U") => `update auth.users set banned_until = now() + interval '100 years' where id = ${who}`;
  const off = "update public.organization_members set active = false where user_id = $U and organization_id = $A";
  const ended: Probe = { ...nothing, sessionActive: false, hook: "28000" };
  /** Rows _session_membership() gives this token (no API role may call it, so asked as the owner with the same claims). */
  const membership = async (db: Client) => {
    await db.query("reset role");
    const n = Number((await db.query<{ n: string }>("select count(*)::text as n from public._session_membership()")).rows[0].n);
    await db.query("set local role authenticated");
    return n;
  };

  it("banned_until alone (membership kept): the hook refuses the live token (28000), no membership, no rows, writes refused", async () => {
    expect(await asToken(W.U, {}, [ban()], async (db) => [await probe(db), await membership(db), await insertCode(db, W.A)])).toEqual([ended, 0, "42501"]);
    expect(await asToken(W.U, {}, [], membership)).toBe(1);
  });
  it("a ban that has run out, or is lifted (banned_until NULL), gives the same token everything back", async () => {
    expect(await asToken(W.U, {}, ["update auth.users set banned_until = now() - interval '1 second' where id = $U"], probe)).toEqual(live(2, "A", "admin"));
    expect(await asToken(W.U, {}, [ban(), "update auth.users set banned_until = null where id = $U"], async (db) => [await probe(db), await insertCode(db, W.A)]))
      .toEqual([live(2, "A", "admin"), "inserted"]);
  });
  it("membership off alone is unchanged (session live, nothing resolves); with the ban on top the hook refuses too", async () => {
    expect(await asToken(W.U, {}, [off], probe)).toEqual(nothing);
    expect(await asToken(W.U, {}, [ban(), off], probe)).toEqual(ended);
  });
  it("only the banned login: V and the support session are unchanged; the platform owner's own ban ends the support session", async () => {
    expect(await asToken(W.V, {}, [ban()], probe)).toEqual(live(1, "B", "admin"));
    expect(await asToken(W.P, { aal: "aal2" }, [ban()], probe)).toEqual(live(2, "A", "admin"));
    expect(await asToken(W.P, { aal: "aal2" }, [ban("$P"), "update security_audit.session_company set elevated_until = now() + interval '30 minutes' where session_id = $SP"],
      async (db) => [await probe(db), await insertCode(db, W.A)])).toEqual([ended, "42501"]);
  });
});

describe("4. two companies: the company chosen for the session, and revoking it", () => {
  const both = "insert into public.organization_members (user_id, organization_id, role, active) values ($U, $B, 'admin', true)";
  const choseA = "insert into security_audit.session_company (session_id, user_id, organization_id) values ($SU, $U, $A)";
  it("A chosen: reads A only; A revoked: lands on B and reads nothing of A; both revoked: nothing; none chosen: nothing", async () => {
    expect(await asToken(W.U, {}, [both, choseA], probe)).toEqual(live(2, "A", "admin"));
    expect(await asToken(W.U, {}, [both, choseA, "update public.organization_members set active = false where user_id = $U and organization_id = $A"], async (db) => [await probe(db), await insertCode(db, W.A)]))
      .toEqual([live(1, "B", "admin"), "42501"]);
    expect(await asToken(W.U, {}, [both, choseA, "update public.organization_members set active = false where user_id = $U"], probe)).toEqual(nothing);
    expect(await asToken(W.U, {}, [both], probe)).toEqual(nothing);
  });
});

describe("5. a support session (platform owner inside A through a support membership)", () => {
  const P = (mutate: string[] = [], claims: Claims = { aal: "aal2" }) => asToken(W.P, claims, mutate, probe);
  const write = (mutate: string[] = []) => asToken(W.P, { aal: "aal2" }, mutate, (db) => insertCode(db, W.A));

  it("at aal2 under its grant it reads the company, read-only until elevated; the elevation ends by itself", async () => {
    expect(await P()).toEqual(live(2, "A", "admin"));
    expect(await write()).toBe("42501");
    expect(await write(["update security_audit.session_company set elevated_until = now() + interval '30 minutes' where session_id = $SP"])).toBe("inserted");
    expect(await write(["update security_audit.session_company set elevated_until = now() - interval '1 second' where session_id = $SP"])).toBe("42501");
  });
  it("window expired, revoked by the company's admin, reopened under a new grant, no aal2, off the platform list: the open session sees nothing", async () => {
    expect(await P(["update public.organization_members set expires_at = now() - interval '1 second' where user_id = $P and organization_id = $A"])).toEqual(nothing);
    expect(await P(["update public.organization_members set active = false where user_id = $P and organization_id = $A"])).toEqual(nothing);
    expect(await P(["update public.organization_members set support_grant = gen_random_uuid() where user_id = $P and organization_id = $A"])).toEqual(nothing);
    expect(await P([], { aal: "aal1" })).toEqual(nothing);
    expect(await P(["delete from security_audit.platform_admins where user_id = $P"])).toEqual(nothing);
  });
  it("the support session signed out: the company choice goes with it and the request hook refuses", async () => {
    expect(await P(["delete from auth.sessions where id = $SP"])).toEqual({ ...nothing, sessionActive: false, hook: "28000" });
  });
});

describe("6. through the real API: a revoked session is refused at once", () => {
  let world: SyntheticWorld;
  beforeAll(async () => { world = await createSyntheticWorld(); });
  afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

  it("the token works while its session exists; once the session row is gone PostgREST answers 28000 'Your session has ended'; another login is unaffected", async () => {
    const admin = world.tenants.alpha.users.admin;
    const office = world.tenants.alpha.users.office;
    const client = await signedInClient(admin);
    const other = await signedInClient(office);
    const sessionId = JSON.parse(Buffer.from((await client.auth.getSession()).data.session!.access_token.split(".")[1], "base64url").toString()).session_id as string;
    expect((await client.from("customers").select("id").limit(1)).error).toBeNull();
    await withDb((db) => db.query("delete from auth.sessions where id = $1", [sessionId]));
    const refused = await client.from("customers").select("id").limit(1);
    expect(refused.error).toMatchObject({ code: "28000" });
    expect(refused.error?.message).toMatch(/session has ended/i);
    expect((await client.rpc("my_session")).error).toMatchObject({ code: "28000" });
    expect((await other.from("jobs").select("id").limit(1)).error).toBeNull();
  });

  it("a membership switched off cuts the same live token's data at once, while its session stays valid", async () => {
    const office = world.tenants.alpha.users.office;
    const client = await signedInClient(office);
    expect((await client.from("jobs").select("id").limit(1)).error).toBeNull();
    const before = (await client.rpc("my_session")).data as { organization_id: string | null };
    expect(before.organization_id).toBe(world.tenants.alpha.id);
    await withDb((db) => db.query("update public.organization_members set active = false where user_id = $1 and organization_id = $2", [office.id, world.tenants.alpha.id]));
    const after = await client.from("jobs").select("id");
    expect(after.error).toBeNull(); // the session is still valid: the database answers (not 28000), with nothing
    expect(after.data).toEqual([]);
    expect(((await client.rpc("my_session")).data as { role: string | null } | null)?.role ?? null).toBeNull();
  });
});
