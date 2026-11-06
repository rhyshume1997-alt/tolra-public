/**
 * Independent permission check of release 151 (xero invite hardening), written by a second reviewer. Adds nothing to the release; read-only against
 * the 151 objects. Disposable database only (same fixture as xero-invite-151.test.ts: installs 145..151 if missing, rolls 151 back if it installed it).
 * Proves: owner / SECURITY DEFINER / pinned search_path / ACL (anon, authenticated, service_role, PUBLIC) of every function 151 creates or replaces,
 * the table postures, that a stored function ACL matches the 149 siblings' pattern, and company isolation through the API roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const RELEASE = "supabase/release/151_xero_invite_hardening.release.sql";
const ROLLBACK = "supabase/release/151_xero_invite_hardening.rollback.sql";
type Db = Pick<Client, "query">;
const run = randomBytes(3).toString("hex");
const orgsMade: string[] = [];
const peopleMade: string[] = [];
let weInstalled = false;
let n = 0;
const installed = async (db: Db) => (await db.query("SELECT to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') IS NOT NULL AS t")).rows[0].t as boolean;

const STORE_FN = "public.integration_invite_store_connection(text,uuid,uuid,text,text,text,text,text,text,timestamptz,integer)";
const PICKER_FN = "public.integration_xero_picker_claim(text,text,integer,integer)";
// [signature, who may execute]: "service" = service_role only; "admin" = authenticated (not anon); never PUBLIC; "nobody" = none of the API roles.
const FUNCTIONS: Array<[string, "service" | "admin" | "nobody"]> = [
  ["public.integration_invite_create(text,text,text)", "admin"],
  ["public.integration_invites_open(text)", "admin"],
  ["public.integration_invite_revoke(uuid)", "admin"],
  ["public.integration_invite_peek(text)", "service"],
  ["public.integration_invite_code_issue(text,text)", "service"],
  ["public.integration_invite_code_verify(text,text,text,text)", "service"],
  ["public.integration_oauth_consume_invite(text,text)", "service"],
  ["public.integration_invite_refusal_log(text,text,text,uuid)", "service"],
  ["security_audit.integration_invite_refuse(text,text,text,uuid,uuid)", "nobody"],
  // The two functions the reviewed application head calls (store: the invite's final write after the Xero hand-back; picker claim: the single-use picker nonce). Service role only.
  [STORE_FN, "service"],
  [PICKER_FN, "service"],
];
const REMOVED = ["public.integration_invite_create(text,text)", "public.integration_invite_redeem(text,text,text)"];

async function company(db: Db) {
  const org = randomUUID();
  n += 1;
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [org, `P151 ${run} ${n}`, `t-p151-${run}-${n}`]);
  orgsMade.push(org);
  const id = randomUUID(), session = randomUUID(), email = `${id}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic','admin',$3,true,false)", [id, email, org]);
  peopleMade.push(id);
  await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,'admin',true)", [id, org]);
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id,grant_id) VALUES($1,$2,$3,NULL)", [session, id, org]);
  return { org, id, session, email };
}
type Co = Awaited<ReturnType<typeof company>>;
async function asAdmin<T = Record<string, unknown>>(db: Db, who: Co, sql: string, params: unknown[] = []): Promise<{ rows?: T[]; code?: string }> {
  await db.query("SAVEPOINT p");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: who.id, session_id: who.session, role: "authenticated", aal: "aal2", email: who.email }), who.id]);
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE"); await db.query("RELEASE SAVEPOINT p");
    return { rows };
  } catch (e) { await db.query("ROLLBACK TO SAVEPOINT p"); await db.query("RESET ROLE"); return { code: (e as { code?: string }).code }; }
}
async function asRole<T = Record<string, unknown>>(db: Db, role: "anon" | "service_role" | "authenticated", sql: string, params: unknown[] = []): Promise<{ rows?: T[]; code?: string }> {
  await db.query("SAVEPOINT r");
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE"); await db.query("RELEASE SAVEPOINT r");
    return { rows };
  } catch (e) { await db.query("ROLLBACK TO SAVEPOINT r"); await db.query("RESET ROLE"); return { code: (e as { code?: string }).code }; }
}
async function inTx(fn: (db: Client) => Promise<void>) {
  await withDb(async (db) => { await db.query("BEGIN"); try { await fn(db); } finally { await db.query("ROLLBACK"); } });
}

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  await withDb(async (db) => { if (!(await installed(db))) { await db.query(read(RELEASE)); weInstalled = true; } });
});
afterAll(async () => {
  await withDb(async (db) => {
    for (const org of orgsMade) await db.query("DELETE FROM public.organizations WHERE id=$1", [org]).catch(() => undefined);
    for (const id of peopleMade) await db.query("DELETE FROM auth.users WHERE id=$1", [id]).catch(() => undefined);
    if (weInstalled && (await installed(db))) { await db.query("SET tolra.x151_accept_deleting_open_invites = 'yes'"); await db.query(read(ROLLBACK)); }
  }).catch(() => undefined);
});

describe("(a) every function 151 creates or replaces", () => {
  for (const [sig, who] of FUNCTIONS) {
    it(`${sig}: owner, SECURITY DEFINER, pinned search_path, ACL = ${who}`, async () => {
      await withDb(async (db) => {
        const r = (await db.query(
          `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS def, coalesce(array_to_string(p.proconfig, ','), '') AS cfg,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
                  EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub
           FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig])).rows[0];
        expect(r, `${sig} exists`).toBeTruthy();
        expect(r.owner).toBe((await db.query("SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.integration_connect_invites'::regclass")).rows[0].o);
        expect(r.def).toBe(true);
        expect(r.cfg).toMatch(/^search_path=pg_catalog, public/);
        expect(r.pub).toBe(false);
        expect(r.anon).toBe(false);
        expect({ auth: r.auth, svc: r.svc }).toEqual(who === "service" ? { auth: false, svc: true } : who === "admin" ? { auth: true, svc: expect.any(Boolean) } : { auth: false, svc: false });
      });
    });
  }
  it("the 107 token functions are gone (42883 on call, no catalog entry)", async () => {
    await inTx(async (db) => {
      for (const sig of REMOVED) expect((await db.query("SELECT to_regprocedure($1) AS t", [sig])).rows[0].t).toBeNull();
      expect((await asRole(db, "service_role", "SELECT public.integration_invite_redeem('a','b','c')")).code).toBe("42883");
    });
  });
  it("service-only functions refuse anon and authenticated with 42501; the refusal writer refuses service_role too", async () => {
    await inTx(async (db) => {
      const h = "a".repeat(64);
      const calls: Array<[string, unknown[]]> = [
        ["SELECT public.integration_invite_peek($1)", ["A".repeat(22)]],
        ["SELECT public.integration_invite_code_issue($1,$2)", ["A".repeat(22), h]],
        ["SELECT public.integration_invite_code_verify($1,$2,$3,$4)", ["A".repeat(22), h, h, "v1.a.b.c"]],
        ["SELECT public.integration_oauth_consume_invite('xero',$1)", [h]],
        ["SELECT public.integration_invite_refusal_log('page','unknown_ref',$1,$2)", ["A".repeat(22), randomUUID()]],
        ["SELECT public.integration_invite_store_connection($1,$2,$3,'xero',$4,'Synthetic Ltd',$5,'v1.a.b.c','v1.a.b.c',now() + interval '30 minutes',1)", [h, randomUUID(), randomUUID(), randomUUID().slice(0, 8), randomUUID()]],
        ["SELECT public.integration_xero_picker_claim('xero_picker_use',$1,60,5)", [`${run}${h}`.slice(0, 64)]],
      ];
      for (const [sql, p] of calls) for (const role of ["anon", "authenticated"] as const) expect((await asRole(db, role, sql, p)).code, `${role} ${sql}`).toBe("42501");
      for (const role of ["anon", "authenticated", "service_role"] as const)
        expect((await asRole(db, role, "SELECT security_audit.integration_invite_refuse('page','unknown_ref',NULL,NULL,$1)", [randomUUID()])).code, role).toBe("42501");
    });
  });
});

describe("(b) tables", () => {
  it("invites + oauth states: RLS on, no policy, nothing for PUBLIC/anon/authenticated; refusal log: RLS on, no policy, no role at all", async () => {
    await withDb(async (db) => {
      for (const t of ["public.integration_connect_invites", "public.integration_oauth_states", "security_audit.integration_invite_refusals"]) {
        const r = (await db.query(
          `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS pol,
                  (SELECT count(*)::int FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)) AS api_grants,
                  (SELECT count(*)::int FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 'service_role'::regrole) AS svc_grants
           FROM pg_class c WHERE c.oid = $1::regclass`, [t])).rows[0];
        expect(r, t).toMatchObject({ rls: true, pol: 0, api_grants: 0 });
        if (t.endsWith("refusals")) expect(r.svc_grants, "refusal log: service_role has no direct grant").toBe(0);
      }
      // security_audit schema USAGE for authenticated predates 151 (the table grants above are what protect the log); anon and service_role have none.
      expect((await db.query("SELECT has_schema_privilege('anon','security_audit','USAGE') AS b, has_schema_privilege('service_role','security_audit','USAGE') AS c")).rows[0]).toEqual({ b: false, c: false });
    });
  });
  it("no API role can read invites or refusals through SQL", async () => {
    await inTx(async (db) => {
      for (const role of ["anon", "authenticated"] as const) {
        expect((await asRole(db, role, "SELECT count(*) FROM public.integration_connect_invites")).code, role).toBe("42501");
        expect((await asRole(db, role, "SELECT count(*) FROM security_audit.integration_invite_refusals")).code, role).toBe("42501");
      }
      expect((await asRole(db, "service_role", "SELECT count(*) FROM security_audit.integration_invite_refusals")).code).toBe("42501");
    });
  });
});

describe("(c) company isolation", () => {
  it("another company's admin cannot list, cancel or open (through the server functions) company A's invite; the invite stays A's", async () => {
    await inTx(async (db) => {
      const a = await company(db), b = await company(db);
      const ref = randomBytes(16).toString("base64url");
      const made = (await asAdmin<{ r: { id: string } }>(db, a, "SELECT public.integration_invite_create('xero',$1,'accountant@firm.example') AS r", [ref])).rows![0].r;
      expect((await db.query("SELECT organization_id FROM public.integration_connect_invites WHERE id=$1", [made.id])).rows[0].organization_id).toBe(a.org);
      expect((await asAdmin<{ r: unknown[] }>(db, b, "SELECT public.integration_invites_open('xero') AS r")).rows![0].r).toEqual([]);
      expect((await asAdmin<{ r: boolean }>(db, b, "SELECT public.integration_invite_revoke($1) AS r", [made.id])).rows![0].r).toBe(false);
      expect((await db.query("SELECT revoked_at FROM public.integration_connect_invites WHERE id=$1", [made.id])).rows[0].revoked_at).toBeNull();
      // B's own create can never write A's company, whatever the caller passes (there is no organization argument).
      const refB = randomBytes(16).toString("base64url");
      const madeB = (await asAdmin<{ r: { id: string } }>(db, b, "SELECT public.integration_invite_create('xero',$1,'x@firm.example') AS r", [refB])).rows![0].r;
      expect((await db.query("SELECT organization_id FROM public.integration_connect_invites WHERE id=$1", [madeB.id])).rows[0].organization_id).toBe(b.org);
      // the server-side issue/verify answer with A's company only for A's reference, and a B state never consumes as an A invite.
      const issued = (await asRole<{ r: { organization_id: string } }>(db, "service_role", "SELECT public.integration_invite_code_issue($1,$2) AS r", [ref, "b".repeat(64)])).rows![0].r;
      expect(issued.organization_id).toBe(a.org);
      const hashA = "c".repeat(64);
      await db.query("UPDATE public.integration_connect_invites SET code_sent_at = now() - interval '2 minutes' WHERE id=$1", [made.id]);
      const ok = (await asRole<{ r: { organization_id: string } }>(db, "service_role", "SELECT public.integration_invite_code_verify($1,$2,$3,$4) AS r", [ref, "b".repeat(64), hashA, "v1.a.b.c"])).rows![0].r;
      expect(ok.organization_id).toBe(a.org);
      const st = (await db.query("SELECT organization_id, user_id FROM public.integration_oauth_states WHERE state_hash=$1", [hashA])).rows[0];
      expect(st).toEqual({ organization_id: a.org, user_id: a.id });
      // a different provider cannot consume it; Xero consumes it once and it is A's
      expect((await asRole<{ r: unknown }>(db, "service_role", "SELECT public.integration_oauth_consume_invite('microsoft',$1) AS r", [hashA])).rows![0].r).toBeNull();
      const consumed = (await asRole<{ r: { organization_id: string } }>(db, "service_role", "SELECT public.integration_oauth_consume_invite('xero',$1) AS r", [hashA])).rows![0].r;
      expect(consumed.organization_id).toBe(a.org);
      expect((await asRole<{ r: unknown }>(db, "service_role", "SELECT public.integration_oauth_consume_invite('xero',$1) AS r", [hashA])).rows![0].r).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// (d) The two application-head functions across the release states. Run in one test because each step changes the shared disposable database:
//     149 only (150 and 151 rolled back) -> 150 -> 151 applied -> 151 rolled back -> 151 applied again. The database is put back as it was found.
//     Needs only the database connection (no Supabase Auth API); a missing database fails in beforeAll, it never skips.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const APP_HEAD_FNS: Array<[string, string]> = [[STORE_FN, "integration_invite_store_connection"], [PICKER_FN, "integration_xero_picker_claim"]];
const installed150 = async (db: Db) => (await db.query("SELECT to_regprocedure('public._ai_helper_force_off(uuid,text)') IS NOT NULL AS t")).rows[0].t as boolean;
async function appHeadState(db: Db, sig: string) {
  const r = (await db.query(
    `SELECT p.prosecdef AS def, coalesce(array_to_string(p.proconfig, ','), '') AS cfg,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub
     FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig])).rows[0];
  return r as { def: boolean; cfg: string; anon: boolean; auth: boolean; svc: boolean; pub: boolean } | undefined;
}
async function expectAppHeadAbsent(db: Db, where: string) {
  for (const [sig] of APP_HEAD_FNS) {
    expect(await appHeadState(db, sig), `${sig} must not exist ${where}`).toBeUndefined();
    await db.query("BEGIN"); // asRole uses a savepoint
    try {
      expect((await asRole(db, "service_role", sig.includes("store") ? "SELECT public.integration_invite_store_connection('a',NULL,NULL,'xero','t','n','c','v1.a.b.c','v1.a.b.c',now(),1)" : "SELECT public.integration_xero_picker_claim('b','k',60,5)")).code, `${sig} ${where}: 42883 on call`).toBe("42883");
    } finally { await db.query("ROLLBACK"); }
  }
}
async function expectAppHeadPresent(db: Db, where: string) {
  for (const [sig] of APP_HEAD_FNS) {
    const r = await appHeadState(db, sig);
    expect(r, `${sig} exists ${where}`).toBeTruthy();
    expect(r!.def, `${sig} SECURITY DEFINER ${where}`).toBe(true);
    expect(r!.cfg, `${sig} pinned search_path ${where}`).toMatch(/^search_path=pg_catalog, public/);
    expect({ pub: r!.pub, anon: r!.anon, auth: r!.auth, svc: r!.svc }, `${sig} EXECUTE: service_role only ${where}`).toEqual({ pub: false, anon: false, auth: false, svc: true });
  }
}

describe("(d) integration_invite_store_connection and integration_xero_picker_claim across release states (149 only, 150, 151, rollback of 151, 151 again)", () => {
  it("absent at 149-only and at 150; present with the service-only ACL once 151 is applied; absent after rolling 151 back; present again after re-applying it; database left as found", async () => {
    await withDb(async (db) => {
      const had151 = await installed(db);
      const had150 = await installed150(db);
      expect(had150, "release 150 is installed by the fixture before this test").toBe(true);
      expect(had151, "release 151 is installed (by the fixture or beforeAll) before this test").toBe(true);
      try {
        await expectAppHeadPresent(db, "at the starting state (151 applied)");
        // 151 rolled back: both functions go. (accepting the deletion of any open invite, as the 151 proofs do)
        await db.query("SET tolra.x151_accept_deleting_open_invites = 'yes'");
        await db.query(read(ROLLBACK));
        expect(await installed(db)).toBe(false);
        await expectAppHeadAbsent(db, "after 151 rollback (state: 150)");
        // 150 rolled back too: the 149-only state.
        await db.query(read("supabase/release/150_ai_cap_key_off.rollback.sql"));
        expect(await installed150(db)).toBe(false);
        await expectAppHeadAbsent(db, "at the 149-only state");
        // 150 applied again: still no 151 functions.
        await db.query(read("supabase/release/150_ai_cap_key_off.release.sql"));
        expect(await installed150(db)).toBe(true);
        await expectAppHeadAbsent(db, "at the 150 state");
        // 151 applied.
        await db.query(read(RELEASE));
        expect(await installed(db)).toBe(true);
        await expectAppHeadPresent(db, "after 151 applied");
        // rolled back, then applied again.
        await db.query(read(ROLLBACK));
        expect(await installed(db)).toBe(false);
        await expectAppHeadAbsent(db, "after rollback of 151");
        await db.query(read(RELEASE));
        expect(await installed(db)).toBe(true);
        await expectAppHeadPresent(db, "after 151 re-applied");
      } catch (e) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        // put the database back as found, whatever happened above
        await db.query("RESET tolra.x151_accept_deleting_open_invites").catch(() => undefined);
        if (had150 && !(await installed150(db))) await db.query(read("supabase/release/150_ai_cap_key_off.release.sql"));
        if (had151 && !(await installed(db))) await db.query(read(RELEASE));
      }
      expect(await installed150(db)).toBe(had150);
      expect(await installed(db)).toBe(had151);
      expect((await db.query(read("supabase/verify/xero_invite_hardening_151.sql"))).rows.filter((r) => r.ok !== true)).toEqual([]);
      expect((await db.query(read("supabase/verify/ai_cap_key_off_150.sql"))).rows.filter((r) => (r.ok ?? r.passed) !== true)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// (e) REVOCATION GAP FIXED BY #438 (what this block does and does not cover)
//   The gap (found by the independent 151 verification on e7c4b63): once code_verify set used_at, integration_invite_revoke needed `used_at IS NULL`,
//   so an admin's "cancel" of a link whose Xero connect was already under way did nothing (FALSE), the link stayed listed as open, and only expiry,
//   creator demotion or company closure stopped a pending OAuth state. On this (combined #437 + #438) code the revoke succeeds while a LIVE, NOT YET
//   COMPLETED OAuth state of that invite exists, and integration_invites_open lists such an invite until it completes.
//   COVERED HERE (pure SQL, one connection): (1) used invite + live pending state: listed as open, revoke -> TRUE, no longer listed, the audit row is
//   written, the callback consume then answers {ok:false, reason:'revoked'} and no connection is made; (2) a completed invite is neither listed nor revocable (revoke -> FALSE),
//   and an invite whose only state has expired is not revocable once used.
//   COVERED ELSEWHERE: the lock ordering of revoke against the final store under real concurrency, and the store refusing after a revoke:
//   tests/db/xero-invite-cancel-during-callback-151.test.ts (needs this same database only).
//   NOT COVERED (do not infer it from these tests): the application layer (lib/integrations/server.ts and the callback route, run by the Supabase API at
//   127.0.0.1:54321, which cannot be started here); a token Xero already issued is not revoked at Xero by cancelling the link; the revoke-vs-consume
//   race (consume locks the state row, not the invite, before its own re-check) is not exercised with two live connections; creator demotion mid-flow.
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("(e) cancelling a connect link whose Xero connect is already under way (the revocation gap #438 fixes) - scope stated above", () => {
  const sc = (db: Db) => (sql: string, p: unknown[] = []) => asRole<{ r: unknown }>(db, "service_role", sql, p);
  const openIds = async (db: Db, who: Co) => ((await asAdmin<{ r: Array<{ id: string }> }>(db, who, "SELECT public.integration_invites_open('xero') AS r")).rows![0].r).map((x) => x.id);
  /** create -> code issue -> code verify (sets used_at, makes the OAuth state). Returns the invite, its state hash. */
  async function underWay(db: Db, who: Co) {
    const ref = randomBytes(16).toString("base64url"), codeHash = "d".repeat(64), state = randomBytes(32).toString("hex");
    const made = (await asAdmin<{ r: { id: string } }>(db, who, "SELECT public.integration_invite_create('xero',$1,'accountant@firm.example') AS r", [ref])).rows![0].r;
    await asRole(db, "service_role", "SELECT public.integration_invite_code_issue($1,$2)", [ref, codeHash]);
    await db.query("UPDATE public.integration_connect_invites SET code_sent_at = now() - interval '2 minutes' WHERE id=$1", [made.id]);
    const v = await asRole<{ r: { organization_id: string } }>(db, "service_role", "SELECT public.integration_invite_code_verify($1,$2,$3,$4) AS r", [ref, codeHash, state, "v1.a.b.c"]);
    expect(v.rows![0].r.organization_id).toBe(who.org);
    expect((await db.query("SELECT used_at IS NOT NULL AS used FROM public.integration_connect_invites WHERE id=$1", [made.id])).rows[0].used).toBe(true);
    return { id: made.id, state };
  }
  const conns = async (db: Db, org: string) => (await db.query("SELECT count(*)::int AS n FROM public.integration_connections WHERE organization_id=$1 AND provider='xero'", [org])).rows[0].n as number;

  it("(1) used invite with a live pending state: listed as open; revoke returns TRUE (it was FALSE before #438); gone from the list; audited; the callback consume refuses (ok:false, reason revoked); no connection", async () => {
    await inTx(async (db) => {
      const a = await company(db);
      const inv = await underWay(db, a);
      expect(await openIds(db, a)).toContain(inv.id);
      expect((await asAdmin<{ r: boolean }>(db, a, "SELECT public.integration_invite_revoke($1) AS r", [inv.id])).rows![0].r).toBe(true);
      expect(await openIds(db, a)).not.toContain(inv.id);
      const row = (await db.query("SELECT revoked_at, revoke_reason FROM public.integration_connect_invites WHERE id=$1", [inv.id])).rows[0];
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoke_reason).toBe("cancelled");
      expect((await db.query("SELECT count(*)::int AS n FROM security_audit.audit_log WHERE organization_id=$1 AND action='INTEGRATION_INVITE_REVOKED' AND entity_id=$2", [a.org, inv.id])).rows[0].n).toBe(1);
      expect((await sc(db)("SELECT public.integration_oauth_consume_invite('xero',$1) AS r", [inv.state])).rows![0].r).toMatchObject({ ok: false, reason: "revoked" });
      expect(await conns(db, a.org)).toBe(0);
      // a second cancel of the same link is a plain FALSE
      expect((await asAdmin<{ r: boolean }>(db, a, "SELECT public.integration_invite_revoke($1) AS r", [inv.id])).rows![0].r).toBe(false);
    });
  });

  it("(2) a completed invite is neither listed nor revocable; a used invite whose only state has expired is not revocable and not listed", async () => {
    await inTx(async (db) => {
      const a = await company(db);
      const done = await underWay(db, a);
      await db.query("UPDATE public.integration_oauth_states SET invite_completed_at = now() WHERE via_invite=$1", [done.id]);
      expect(await openIds(db, a)).not.toContain(done.id);
      expect((await asAdmin<{ r: boolean }>(db, a, "SELECT public.integration_invite_revoke($1) AS r", [done.id])).rows![0].r).toBe(false);
      expect((await db.query("SELECT revoked_at FROM public.integration_connect_invites WHERE id=$1", [done.id])).rows[0].revoked_at).toBeNull();

      const stale = await underWay(db, a);
      await db.query("UPDATE public.integration_oauth_states SET expires_at = now() - interval '1 minute' WHERE via_invite=$1", [stale.id]);
      expect(await openIds(db, a)).not.toContain(stale.id);
      expect((await asAdmin<{ r: boolean }>(db, a, "SELECT public.integration_invite_revoke($1) AS r", [stale.id])).rows![0].r).toBe(false);
    });
  });
});
