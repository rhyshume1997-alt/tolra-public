/**
 * Post-144 release 149 (X149): the persisted, per-company Xero transfer switch. Pure SQL through the database connection, as the API runs it
 * (role authenticated with JWT claims, or the service role), on a disposable database only. The verified fixture installs 145, 146, 147 and 149.
 *
 * SEMANTICS proved here (also stated in supabase/verify/xero_launch_hold_149.sql):
 *   - a company has one hold row, OFF by default; every company that exists at install is created OFF, connected or not;
 *   - Connected is not On: a new connection, a reconnect, a fresh consent to the same Xero organisation, another organisation, needs_reconnect, a
 *     disconnect and a deleted connection all put it back OFF; a token refresh does not;
 *   - only an admin of the company, signed in (never a support session), can turn it ON, and only when connected AND mapped, with a fresh
 *     authenticator code where the company requires the second step; OFF is always allowed to an admin; every change is audited with its actor;
 *   - the database function that claims a send (and the retry) refuse while it is OFF, before any row is touched: nothing else can start a send;
 *   - a send already claimed when it goes OFF still records its real result (nothing is stranded in 'sending');
 *   - backlog stays HELD: only a document queued in the current ON period is claimed by itself; anything queued before 149, while OFF, while the
 *     connection needed reconnecting, or in an earlier ON period is claimed only after the company's own admin approves it (fresh authenticator
 *     code always, never support, own company only, audited) on the current connection; switching ON, a reconnect or a retry releases nothing;
 *   - company A's switch never affects company B; no API role (not even the service role) can read or write the hold table;
 *   - the rollback refuses while a connected company is held, restores 084's two functions exactly, and the release can be applied again.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const MARKER = "post-144 marker 149 xero_launch_hold";
type Db = Pick<Client, "query">;
type Actor = { id: string; session: string; org: string; email: string; role: string };
type Err = { code?: string; message: string; hint?: string };
const orgsMade: string[] = [];
const peopleMade: string[] = [];
let counter = 0;
const run = randomBytes(3).toString("hex");

const cipher = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(16).toString("base64url")}.${randomBytes(48).toString("base64url")}`;

async function makeOrg(db: Db, label: string, extra = "") {
  const id = randomUUID();
  counter += 1;
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `X149 ${label} ${run}`, `t-x149-${run}-${label}-${counter}`]);
  if (extra) await db.query(`UPDATE public.organizations SET ${extra} WHERE id=$1`, [id]);
  orgsMade.push(id);
  return id;
}
async function makeActor(db: Db, org: string, role: string, opts: { support?: boolean } = {}): Promise<Actor> {
  const id = randomUUID(), session = randomUUID(), email = `${id}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)", [id, email, role, org]);
  peopleMade.push(id);
  let grant: string | null = null;
  if (opts.support) {
    await db.query("INSERT INTO security_audit.platform_admins(user_id) VALUES($1)", [id]);
    grant = randomUUID();
    await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active,support,expires_at,support_grant) VALUES($1,$2,$3,true,true,now()+interval '2 hours',$4)", [id, org, role, grant]);
  } else {
    await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,true)", [id, org, role]);
  }
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id,grant_id) VALUES($1,$2,$3,$4)", [session, id, org, grant]);
  return { id, session, org, email, role };
}
/** One statement as a signed-in user (aal2 unless said; `recent` adds an authenticator code entered that many seconds ago). */
async function as<T = Record<string, unknown>>(db: Db, who: Actor | "anon", sql: string, params: unknown[] = [], o: { aal?: string; recent?: number } = {}): Promise<{ rows?: T[]; error?: Err }> {
  await db.query("SAVEPOINT x149_call");
  try {
    if (who === "anon") await db.query("SET LOCAL ROLE anon");
    else {
      await db.query("SET LOCAL ROLE authenticated");
      const claims: Record<string, unknown> = { sub: who.id, session_id: who.session, role: "authenticated", aal: o.aal ?? "aal2", email: who.email };
      if (o.recent !== undefined) claims.amr = [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - o.recent }];
      await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify(claims), who.id]);
    }
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT x149_call");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT x149_call");
    await db.query("RESET ROLE");
    const err = e as Err;
    return { error: { code: err.code, message: err.message, hint: err.hint } };
  }
}
async function svc<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: Err }> {
  await db.query("SAVEPOINT x149_svc");
  try {
    await db.query("SET LOCAL ROLE service_role");
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT x149_svc");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT x149_svc");
    await db.query("RESET ROLE");
    const err = e as Err;
    return { error: { code: err.code, message: err.message, hint: err.hint } };
  }
}
const ok = <T>(r: { rows?: T[]; error?: Err }) => { if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`); return r.rows!; };

async function connect(db: Db, org: string, admin: Actor, tenant = `tenant-${randomUUID()}`, externalId = randomUUID()) {
  const state = randomBytes(32).toString("hex");
  ok(await as(db, admin, "SELECT public.integration_oauth_begin('xero',$1,$2)", [state, cipher()]));
  ok(await svc(db, "SELECT public.integration_oauth_consume($1,$2,'xero',$3)", [org, admin.id, state]));
  ok(await svc(db, "SELECT public.integration_store_connection($1,$2,'xero',$3,$4,$5,$6,$7,now()+interval '30 minutes',1)", [org, admin.id, tenant, "Synthetic Xero", externalId, cipher(), cipher()]));
  return tenant;
}
async function mapAll(db: Db, admin: Actor) {
  for (const sql of ["SELECT public.integration_set_mapping('xero','sales_account',null,'200','Sales')", "SELECT public.integration_set_mapping('xero','credit_account',null,'200','Sales')",
    "SELECT public.integration_set_mapping('xero','tax_rate','20','OUTPUT2','VAT 20')"]) ok(await as(db, admin, sql));
}
/** A company that is connected, mapped, and has `n` queued invoices (rows as the issue trigger writes them, for documents that need no content). */
async function company(db: Db, label: string, o: { connected?: boolean; mapped?: boolean; queued?: number; extra?: string } = {}) {
  const org = await makeOrg(db, label, o.extra);
  const admin = await makeActor(db, org, "admin");
  if (o.connected !== false) await connect(db, org, admin);
  if (o.connected !== false && o.mapped !== false) await mapAll(db, admin);
  for (let i = 0; i < (o.queued ?? 0); i += 1) {
    await db.query("INSERT INTO public.integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) VALUES($1,'xero','invoice',$2,$3,'create')", [org, randomUUID(), `INV-X149-${run}-${i}`]);
  }
  return { org, admin };
}
const hold = async (db: Db, org: string) => (await db.query("SELECT enabled FROM public.xero_transfer_hold WHERE organization_id=$1", [org])).rows[0]?.enabled as boolean | undefined;
const claim = async (db: Db, org: string) => ok(await svc<{ r: { blocked: string | null; send: Record<string, unknown> | null } }>(db, "SELECT public.integration_claim_next($1,'xero',120) AS r", [org]))[0].r;
const turn = (db: Db, who: Actor | "anon", on: boolean | null, o: { aal?: string; recent?: number } = {}) => as<{ r: { enabled: boolean } }>(db, who, "SELECT public.integration_xero_set_transfers($1) AS r", [on], o);
const status = async (db: Db, who: Actor) => ok(await as<{ r: Record<string, unknown> }>(db, who, "SELECT public.integration_xero_launch_status() AS r"))[0].r;
const rowStates = async (db: Db, org: string) => (await db.query("SELECT status, attempts, claim_token IS NOT NULL AS claimed FROM public.integration_sends WHERE organization_id=$1 ORDER BY doc_ref", [org])).rows;
/** The admin's review: the held list, and an approval (with an authenticator code entered `recent` seconds ago unless said otherwise). */
const heldList = async (db: Db, who: Actor) => ok(await as<{ r: Array<{ id: string; doc_ref: string; status: string }> }>(db, who, "SELECT public.integration_xero_held_sends() AS r"))[0].r;
const approve = (db: Db, who: Actor | "anon", ids: unknown, o: { aal?: string; recent?: number | null } = {}) =>
  as<{ r: { approved: number; already: number } }>(db, who, "SELECT public.integration_xero_approve_held($1::uuid[]) AS r", [ids], { aal: o.aal, recent: o.recent === null ? undefined : (o.recent ?? 30) });
const queue = async (db: Db, org: string, ref: string, action = "create") =>
  (await db.query("INSERT INTO public.integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) VALUES($1,'xero','invoice',$2,$3,$4) RETURNING id", [org, randomUUID(), ref, action])).rows[0].id as string;
const idsOf = async (db: Db, org: string) => (await db.query("SELECT id FROM public.integration_sends WHERE organization_id=$1 ORDER BY doc_ref", [org])).rows.map((r) => r.id as string);
const auditOf = async (db: Db, org: string) => (await db.query("SELECT actor_user_id, metadata FROM security_audit.audit_log WHERE organization_id=$1 AND action='XERO_TRANSFERS_CHANGED' ORDER BY created_at, id", [org])).rows;
/** A committed unit of work (BEGIN, the steps, COMMIT): the helpers use savepoints, which need a transaction block. */
async function committed<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try { const out = await fn(); await db.query("COMMIT"); return out; } catch (e) { await db.query("ROLLBACK").catch(() => undefined); throw e; }
}
async function inTx(fn: (db: Client) => Promise<void>) {
  await withDb(async (db) => {
    await db.query("BEGIN");
    try { await fn(db); } finally { await db.query("ROLLBACK"); }
  });
}

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
});
afterAll(async () => {
  // Leave 149 installed for anything that runs after this file, even if a test failed half-way.
  await withDb(async (db) => {
    if ((await db.query("SELECT to_regclass('public.xero_transfer_hold') AS t")).rows[0].t === null) await db.query(read("supabase/release/149_xero_launch_hold.release.sql"));
    for (const org of orgsMade) await db.query("DELETE FROM public.organizations WHERE id=$1", [org]).catch(() => undefined);
    for (const id of peopleMade) await db.query("DELETE FROM auth.users WHERE id=$1", [id]).catch(() => undefined);
  }).catch(() => undefined);
});

it("149 is installed: the preflight marker says applied and every verify row is true", async () => {
  await withDb(async (db) => {
    const marker = (await db.query(read("supabase/verify/release_preflight.sql"))).rows.find((r) => r.check === MARKER);
    expect(marker?.value).toBe("applied");
    const checks = (await db.query(read("supabase/verify/xero_launch_hold_149.sql"))).rows;
    expect(checks.length).toBeGreaterThanOrEqual(13);
    expect(checks.filter((r) => r.ok !== true)).toEqual([]);
  });
});

describe("installed on a database that already has connected companies: every one starts OFF", () => {
  it("rollback, then companies connected and mapped with queued invoices, then the release again: all OFF, nothing claimable, rows untouched, verify rows true", async () => {
    await withDb(async (db) => {
      // Back to the state before 149 (a rollback accepted explicitly; nothing is connected yet in a fresh run).
      await db.query("SET tolra.x149_accept_old_sending = 'yes'");
      await db.query(read("supabase/release/149_xero_launch_hold.rollback.sql"));
      expect((await db.query("SELECT to_regclass('public.xero_transfer_hold') AS t")).rows[0].t).toBeNull();
      let a!: Awaited<ReturnType<typeof company>>, b!: typeof a, c!: typeof a, d!: typeof a;
      try {
        await committed(db, async () => {
          a = await company(db, "pre-a", { queued: 3 }); b = await company(db, "pre-b", { mapped: false, queued: 2 }); c = await company(db, "pre-c", { connected: false });
          d = await company(db, "pre-d", { queued: 1 });
          ok(await svc(db, "SELECT public.integration_mark_needs_reconnect($1,'xero','x')", [d.org]));
        });
      } catch (e) { await db.query(read("supabase/release/149_xero_launch_hold.release.sql")); throw e; }
      // Before 149 the plain 084 claim sends for a connected, mapped company: this is the risk 149 closes.
      const before = await rowStates(db, a.org);
      await db.query(read("supabase/release/149_xero_launch_hold.release.sql"));
      await db.query("BEGIN");
      for (const co of [a, b, c, d]) expect(await hold(db, co.org)).toBe(false);
      expect((await db.query("SELECT count(*)::int AS n FROM public.xero_transfer_hold h WHERE h.organization_id = ANY($1)", [[a.org, b.org, c.org, d.org]])).rows[0].n).toBe(4);
      expect((await db.query("SELECT count(*)::int AS n FROM public.xero_transfer_hold WHERE enabled")).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM public.organizations o WHERE NOT EXISTS (SELECT 1 FROM public.xero_transfer_hold h WHERE h.organization_id=o.id)")).rows[0].n).toBe(0);
      expect(await claim(db, a.org)).toEqual({ blocked: "launch_hold", send: null });
      expect(await rowStates(db, a.org)).toEqual(before);
      expect((await claim(db, c.org)).blocked).toBe("not_connected");
      expect((await claim(db, d.org)).blocked).toBe("needs_reconnect");
      const checks = (await db.query(read("supabase/verify/xero_launch_hold_149.sql"))).rows;
      expect(checks.filter((r) => r.ok !== true)).toEqual([]);
      // An EXISTING connection with a queue from before 149: switching ON releases none of it; only the admin's explicit approval does.
      ok(await turn(db, a.admin, true));
      expect(await claim(db, a.org)).toEqual({ blocked: null, send: null });
      expect(await rowStates(db, a.org)).toEqual(before);
      expect((await heldList(db, a.admin)).map((h) => h.status)).toEqual(["pending", "pending", "pending"]);
      expect(await status(db, a.admin)).toMatchObject({ enabled: true, held: 3 });
      ok(await approve(db, a.admin, (await heldList(db, a.admin)).filter((h) => h.doc_ref.endsWith("-0")).map((h) => h.id)));
      expect((await claim(db, a.org)).send).toMatchObject({ doc_ref: `INV-X149-${run}-0` });
      expect(await claim(db, a.org)).toEqual({ blocked: null, send: null });
      expect(await heldList(db, a.admin)).toHaveLength(2);
      await db.query("ROLLBACK");
    });
  });
});

describe("OFF by default, and Connected is not On", () => {
  it("a new connection creates an OFF company: status says connected and mapped but not enabled, the claim answers launch_hold and changes no row", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "def", { queued: 2 });
      expect(await hold(db, org)).toBe(false);
      expect(await status(db, admin)).toMatchObject({ enabled: false, connected: true, mapped: true, status: "connected" });
      // A stale claim (a lease that ran out) is NOT tidied while held: the claim returns before it changes any row.
      await db.query("UPDATE public.integration_sends SET status='sending', claim_token=gen_random_uuid(), claimed_until=now()-interval '1 minute', attempts=1 WHERE organization_id=$1 AND doc_ref LIKE '%-0'", [org]);
      const before = await rowStates(db, org);
      expect(await claim(db, org)).toEqual({ blocked: "launch_hold", send: null });
      expect(await rowStates(db, org)).toEqual(before);
      expect((await db.query("SELECT 1 FROM public.integration_sends WHERE organization_id=$1 AND status='needs_check'", [org])).rows).toHaveLength(0);
    });
  });
  it("a company that is not connected answers its own status first; the switch cannot be turned on for it", async () => {
    await inTx(async (db) => {
      const nc = await company(db, "nc", { connected: false });
      expect((await claim(db, nc.org)).blocked).toBe("not_connected");
      const r = await turn(db, nc.admin, true);
      expect(r.error).toMatchObject({ code: "55000", hint: "not_connected" });
      expect(await status(db, nc.admin)).toMatchObject({ enabled: false, connected: false, mapped: false, status: "not_connected" });
      const rc = await company(db, "rc", { queued: 1 });
      ok(await svc(db, "SELECT public.integration_mark_needs_reconnect($1,'xero','invalid_grant')", [rc.org]));
      expect((await claim(db, rc.org)).blocked).toBe("needs_reconnect");
      expect((await turn(db, rc.admin, true)).error).toMatchObject({ code: "55000", hint: "not_connected" });
    });
  });
  it("turning ON needs mapping: unmapped is refused (not_mapped), mapped is accepted and the claim then sends", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "map", { mapped: false, queued: 1 });
      expect((await turn(db, admin, true)).error).toMatchObject({ code: "55000", hint: "not_mapped" });
      expect(await hold(db, org)).toBe(false);
      await mapAll(db, admin);
      expect(ok(await turn(db, admin, true))[0].r).toEqual({ enabled: true });
      expect(await hold(db, org)).toBe(true);
      // (149 hold) the document queued before ON is held; one queued now goes.
      expect((await claim(db, org)).send).toBeNull();
      await queue(db, org, "INV-MAP-AFTER-ON");
      const got = await claim(db, org);
      expect(got.blocked).toBeNull();
      expect(got.send).toMatchObject({ doc_type: "invoice", action: "create", attempts: 1, doc_ref: "INV-MAP-AFTER-ON" });
    });
  });
});

describe("who may turn it on", () => {
  it("only an admin of this company: office, workshop and viewer, a null choice and anon are refused; the row stays OFF", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "who");
      for (const role of ["office", "workshop", "viewer"]) {
        const person = await makeActor(db, org, role);
        expect((await turn(db, person, true)).error).toMatchObject({ code: "42501" });
      }
      expect((await turn(db, "anon", true)).error?.code).toBe("42501");
      expect((await turn(db, admin, null)).error).toMatchObject({ code: "22023" });
      expect(await hold(db, org)).toBe(false);
      expect((await as(db, makeNonMember(), "SELECT 1")).error).toBeUndefined();
      const office = await makeActor(db, org, "office");
      expect((await as(db, office, "SELECT public.integration_xero_launch_status()")).error).toMatchObject({ code: "42501" });
    });
    function makeNonMember(): Actor { return { id: randomUUID(), session: randomUUID(), org: "", email: "x@example.test", role: "none" }; }
  });
  it("a person with no company at all is refused; a support session of Tolra cannot flip it", async () => {
    await inTx(async (db) => {
      const { org } = await company(db, "sup");
      const support = await makeActor(db, org, "admin", { support: true });
      expect((await turn(db, support, true)).error).toMatchObject({ code: "42501" });
      // Even elevated (the platform owner's write window is open, so has_org_role says admin), a support session is refused by the function itself.
      await db.query("UPDATE security_audit.session_company SET elevated_until = now() + interval '30 minutes' WHERE session_id=$1", [support.session]);
      expect(ok(await as<{ r: boolean }>(db, support, "SELECT public.has_org_role(ARRAY['admin']) AS r"))[0].r).toBe(true);
      expect((await turn(db, support, true)).error).toMatchObject({ code: "42501" });
      expect(await hold(db, org)).toBe(false);
      const stranger = { id: randomUUID(), session: randomUUID(), org: "", email: "s@example.test", role: "admin" };
      await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [stranger.id, stranger.email]);
      expect((await turn(db, stranger, true)).error).toMatchObject({ code: "42501" });
    });
  });
  it("a company that requires the second step needs an authenticator code from the last 15 minutes to turn ON; OFF never does", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "mfa", { extra: "require_admin_mfa = true" });
      expect((await turn(db, admin, true)).error).toMatchObject({ code: "42501", hint: "mfa_recent_required" });
      expect((await turn(db, admin, true, { recent: 20 * 60 })).error).toMatchObject({ hint: "mfa_recent_required" });
      expect((await turn(db, admin, true, { recent: -3600 })).error).toMatchObject({ hint: "mfa_recent_required" });
      expect(await hold(db, org)).toBe(false);
      expect(ok(await turn(db, admin, true, { recent: 60 }))[0].r.enabled).toBe(true);
      expect(await hold(db, org)).toBe(true);
      expect(ok(await turn(db, admin, false))[0].r.enabled).toBe(false);
      expect(await hold(db, org)).toBe(false);
    });
  });
  it("every change that is made is audited with its actor; a repeat of the same choice adds nothing", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "aud");
      expect(await auditOf(db, org)).toHaveLength(0);
      ok(await turn(db, admin, true)); ok(await turn(db, admin, true)); ok(await turn(db, admin, false)); ok(await turn(db, admin, false));
      const rows = await auditOf(db, org);
      expect(rows.map((r) => [r.actor_user_id, r.metadata.enabled, r.metadata.was])).toEqual([[admin.id, true, false], [admin.id, false, true]]);
    });
  });
});

describe("a connection change puts the company back OFF (a token refresh does not)", () => {
  it("reconnect, fresh consent to the same organisation, another organisation, needs_reconnect, disconnect and a deleted connection", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "reset", { queued: 1 });
      const on = async () => { ok(await turn(db, admin, true)); expect(await hold(db, org)).toBe(true); };
      await on();
      // A token refresh / lease / a touched updated_at is not a new connection.
      await db.query("UPDATE public.integration_connections SET updated_at = now() + interval '1 second' WHERE organization_id=$1", [org]);
      await svc(db, "UPDATE public.integration_secrets SET lease_until = now() WHERE organization_id=$1", [org]);
      expect(await hold(db, org)).toBe(true);
      // A fresh consent to the SAME Xero organisation (a different connected_at) resets it.
      const tenant = (await db.query("SELECT tenant_id FROM public.integration_connections WHERE organization_id=$1", [org])).rows[0].tenant_id as string;
      await db.query("SELECT pg_sleep(0.01)");
      await connect(db, org, admin, tenant);
      expect(await hold(db, org)).toBe(false);
      await on();
      ok(await svc(db, "SELECT public.integration_mark_needs_reconnect($1,'xero','invalid_grant')", [org]));
      expect(await hold(db, org)).toBe(false);
      await connect(db, org, admin, tenant); // connected again: still OFF
      expect(await hold(db, org)).toBe(false);
      await on();
      ok(await as(db, admin, "SELECT public.integration_disconnect('xero')"));
      expect(await hold(db, org)).toBe(false);
      expect((await turn(db, admin, true)).error).toMatchObject({ hint: "not_connected" });
      await connect(db, org, admin, `tenant-other-${randomUUID()}`);
      expect(await hold(db, org)).toBe(false);
      await on();
      await db.query("DELETE FROM public.integration_secrets WHERE organization_id=$1", [org]);
      await db.query("DELETE FROM public.integration_connections WHERE organization_id=$1", [org]);
      expect(await hold(db, org)).toBe(false);
      expect(await claim(db, org)).toMatchObject({ blocked: "not_connected" });
      // Each reset that switched it off was audited with the reason.
      const resets = (await auditOf(db, org)).filter((r) => r.metadata.because === "connection changed");
      expect(resets.length).toBeGreaterThanOrEqual(4);
    });
  });
});

describe("a fresh consent, in its own transaction, as the callback runs it", () => {
  it("the same Xero organisation and the same Xero connection id, consented to again later: only the new consent time differs, and that alone puts the company back OFF", async () => {
    const co = await withDb((db) => committed(db, () => company(db, "consent", { queued: 1 })));
    const keep = await withDb(async (db) => (await db.query("SELECT tenant_id, external_connection_id FROM public.integration_connections WHERE organization_id=$1", [co.org])).rows[0]);
    await withDb((db) => committed(db, async () => { ok(await turn(db, co.admin, true)); }));
    expect(await withDb((db) => hold(db, co.org))).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    await withDb((db) => committed(db, () => connect(db, co.org, co.admin, keep.tenant_id, keep.external_connection_id)));
    await withDb(async (db) => {
      const row = (await db.query("SELECT tenant_id, external_connection_id, status FROM public.integration_connections WHERE organization_id=$1", [co.org])).rows[0];
      expect(row).toEqual({ tenant_id: keep.tenant_id, external_connection_id: keep.external_connection_id, status: "connected" });
      expect(await hold(db, co.org)).toBe(false);
      expect((await committed(db, () => claim(db, co.org))).blocked).toBe("launch_hold");
    });
  });
});

describe("the database refuses every route into a send while OFF, and lets exactly the enabled company through", () => {
  it("claim (sweep / after-issue / Send now / batch all go through it) and retry refuse; a foreign company's retry is still 'not found'", async () => {
    await inTx(async (db) => {
      const a = await company(db, "ra", { queued: 2 }), b = await company(db, "rb", { queued: 1 });
      const failed = (await db.query("UPDATE public.integration_sends SET status='failed', last_error='x' WHERE organization_id=$1 AND doc_ref LIKE '%-0' RETURNING id", [a.org])).rows[0].id as string;
      expect((await as(db, a.admin, "SELECT public.integration_retry_send($1)", [failed])).error).toMatchObject({ code: "55000", hint: "xero_launch_hold" });
      expect((await as(db, b.admin, "SELECT public.integration_retry_send($1)", [failed])).error).toMatchObject({ code: "P0002" });
      expect((await db.query("SELECT status FROM public.integration_sends WHERE id=$1", [failed])).rows[0].status).toBe("failed");
      expect((await claim(db, a.org)).blocked).toBe("launch_hold");
      expect((await claim(db, b.org)).blocked).toBe("launch_hold");
      ok(await turn(db, a.admin, true));
      expect((await claim(db, b.org)).blocked).toBe("launch_hold"); // company isolation: A's switch is not B's
      // (149 hold) ON does not release the failed row queued before it: the retry refuses it until an admin approves it.
      expect((await as(db, a.admin, "SELECT public.integration_retry_send($1)", [failed])).error).toMatchObject({ code: "55000", hint: "xero_held_for_review" });
      expect((await db.query("SELECT status FROM public.integration_sends WHERE id=$1", [failed])).rows[0].status).toBe("failed");
      ok(await approve(db, a.admin, [failed]));
      expect(ok(await as(db, a.admin, "SELECT public.integration_retry_send($1) AS r", [failed]))[0]).toMatchObject({ r: { status: "pending" } });
      const got = await claim(db, a.org);
      expect(got.send).toMatchObject({ id: failed });
      expect(await claim(db, a.org)).toEqual({ blocked: null, send: null }); // the other row queued before ON is still held
      expect((await claim(db, b.org)).blocked).toBe("launch_hold");
      expect((await rowStates(db, b.org))).toEqual([{ status: "pending", attempts: 0, claimed: false }]);
    });
  });
  it("switched OFF after a send was claimed: its real result is still recorded (never stranded in 'sending'), and nothing further is claimed", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "mid", { queued: 0 });
      ok(await turn(db, admin, true));
      for (let i = 0; i < 3; i += 1) await queue(db, org, `INV-MID-${i}`); // queued while ON (this ON period)
      const got = (await claim(db, org)).send as { id: string; claim: string };
      expect(got).toBeTruthy();
      ok(await turn(db, admin, false));
      const rec = ok(await svc<{ r: { recorded: boolean } }>(db, "SELECT public.integration_record_result($1,$2,'sent','xero-1','INV-1',null,null) AS r", [got.id, got.claim]))[0].r;
      expect(rec.recorded).toBe(true);
      expect((await db.query("SELECT status FROM public.integration_sends WHERE id=$1", [got.id])).rows[0].status).toBe("sent");
      expect((await db.query("SELECT count(*)::int AS n FROM public.integration_sends WHERE organization_id=$1 AND status='sending'", [org])).rows[0].n).toBe(0);
      expect((await claim(db, org)).blocked).toBe("launch_hold");
      // A row the app put back to pending (release path) is written fine and waits.
      const second = await db.query("UPDATE public.integration_sends SET status='pending' WHERE organization_id=$1 AND status='pending' RETURNING id", [org]);
      expect(second.rowCount).toBeGreaterThan(0);
    });
  });
  it("documents issued while OFF are queued (nothing is dropped) and stay HELD when an admin turns the switch on, until the admin approves them", async () => {
    // Changed deliberately for the backlog hold: this test used to expect switch-on to release INV-KEPT by itself.
    await inTx(async (db) => {
      const { org, admin } = await company(db, "kept", { queued: 0 });
      await db.query("INSERT INTO public.integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) VALUES($1,'xero','invoice',$2,'INV-KEPT','create')", [org, randomUUID()]);
      expect((await rowStates(db, org))).toHaveLength(1);
      expect((await claim(db, org)).send).toBeNull();
      ok(await turn(db, admin, true));
      expect(await claim(db, org)).toEqual({ blocked: null, send: null });
      expect((await heldList(db, admin)).map((h) => h.doc_ref)).toEqual(["INV-KEPT"]);
      ok(await approve(db, admin, (await heldList(db, admin)).map((h) => h.id)));
      expect((await claim(db, org)).send).toMatchObject({ doc_ref: "INV-KEPT" });
    });
  });
  it("the sweep list holds only companies that are ON and connected", async () => {
    await inTx(async (db) => {
      const on = await company(db, "sw-on"), off = await company(db, "sw-off");
      ok(await turn(db, on.admin, true));
      const list = (ok(await svc<{ id: string }>(db, "SELECT x AS id FROM unnest(public.integration_xero_enabled_orgs()) x"))).map((r) => r.id);
      expect(list).toContain(on.org);
      expect(list).not.toContain(off.org);
      ok(await svc(db, "SELECT public.integration_mark_needs_reconnect($1,'xero','x')", [on.org]));
      expect((ok(await svc<{ id: string }>(db, "SELECT x AS id FROM unnest(public.integration_xero_enabled_orgs()) x"))).map((r) => r.id)).not.toContain(on.org);
    });
  });
});

describe("backlog release: what was waiting stays HELD until an admin approves it (no automatic release)", () => {
  it("switch-on, a new ON period, a reconnect and a retry release nothing that was waiting; an approval releases it for the current connection only", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "backlog", { queued: 0 });
      const x = await queue(db, org, "INV-BL-1-OFF");              // queued while OFF (connected, mapped)
      ok(await turn(db, admin, true));
      expect(await claim(db, org)).toEqual({ blocked: null, send: null }); // switch-on released nothing
      const y = await queue(db, org, "INV-BL-2-ON");               // queued in this ON period: goes by itself
      expect((await claim(db, org)).send).toMatchObject({ id: y });
      const w = await queue(db, org, "INV-BL-3-ON-EARLIER");       // queued while ON, not yet sent ...
      ok(await turn(db, admin, false));
      const z = await queue(db, org, "INV-BL-4-OFF-AGAIN");
      ok(await turn(db, admin, true));                              // ... a new ON period: W is backlog now too
      expect(await claim(db, org)).toEqual({ blocked: null, send: null });
      expect((await heldList(db, admin)).map((h) => h.id)).toEqual([x, w, z].sort((p, q) => (p < q ? -1 : 1)));
      expect(await status(db, admin)).toMatchObject({ enabled: true, held: 3 });
      // Approval of X (fresh code) releases X only.
      expect(ok(await approve(db, admin, [x]))[0].r).toEqual({ approved: 1, already: 0 });
      expect((await claim(db, org)).send).toMatchObject({ id: x });
      expect(await claim(db, org)).toEqual({ blocked: null, send: null });
      // An approval is for this connection only: approve W, then a reconnect (same organisation, fresh consent) puts W back on hold.
      ok(await approve(db, admin, [w]));
      await connect(db, org, admin, (await db.query("SELECT tenant_id FROM public.integration_connections WHERE organization_id=$1", [org])).rows[0].tenant_id);
      expect(await hold(db, org)).toBe(false);
      ok(await turn(db, admin, true));
      expect(await claim(db, org)).toEqual({ blocked: null, send: null });
      expect((await heldList(db, admin)).map((h) => h.id).sort()).toEqual([w, z].sort());
      // needs_reconnect then connected again: still held. A retry of a held failed row is refused and changes nothing.
      ok(await svc(db, "SELECT public.integration_mark_needs_reconnect($1,'xero','invalid_grant')", [org]));
      await connect(db, org, admin, (await db.query("SELECT tenant_id FROM public.integration_connections WHERE organization_id=$1", [org])).rows[0].tenant_id);
      ok(await turn(db, admin, true));
      await db.query("UPDATE public.integration_sends SET status='failed', last_error='x' WHERE id=$1", [z]);
      expect((await as(db, admin, "SELECT public.integration_retry_send($1)", [z])).error).toMatchObject({ code: "55000", hint: "xero_held_for_review" });
      expect((await db.query("SELECT status FROM public.integration_sends WHERE id=$1", [z])).rows[0].status).toBe("failed");
      expect(await claim(db, org)).toEqual({ blocked: null, send: null });
      // Approved on THIS connection: the failed one can be retried and sent, the waiting one goes.
      ok(await approve(db, admin, [w, z]));
      ok(await as(db, admin, "SELECT public.integration_retry_send($1)", [z]));
      const sent = [(await claim(db, org)).send?.id, (await claim(db, org)).send?.id].sort();
      expect(sent).toEqual([w, z].sort());
      expect(await heldList(db, admin)).toEqual([]);
      expect(await status(db, admin)).toMatchObject({ held: 0 });
    });
  });

  it("approving is the company's own admin only, with a fresh authenticator code every time, never support, never another company's document, audited", async () => {
    await inTx(async (db) => {
      const a = await company(db, "apA", { queued: 2 }), b = await company(db, "apB", { queued: 1 });
      const [a1, a2] = await idsOf(db, a.org);
      const [b1] = await idsOf(db, b.org);
      for (const role of ["office", "workshop", "viewer"]) {
        const person = await makeActor(db, a.org, role);
        expect((await approve(db, person, [a1])).error, role).toMatchObject({ code: "42501" });
        expect((await as(db, person, "SELECT public.integration_xero_held_sends()")).error, role).toMatchObject({ code: "42501" });
      }
      expect((await approve(db, "anon", [a1])).error?.code).toBe("42501");
      expect((await svc(db, "SELECT public.integration_xero_approve_held(ARRAY[$1]::uuid[])", [a1])).error).toMatchObject({ code: "42501" });
      expect((await svc(db, "SELECT public.integration_xero_held_sends()")).error).toMatchObject({ code: "42501" });
      const support = await makeActor(db, a.org, "admin", { support: true });
      await db.query("UPDATE security_audit.session_company SET elevated_until = now() + interval '30 minutes' WHERE session_id=$1", [support.session]);
      expect((await approve(db, support, [a1])).error).toMatchObject({ code: "42501" });
      // the second step, recent: none, an old code, aal1
      expect((await approve(db, a.admin, [a1], { recent: null })).error).toMatchObject({ code: "42501", hint: "mfa_recent_required" });
      expect((await approve(db, a.admin, [a1], { recent: 1000 })).error).toMatchObject({ code: "42501", hint: "mfa_recent_required" });
      expect((await approve(db, a.admin, [a1], { aal: "aal1", recent: null })).error?.code).toBe("42501");
      // company isolation: B's document, or a list with one of B's, approves nothing at all
      expect((await approve(db, a.admin, [b1])).error).toMatchObject({ code: "P0002" });
      expect((await approve(db, a.admin, [a1, b1])).error).toMatchObject({ code: "P0002" });
      expect((await heldList(db, b.admin)).map((h) => h.id)).toEqual([b1]);
      expect((await heldList(db, a.admin)).map((h) => h.id).sort()).toEqual([a1, a2].sort());
      // bad lists
      for (const bad of [[], null, [a1, a1], [null]]) expect((await approve(db, a.admin, bad)).error?.code, JSON.stringify(bad)).toBe("22023");
      expect((await approve(db, a.admin, Array.from({ length: 201 }, () => randomUUID()))).error?.code).toBe("22023");
      expect((await db.query("SELECT count(*)::int AS n FROM public.xero_send_release WHERE approved_epoch IS NOT NULL AND organization_id = ANY($1)", [[a.org, b.org]])).rows[0].n).toBe(0);
      // a sent document is not held: refused
      await db.query("UPDATE public.integration_sends SET status='sent', external_id='x-1' WHERE id=$1", [a2]);
      expect((await approve(db, a.admin, [a2])).error).toMatchObject({ code: "22023", hint: "not_held" });
      // the real approval: audited with the actor; a repeat approves nothing new and adds no audit row
      expect(ok(await approve(db, a.admin, [a1]))[0].r).toEqual({ approved: 1, already: 0 });
      expect(ok(await approve(db, a.admin, [a1]))[0].r).toEqual({ approved: 0, already: 1 });
      const audit = (await db.query("SELECT actor_user_id, metadata FROM security_audit.audit_log WHERE organization_id=$1 AND action='XERO_HELD_SENDS_APPROVED'", [a.org])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(a.admin.id);
      expect(audit[0].metadata).toMatchObject({ sends: [a1], count: 1, actor: a.admin.id });
      // B is untouched by A's approval; approving while OFF sends nothing (claim still launch_hold)
      expect((await heldList(db, b.admin)).map((h) => h.id)).toEqual([b1]);
      expect((await claim(db, a.org)).blocked).toBe("launch_hold");
      // not connected: refused
      const nc = await company(db, "apNC", { connected: false });
      expect((await approve(db, nc.admin, [a1])).error).toMatchObject({ code: "55000", hint: "not_connected" });
      // nobody reads or writes the review table directly
      for (const sql of ["SELECT * FROM public.xero_send_release", `UPDATE public.xero_send_release SET approved_epoch=0 WHERE organization_id='${b.org}'`, `INSERT INTO public.xero_send_release(send_id,organization_id,queued_generation) VALUES('${b1}','${b.org}',1)`, "DELETE FROM public.xero_send_release"]) {
        expect((await as(db, b.admin, sql)).error?.code, sql).toBe("42501");
        expect((await as(db, "anon", sql)).error?.code, sql).toBe("42501");
        expect((await svc(db, sql)).error?.code, sql).toBe("42501");
      }
      for (const sql of ["SELECT public.integration_xero_send_released($1, $1)"]) {
        expect((await as(db, a.admin, sql, [a1])).error?.code).toBe("42501");
        expect((await svc(db, sql, [a1])).error?.code).toBe("42501");
      }
    });
  });

  it("the rollback refuses while a queued document is still held for review, even when every connected company is ON", async () => {
    // The rollback's own guard (its DO block, unchanged from the file), run inside a transaction that is rolled back: every connected company
    // is ON here, so only the held-backlog condition can refuse.
    const rb = read("supabase/release/149_xero_launch_hold.rollback.sql");
    const guard = rb.slice(rb.indexOf("DO $rb$"), rb.indexOf("END $rb$;") + "END $rb$;".length);
    await inTx(async (db) => {
      const co = await company(db, "rb-backlog", { queued: 1 });
      ok(await turn(db, co.admin, true));
      await db.query("UPDATE public.xero_transfer_hold h SET enabled = true FROM public.integration_connections c WHERE c.organization_id = h.organization_id AND c.provider = 'xero' AND c.status = 'connected'");
      await db.query("SAVEPOINT g1");
      await expect(db.query(guard)).rejects.toThrow(/^149 rollback refused: a queued Xero document is still held for review/);
      await db.query("ROLLBACK TO SAVEPOINT g1");
      // Once nothing anywhere is held (approved here), the same guard lets the rollback through.
      const held = (await db.query("SELECT s.id FROM public.integration_sends s WHERE s.provider='xero' AND s.status IN ('pending','failed','needs_check') AND NOT public.integration_xero_send_released(s.organization_id, s.id)")).rows;
      await db.query("UPDATE public.integration_sends SET status='skipped' WHERE id = ANY($1) AND organization_id <> $2", [held.map((r) => r.id), co.org]);
      ok(await approve(db, co.admin, (await heldList(db, co.admin)).map((h) => h.id)));
      await db.query(guard);
    });
  });
});

describe("nobody reads or writes the hold table or the gate except through the functions", () => {
  it("anon, authenticated and even the service role cannot touch the table; the gate and sweep list are not callable by browsers", async () => {
    await inTx(async (db) => {
      const { org, admin } = await company(db, "acl");
      for (const sql of ["SELECT * FROM public.xero_transfer_hold", `UPDATE public.xero_transfer_hold SET enabled=true WHERE organization_id='${org}'`, `INSERT INTO public.xero_transfer_hold(organization_id,enabled) VALUES('${randomUUID()}',true)`, "DELETE FROM public.xero_transfer_hold"]) {
        expect((await as(db, admin, sql)).error?.code, sql).toBe("42501");
        expect((await as(db, "anon", sql)).error?.code, sql).toBe("42501");
        expect((await svc(db, sql)).error?.code, sql).toBe("42501");
      }
      expect(await hold(db, org)).toBe(false);
      for (const sql of ["SELECT public.integration_xero_transfer_enabled($1)", "SELECT public.integration_xero_enabled_orgs()"]) {
        expect((await as(db, admin, sql, sql.includes("$1") ? [org] : [])).error?.code, sql).toBe("42501");
        expect((await as(db, "anon", sql, sql.includes("$1") ? [org] : [])).error?.code, sql).toBe("42501");
      }
      expect((await svc(db, "SELECT public.integration_xero_connection_reset()")).error).toBeDefined();
      expect((await svc(db, "SELECT public.integration_xero_set_transfers(true)")).error).toMatchObject({ code: "42501" });
      expect((await svc(db, "SELECT public.integration_xero_launch_status()")).error).toMatchObject({ code: "42501" });
    });
  });
  it("company A's admin switches A only; B's admin switches B only; neither can address the other", async () => {
    await inTx(async (db) => {
      const a = await company(db, "isoA", { queued: 1 }), b = await company(db, "isoB", { queued: 1 });
      ok(await turn(db, a.admin, true));
      expect([await hold(db, a.org), await hold(db, b.org)]).toEqual([true, false]);
      expect(await status(db, b.admin)).toMatchObject({ enabled: false });
      expect(await status(db, a.admin)).toMatchObject({ enabled: true });
      ok(await turn(db, b.admin, true));
      ok(await turn(db, a.admin, false));
      expect([await hold(db, a.org), await hold(db, b.org)]).toEqual([false, true]);
      expect((await claim(db, a.org)).blocked).toBe("launch_hold");
      expect((await claim(db, b.org)).send).toBeNull(); // B's document queued before B was ON is held
      await queue(db, b.org, "INV-ISO-B-ON");
      expect((await claim(db, b.org)).send).toMatchObject({ doc_ref: "INV-ISO-B-ON" });
      expect((await auditOf(db, a.org)).map((r) => r.actor_user_id)).toEqual([a.admin.id, a.admin.id]);
      expect((await auditOf(db, b.org)).map((r) => r.actor_user_id)).toEqual([b.admin.id]);
    });
  });
});

describe("concurrency (committed, two connections)", () => {
  it("two admins of one company flipping at once: no deadlock, a single consistent final state, audit rows equal the changes actually made", async () => {
    const setup = await withDb((db) => committed(db, async () => {
      const co = await company(db, "race", { queued: 1 });
      const second = await makeActor(db, co.org, "admin");
      return { ...co, second };
    }));
    const worker = (who: Actor, pattern: boolean[]) => withDb(async (db) => {
      const errs: string[] = [];
      for (const on of pattern) {
        const r = await committed(db, () => turn(db, who, on));
        if (r.error) errs.push(`${r.error.code}:${r.error.hint ?? r.error.message}`);
      }
      return errs;
    });
    // The harness runs each statement in its own implicit transaction here (autocommit), so the two sessions truly interleave.
    const flip = [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, true];
    const [e1, e2] = await Promise.all([worker(setup.admin, flip), worker(setup.second, flip.toReversed())]);
    expect([...e1, ...e2]).toEqual([]);
    await withDb(async (db) => {
      const final = await hold(db, setup.org);
      const audit = await auditOf(db, setup.org);
      expect(typeof final).toBe("boolean");
      // The audit trail is a chain of real changes: each row's `was` is the previous row's `enabled`, and the last one is the final state.
      let prev = false;
      for (const row of audit) { expect(row.metadata.was).toBe(prev); expect(row.metadata.enabled).toBe(!prev); prev = row.metadata.enabled; }
      expect(prev).toBe(final);
      expect(audit.length).toBeGreaterThan(0);
    });
  });
  it("a reconnect racing a turn-ON: no deadlock; the final state is OFF whenever the reconnect came last, and the audit trail agrees with the row", async () => {
    const co = await withDb((db) => committed(db, () => company(db, "race2", { queued: 1 })));
    for (let i = 0; i < 8; i += 1) {
      const results = await Promise.allSettled([
        withDb((db) => committed(db, () => turn(db, co.admin, true))),
        withDb((db) => committed(db, async () => { await connect(db, co.org, co.admin, (await db.query("SELECT tenant_id FROM public.integration_connections WHERE organization_id=$1", [co.org])).rows[0].tenant_id); })),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      for (const r of results) if (r.status === "fulfilled" && r.value && "error" in (r.value as object) && (r.value as { error?: Err }).error) expect((r.value as { error: Err }).error.code).not.toBe("40P01");
    }
    await withDb(async (db) => {
      const final = await hold(db, co.org);
      const audit = await auditOf(db, co.org);
      const last = audit.at(-1);
      expect(final).toBe(last ? last.metadata.enabled : false);
      // a claim never sends while the row is OFF, whatever the race did
      if (!final) expect((await committed(db, () => claim(db, co.org))).blocked).toBe("launch_hold");
    });
  });
});

describe("rollback", () => {
  it("refuses while a connected company is still held; with old sending accepted it restores 084's functions exactly and the release applies again", async () => {
    await withDb(async (db) => {
      const [held, enabled] = await committed(db, async () => {
        const h = await company(db, "rb-held", { queued: 1 });
        const e = await company(db, "rb-on", { queued: 1 });
        ok(await turn(db, e.admin, true));
        return [h, e] as const;
      });
      const md5 = async () => Object.fromEntries((await db.query("SELECT proname, md5(regexp_replace(prosrc,'\\s','','g')) AS m FROM pg_proc WHERE proname IN ('integration_claim_next','integration_retry_send')")).rows.map((r) => [r.proname, r.m]));
      const during = await md5();
      let refused: string | null = null;
      try { await db.query(read("supabase/release/149_xero_launch_hold.rollback.sql")); } catch (e) { refused = (e as Error).message; }
      expect(refused).toMatch(/rollback refused: a connected Xero company is still held/);
      await db.query("ROLLBACK").catch(() => undefined);
      expect(await md5()).toEqual(during);
      expect(await hold(db, held.org)).toBe(false);
      expect(await hold(db, enabled.org)).toBe(true);
      await db.query("SET tolra.x149_accept_old_sending = 'yes'");
      await db.query(read("supabase/release/149_xero_launch_hold.rollback.sql"));
      expect(await md5()).toEqual({ integration_claim_next: "1e926cf7051cc6614f0cfc6b2124b470", integration_retry_send: "1e8e2136759e43952aa406f8a6bcac88" });
      expect((await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'integration_xero_%'")).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('xero_connection_reset','xero_send_queued')")).rows[0].n).toBe(0);
      expect((await db.query("SELECT to_regclass('public.xero_send_release') AS t")).rows[0].t).toBeNull();
      // Old behaviour in SQL: the company that was held is claimable again (this is why the rollback is gated).
      expect((await committed(db, () => claim(db, held.org))).send).not.toBeNull();
      // Rolling back twice is refused (nothing to roll back).
      await db.query("SET tolra.x149_accept_old_sending = 'yes'");
      await expect(db.query(read("supabase/release/149_xero_launch_hold.rollback.sql"))).rejects.toThrow(/nothing to roll back/);
      await db.query("ROLLBACK").catch(() => undefined);
      // Installing again works, and every company that exists is OFF again (a rolled-back switch is not remembered).
      await db.query(read("supabase/release/149_xero_launch_hold.release.sql"));
      expect(await hold(db, held.org)).toBe(false);
      expect(await hold(db, enabled.org)).toBe(false);
      const checks = (await db.query(read("supabase/verify/xero_launch_hold_149.sql"))).rows;
      expect(checks.filter((r) => r.ok !== true)).toEqual([]);
      // A second install is refused (one-time).
      await expect(db.query(read("supabase/release/149_xero_launch_hold.release.sql"))).rejects.toThrow(/not 084's|already exists/);
      await db.query("ROLLBACK").catch(() => undefined);
    });
  });
});
