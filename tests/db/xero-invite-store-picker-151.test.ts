/**
 * Release 151, the two service-only functions the reviewed application head calls and the database did not have (SQLSTATE 42883, undefined_function):
 *   - public.integration_invite_store_connection(...)  -> jsonb : the invite's final write, after the Xero hand-back (lib/integrations/server.ts, service role);
 *   - public.integration_xero_picker_claim(...)        -> boolean : the picker's single-use nonce claim (lib/server/login.ts, service role, bucket xero_picker_use).
 * Pure SQL through the database connection, as the API runs it (service role / authenticated / anon), on a disposable database only.
 * Every case calls the function exactly as the application does (named argument order of the app's rpc payload, positional here).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
type Db = Pick<Client, "query">;
type Err = { code?: string; message: string };
type Json = Record<string, unknown>;
const orgsMade: string[] = [];
const peopleMade: string[] = [];
const run = randomBytes(3).toString("hex");
let counter = 0;

const cipher = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(16).toString("base64url")}.${randomBytes(48).toString("base64url")}`;
const newRef = () => randomBytes(16).toString("base64url");
const newHash = () => randomBytes(32).toString("hex");

async function svc<T = Json>(db: Db, sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: Err }> {
  await db.query("SAVEPOINT xsp");
  try {
    await db.query("SET LOCAL ROLE service_role");
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT xsp");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT xsp");
    await db.query("RESET ROLE");
    return { error: { code: (e as Err).code, message: (e as Err).message } };
  }
}
async function asRole(db: Db, role: "anon" | "authenticated", sql: string, params: unknown[] = []) {
  await db.query("SAVEPOINT xsr");
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: randomUUID(), role })]);
    await db.query(sql, params);
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT xsr");
    return {} as { error?: Err };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT xsr");
    await db.query("RESET ROLE");
    return { error: { code: (e as Err).code, message: (e as Err).message } };
  }
}
const ok = <T>(r: { rows?: T[]; error?: Err }) => { if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`); return r.rows!; };
async function inTx(fn: (db: Client) => Promise<void>) {
  await withDb(async (db) => {
    await db.query("BEGIN");
    try { await fn(db); } finally { await db.query("ROLLBACK"); }
  });
}

async function makeOrg(db: Db, label: string, name?: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, name ?? `XSP ${label} ${run}`, `t-xsp-${run}-${label}-${counter}`]);
  orgsMade.push(id);
  return id;
}
async function makeAdmin(db: Db, org: string) {
  const id = randomUUID(), email = `${id}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic','admin',$3,true,false)", [id, email, org]);
  await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,'admin',true)", [id, org]);
  peopleMade.push(id);
  return { id, email };
}
/** A consumed invite state, exactly as the callback leaves it before the final write: create -> code -> verify -> consume. */
async function consumedState(db: Db, org: string, adminId: string) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: adminId, role: "authenticated", aal: "aal2" })]);
  const ref = newRef(), codeHash = newHash(), state = newHash();
  // the invite row is made the way the admin's call makes it; the table is not readable by the API roles, so the fixture inserts it as the owner
  const sessionId = randomUUID();
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [sessionId, adminId]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id,grant_id) VALUES($1,$2,$3,NULL)", [sessionId, adminId, org]);
  await db.query("SET LOCAL ROLE authenticated");
  await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",
    [JSON.stringify({ sub: adminId, session_id: sessionId, role: "authenticated", aal: "aal2" }), adminId]);
  const made = (await db.query("SELECT public.integration_invite_create('xero',$1,'accountant@firm.example') AS r", [ref])).rows[0].r as { id: string };
  await db.query("RESET ROLE");
  ok(await svc(db, "SELECT public.integration_invite_code_issue($1,$2)", [ref, codeHash]));
  ok(await svc(db, "SELECT public.integration_invite_code_verify($1,$2,$3,$4)", [ref, codeHash, state, cipher()]));
  const c = ok(await svc<{ c: Json | null }>(db, "SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [state]))[0].c;
  expect(c).toMatchObject({ organization_id: org, user_id: adminId });
  return { invite: made.id, ref, state };
}
const STORE = "SELECT public.integration_invite_store_connection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS r";
const storeArgs = (state: string, org: string, user: string, tenantName: string, tenantId = randomUUID()) =>
  [state, org, user, "xero", tenantId, tenantName, randomUUID(), cipher(), cipher(), new Date(Date.now() + 1800_000).toISOString(), 1];
const connections = async (db: Db, org: string) => (await db.query("SELECT status, tenant_name FROM public.integration_connections WHERE organization_id=$1 AND provider='xero'", [org])).rows as Array<{ status: string; tenant_name: string }>;
const completed = async (db: Db, state: string) => (await db.query("SELECT invite_completed_at FROM public.integration_oauth_states WHERE state_hash=$1", [state])).rows[0].invite_completed_at as Date | null;
const refusalReasons = async (db: Db, org: string) => (await db.query("SELECT step, reason FROM security_audit.integration_invite_refusals WHERE organization_id=$1 ORDER BY id", [org])).rows as Array<{ step: string; reason: string }>;

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
});
afterAll(async () => {
  await withDb(async (db) => {
    for (const org of orgsMade) await db.query("DELETE FROM public.organizations WHERE id=$1", [org]).catch(() => undefined);
    for (const id of peopleMade) await db.query("DELETE FROM auth.users WHERE id=$1", [id]).catch(() => undefined);
    await db.query("DELETE FROM public.auth_rate_limits WHERE bucket='xero_picker_use' AND key_hash LIKE $1", [`${run}%`]).catch(() => undefined);
  }).catch(() => undefined);
});

describe("integration_invite_store_connection (11 arguments -> jsonb), service role only", () => {
  it("exists, is SECURITY DEFINER with a pinned search_path, and only the service role may run it", async () => {
    await withDb(async (db) => {
      const sig = "public.integration_invite_store_connection(text,uuid,uuid,text,text,text,text,text,text,timestamp with time zone,integer)";
      const r = (await db.query(
        `SELECT p.prosecdef, p.proconfig, pg_get_function_result(p.oid) AS res,
                has_function_privilege('anon',p.oid,'EXECUTE') AS anon, has_function_privilege('authenticated',p.oid,'EXECUTE') AS authed,
                has_function_privilege('service_role',p.oid,'EXECUTE') AS svc,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_grant
         FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig])).rows[0];
      expect(r, "function missing (SQLSTATE 42883 when called)").toBeDefined();
      expect(r).toMatchObject({ prosecdef: true, res: "jsonb", anon: false, authed: false, svc: true, public_grant: false });
      expect(String(r.proconfig)).toMatch(/search_path=pg_catalog, public, security_audit/);
    });
  });

  it("the whole path: a consumed invite state is stored once, the invite completes, transfers stay OFF; a replay refuses and changes nothing", async () => {
    await inTx(async (db) => {
      const org = await makeOrg(db, "ok", `Acme Ltd ${run}`);
      const admin = await makeAdmin(db, org);
      const s = await consumedState(db, org, admin.id);
      const out = ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, org, admin.id, ` ACME LTD ${run} `)))[0].r;
      expect(out).toMatchObject({ provider: "xero", status: "connected" });
      expect(await connections(db, org)).toHaveLength(1);
      expect(await completed(db, s.state)).not.toBeNull();
      expect((await db.query("SELECT public.integration_xero_transfer_enabled($1) AS t", [org])).rows[0].t).toBe(false);
      const again = ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, org, admin.id, `Acme Ltd ${run}`)))[0].r;
      expect(again).toMatchObject({ ok: false });
      expect(again.correlation_id).toBeTruthy();
      expect(again).not.toHaveProperty("reason");
      expect(await connections(db, org)).toHaveLength(1);
    });
  });

  it("refuses (ok:false, a correlation id, nothing stored) an unknown state, a state not yet consumed, another company or another user", async () => {
    await inTx(async (db) => {
      const a = await makeOrg(db, "a", `Alpha ${run}`), b = await makeOrg(db, "b", `Beta ${run}`);
      const adminA = await makeAdmin(db, a), adminB = await makeAdmin(db, b);
      const s = await consumedState(db, a, adminA.id);
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(newHash(), a, adminA.id, `Alpha ${run}`)))[0].r).toMatchObject({ ok: false });
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, b, adminA.id, `Alpha ${run}`)))[0].r).toMatchObject({ ok: false });
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, a, adminB.id, `Alpha ${run}`)))[0].r).toMatchObject({ ok: false });
      expect(await connections(db, a)).toEqual([]);
      expect(await connections(db, b)).toEqual([]);
      expect(await completed(db, s.state)).toBeNull();
      // a state that was made but never consumed
      const ref = newRef(), codeHash = newHash(), state = newHash();
      const sessionId = randomUUID();
      await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [sessionId, adminA.id]);
      await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id,grant_id) VALUES($1,$2,$3,NULL)", [sessionId, adminA.id, a]);
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",
        [JSON.stringify({ sub: adminA.id, session_id: sessionId, role: "authenticated", aal: "aal2" }), adminA.id]);
      await db.query("SELECT public.integration_invite_create('xero',$1,'accountant@firm.example')", [ref]);
      await db.query("RESET ROLE");
      ok(await svc(db, "SELECT public.integration_invite_code_issue($1,$2)", [ref, codeHash]));
      ok(await svc(db, "SELECT public.integration_invite_code_verify($1,$2,$3,$4)", [ref, codeHash, state, cipher()]));
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(state, a, adminA.id, `Alpha ${run}`)))[0].r).toMatchObject({ ok: false });
      expect(await connections(db, a)).toEqual([]);
    });
  });

  it("expiry and revocation are re-checked at the write, and every refusal lands in the security log", async () => {
    await inTx(async (db) => {
      const org = await makeOrg(db, "exp", `Gamma ${run}`);
      const admin = await makeAdmin(db, org);
      const s1 = await consumedState(db, org, admin.id);
      await db.query("UPDATE public.integration_connect_invites SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE id=$1", [s1.invite]);
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s1.state, org, admin.id, `Gamma ${run}`)))[0].r).toMatchObject({ ok: false });
      const s2 = await consumedState(db, org, admin.id);
      await db.query("UPDATE public.integration_connect_invites SET revoked_at = now() WHERE id=$1", [s2.invite]);
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s2.state, org, admin.id, `Gamma ${run}`)))[0].r).toMatchObject({ ok: false });
      const s3 = await consumedState(db, org, admin.id);
      await db.query("UPDATE public.organization_members SET role='office' WHERE user_id=$1 AND organization_id=$2", [admin.id, org]);
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s3.state, org, admin.id, `Gamma ${run}`)))[0].r).toMatchObject({ ok: false });
      expect(await connections(db, org)).toEqual([]);
      const reasons = (await refusalReasons(db, org)).filter((r) => r.step === "callback").map((r) => r.reason);
      expect(reasons).toEqual(expect.arrayContaining(["expired", "revoked", "creator_not_admin"]));
    });
  });

  it("a Xero organisation whose name differs from the company's CAN connect: the tenant id and name passed are the ones stored", async () => {
    await inTx(async (db) => {
      const org = await makeOrg(db, "name", `Delta Engineering ${run}`);
      const admin = await makeAdmin(db, org);
      const s = await consumedState(db, org, admin.id);
      const tenant = randomUUID();
      const out = ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, org, admin.id, "Delta Trading (Trading Name)", tenant)))[0].r;
      expect(out).toMatchObject({ provider: "xero", status: "connected", tenant_name: "Delta Trading (Trading Name)" });
      const stored = (await db.query("SELECT tenant_id, tenant_name, status FROM public.integration_connections WHERE organization_id=$1 AND provider='xero'", [org])).rows;
      expect(stored).toEqual([{ tenant_id: tenant, tenant_name: "Delta Trading (Trading Name)", status: "connected" }]);
      expect(await completed(db, s.state)).not.toBeNull();
    });
  });

  it("a state belonging to another company is refused and stores nothing, whatever name or tenant is offered", async () => {
    await inTx(async (db) => {
      const a = await makeOrg(db, "xa", `Zeta ${run}`), b = await makeOrg(db, "xb", `Eta ${run}`);
      const adminA = await makeAdmin(db, a), adminB = await makeAdmin(db, b);
      const s = await consumedState(db, a, adminA.id);
      for (const [org, user, name] of [[b, adminB.id, `Eta ${run}`], [b, adminA.id, `Zeta ${run}`], [a, adminB.id, `Zeta ${run}`], [b, adminB.id, `Zeta ${run}`]] as const) {
        expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, org, user, name)))[0].r).toMatchObject({ ok: false });
      }
      expect(await connections(db, a)).toEqual([]);
      expect(await connections(db, b)).toEqual([]);
      expect(await completed(db, s.state)).toBeNull();
    });
  });

  it("the tenant id stored is the one passed; a second call for the completed state (same or another tenant) is refused and changes nothing", async () => {
    await inTx(async (db) => {
      const org = await makeOrg(db, "once", `Theta ${run}`);
      const admin = await makeAdmin(db, org);
      const s = await consumedState(db, org, admin.id);
      const first = randomUUID(), other = randomUUID();
      ok(await svc(db, STORE, storeArgs(s.state, org, admin.id, "Whatever Ltd", first)));
      for (const t of [first, other]) expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, org, admin.id, "Whatever Ltd", t)))[0].r).toMatchObject({ ok: false });
      expect((await db.query("SELECT tenant_id FROM public.integration_connections WHERE organization_id=$1", [org])).rows).toEqual([{ tenant_id: first }]);
      // an empty tenant id is never accepted (the ordinary store refuses it)
      const s2 = await consumedState(db, org, admin.id);
      expect((await svc(db, STORE, storeArgs(s2.state, org, admin.id, "Whatever Ltd", " " as never))).error).toMatchObject({ code: "22023" });
    });
  });

  it("atomic: when the ordinary store fails inside the call (tenant in use by another company; a failing write after the connection row; a failing completion mark) nothing is left behind and the state stays usable", async () => {
    await inTx(async (db) => {
      const a = await makeOrg(db, "at-a", `Iota ${run}`), b = await makeOrg(db, "at-b", `Kappa ${run}`);
      const adminA = await makeAdmin(db, a), adminB = await makeAdmin(db, b);
      const noHalfState = async (state: string) => {
        expect(await connections(db, a)).toEqual([]);
        expect((await db.query("SELECT count(*)::int AS n FROM public.integration_secrets WHERE organization_id=$1", [a])).rows[0].n).toBe(0);
        expect(await completed(db, state)).toBeNull();
        expect((await db.query("SELECT consumed_at IS NOT NULL AS used FROM public.integration_oauth_states WHERE state_hash=$1", [state])).rows[0].used).toBe(true);
      };
      // (1) the tenant belongs to another company: the ordinary store raises 23505 / tenant_in_use
      const taken = randomUUID();
      const sb = await consumedState(db, b, adminB.id);
      ok(await svc(db, STORE, storeArgs(sb.state, b, adminB.id, "Anything", taken)));
      const s = await consumedState(db, a, adminA.id);
      const refused = await svc(db, STORE, storeArgs(s.state, a, adminA.id, "Anything", taken));
      expect(refused.error).toMatchObject({ code: "23505" });
      await noHalfState(s.state);
      // (2) a write AFTER the connection row fails (the secrets insert): the connection row must go with it
      await db.query("CREATE FUNCTION public.x151_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'x151 forced failure' USING ERRCODE = 'P0001'; END $$");
      await db.query("CREATE TRIGGER x151_boom_secrets BEFORE INSERT ON public.integration_secrets FOR EACH ROW EXECUTE FUNCTION public.x151_boom()");
      expect((await svc(db, STORE, storeArgs(s.state, a, adminA.id, "Anything"))).error).toMatchObject({ code: "P0001" });
      await noHalfState(s.state);
      await db.query("DROP TRIGGER x151_boom_secrets ON public.integration_secrets");
      // (3) the completion mark itself fails: the connection and secrets written just before must go too
      await db.query("CREATE TRIGGER x151_boom_state BEFORE UPDATE OF invite_completed_at ON public.integration_oauth_states FOR EACH ROW EXECUTE FUNCTION public.x151_boom()");
      expect((await svc(db, STORE, storeArgs(s.state, a, adminA.id, "Anything"))).error).toMatchObject({ code: "P0001" });
      await noHalfState(s.state);
      await db.query("DROP TRIGGER x151_boom_state ON public.integration_oauth_states");
      await db.query("DROP FUNCTION public.x151_boom()");
      // the state was never completed, so with the cause gone the same state still connects exactly once
      const mine = randomUUID();
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, a, adminA.id, "Anything", mine)))[0].r).toMatchObject({ status: "connected" });
      expect((await db.query("SELECT tenant_id FROM public.integration_connections WHERE organization_id=$1", [a])).rows).toEqual([{ tenant_id: mine }]);
      expect(ok(await svc<{ r: Json }>(db, STORE, storeArgs(s.state, a, adminA.id, "Anything", randomUUID())))[0].r).toMatchObject({ ok: false });
    });
  });

  it("anon and signed-in users are refused (42501); the secrets are never in the audit rows", async () => {
    await inTx(async (db) => {
      const org = await makeOrg(db, "acl", `Eps ${run}`);
      const admin = await makeAdmin(db, org);
      const s = await consumedState(db, org, admin.id);
      expect((await asRole(db, "anon", STORE, storeArgs(s.state, org, admin.id, `Eps ${run}`))).error).toMatchObject({ code: "42501" });
      expect((await asRole(db, "authenticated", STORE, storeArgs(s.state, org, admin.id, `Eps ${run}`))).error).toMatchObject({ code: "42501" });
      const args = storeArgs(s.state, org, admin.id, `Eps ${run}`);
      ok(await svc(db, STORE, args));
      const rows = (await db.query("SELECT metadata::text AS m FROM security_audit.audit_log WHERE organization_id=$1", [org])).rows.map((r) => r.m as string).join("\n");
      for (const secret of [s.state, s.ref, String(args[7]), String(args[8])]) expect(rows).not.toContain(secret);
    });
  });
});

describe("integration_xero_picker_claim (4 arguments -> boolean), service role only", () => {
  const CLAIM = "SELECT public.integration_xero_picker_claim($1,$2,$3,$4) AS ok";
  const keyHash = () => `${run}${randomBytes(29).toString("hex").slice(0, 58)}`;

  it("exists, is SECURITY DEFINER with a pinned search_path, and only the service role may run it", async () => {
    await withDb(async (db) => {
      const r = (await db.query(
        `SELECT p.prosecdef, p.proconfig, pg_get_function_result(p.oid) AS res,
                has_function_privilege('anon',p.oid,'EXECUTE') AS anon, has_function_privilege('authenticated',p.oid,'EXECUTE') AS authed,
                has_function_privilege('service_role',p.oid,'EXECUTE') AS svc,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_grant
         FROM pg_proc p WHERE p.oid = to_regprocedure('public.integration_xero_picker_claim(text,text,integer,integer)')`)).rows[0];
      expect(r, "function missing (SQLSTATE 42883 when called)").toBeDefined();
      expect(r).toMatchObject({ prosecdef: true, res: "boolean", anon: false, authed: false, svc: true, public_grant: false });
      expect(String(r.proconfig)).toMatch(/search_path=pg_catalog, public/);
    });
  });

  it("the first claim of a nonce is true and the second is false (the single-use rule), through the service role", async () => {
    await inTx(async (db) => {
      const key = keyHash();
      expect(ok(await svc<{ ok: boolean }>(db, CLAIM, ["xero_picker_use", key, 600, 1]))[0].ok).toBe(true);
      expect(ok(await svc<{ ok: boolean }>(db, CLAIM, ["xero_picker_use", key, 600, 1]))[0].ok).toBe(false);
      expect(ok(await svc<{ ok: boolean }>(db, CLAIM, ["xero_picker_use", keyHash(), 600, 1]))[0].ok).toBe(true);
    });
  });

  it("bad arguments are refused with 22023; anon and signed-in users with 42501", async () => {
    await inTx(async (db) => {
      for (const bad of [["Bad Bucket!", keyHash(), 600, 1], ["xero_picker_use", "not-a-hash", 600, 1], ["xero_picker_use", keyHash(), 0, 1], ["xero_picker_use", keyHash(), 600, 0], ["xero_picker_use", keyHash(), 86401, 1], ["xero_picker_use", keyHash(), 600, 10001]]) {
        expect((await svc(db, CLAIM, bad)).error, JSON.stringify(bad)).toMatchObject({ code: "22023" });
      }
      expect((await asRole(db, "anon", CLAIM, ["xero_picker_use", keyHash(), 600, 1])).error).toMatchObject({ code: "42501" });
      expect((await asRole(db, "authenticated", CLAIM, ["xero_picker_use", keyHash(), 600, 1])).error).toMatchObject({ code: "42501" });
    });
  });

  it("two real transactions on one nonce: while the first is open the second is refused at once (never waits), and exactly one claim ever succeeds", async () => {
    const key = keyHash();
    const url = isolatedBackend().databaseUrl;
    const a = new Client({ connectionString: url }), b = new Client({ connectionString: url });
    await a.connect(); await b.connect();
    try {
      await a.query("BEGIN"); await b.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role"); await b.query("SET LOCAL ROLE service_role");
      const first = (await a.query(CLAIM, ["xero_picker_use", key, 600, 1])).rows[0].ok;
      const second = (await b.query(CLAIM, ["xero_picker_use", key, 600, 1])).rows[0].ok;
      expect([first, second]).toEqual([true, false]);
      await a.query("COMMIT"); await b.query("ROLLBACK");
      const rows = (await withDb((db) => db.query("SELECT count(*)::int AS n FROM public.auth_rate_limits WHERE bucket='xero_picker_use' AND key_hash=$1", [key]))).rows[0].n;
      expect(rows).toBe(1);
    } finally { await a.end().catch(() => undefined); await b.end().catch(() => undefined); }
  });
});

describe("rolling release 151 back removes both functions and the column; applying again restores them", () => {
  const FNS = ["public.integration_invite_store_connection(text,uuid,uuid,text,text,text,text,text,text,timestamptz,integer)", "public.integration_xero_picker_claim(text,text,integer,integer)"];
  const state = async (db: Db) => ({
    fns: (await db.query("SELECT f, to_regprocedure(f) IS NOT NULL AS here FROM unnest($1::text[]) f", [FNS])).rows.map((r) => r.here as boolean),
    column: (await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='integration_oauth_states' AND column_name='invite_completed_at'")).rows[0].n as number,
    marker: (await db.query(read("supabase/verify/release_preflight.sql"))).rows.find((r) => r.check === "post-144 marker 151 xero_invite_hardening")?.value as string,
  });
  it("(ii) with 145..151 applied they exist and the marker says applied; rollback removes them; (i) the 145..150 state has none and says not applied; the release restores them and refuses a second apply", async () => {
    await withDb(async (db) => {
      expect(await state(db)).toEqual({ fns: [true, true], column: 1, marker: "applied" });
      await db.query("SET tolra.x151_accept_deleting_open_invites = 'yes'");
      await db.query(read("supabase/release/151_xero_invite_hardening.rollback.sql"));
      expect(await state(db)).toEqual({ fns: [false, false], column: 0, marker: "not applied" });
      await expect(db.query("SELECT public.integration_xero_picker_claim('xero_picker_use',$1,600,1)", [newHash()])).rejects.toMatchObject({ code: "42883" });
      await db.query(read("supabase/release/151_xero_invite_hardening.release.sql"));
      expect(await state(db)).toEqual({ fns: [true, true], column: 1, marker: "applied" });
      await expect(db.query(read("supabase/release/151_xero_invite_hardening.release.sql"))).rejects.toThrow(/already exists|applied before/);
      await db.query("ROLLBACK").catch(() => undefined);
      expect(await state(db)).toEqual({ fns: [true, true], column: 1, marker: "applied" });
    });
  });
});
