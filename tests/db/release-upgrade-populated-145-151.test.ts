/**
 * Upgrade of a POPULATED pre-145 database through releases 145 to 151, in PostgreSQL itself (pure SQL through the database connection; no Supabase Auth API).
 *
 * The whole file runs inside ONE transaction on a single connection that is ALWAYS rolled back, so the shared test database is left as it was.
 *   1. The database is brought to the PRE-145 state: when 145..151 are already installed (CI's earlier proofs installed them) they are rolled back, 151 down to 145,
 *      with the rollbacks' own "accepted" switches; on a database that never had them (a copy of the pre-release schema) nothing is rolled back.
 *   2. It is POPULATED with synthetic data: Xero invitations in every pre-151 state (open, open with an OAuth state, used, expired, revoked; two companies), a
 *      connected Xero company, 143 costing rates, jobs / labour / machine runs, AI helper settings rows made by 122's default and by an admin. Every pre-existing
 *      public table is fingerprinted (row count + md5 of the rows, over the columns that existed before).
 *   3. 145, 146, 147, 148 (+ a "legacy half-even" job cost record, see below), 149, 150, 151 are applied in plan order, each from the candidate release file with the
 *      outer BEGIN/COMMIT removed; after EACH step the preflight marker reads applied, every verify row is true and the fingerprint of every pre-existing table is equal.
 *   4. 151's treatment of old invitations, 148's historical snapshots, 150's cap, the installed function bodies against the pins in release_preflight.sql and against the
 *      candidate files, and the data-refusing rollbacks (151..145) are asserted.
 * What this cannot prove: hosted Supabase Auth / MFA, real production data volumes or contents, concurrent traffic (the late-write and cancel-during-callback files do
 * that for 151). A job cost record cannot exist BEFORE 148 (148 creates the table), so "written before the edited 148" is modelled by replacing job_cost_round with the
 * exact pre-fix half-even body (tests/reviews/night-cost-profit/legacy-half-even-round.sql, e70f6633) while a record is taken, then installing the candidate body.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { verifyBackendIdentity } from "../support/fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const squash = (s: string) => md5(s.replace(/\s/g, ""));

type Phase = { number: number; release: string; rollback: string; verify: string; marker: string };
const plan = JSON.parse(read("supabase/release-plan.json")) as { phases: Phase[] };
const PHASES = plan.phases.filter(p => p.number >= 145 && p.number <= 151);
const phase = (n: number) => PHASES.find(p => p.number === n)!;
const SWITCHES = ["tolra.x145_accept_deleting_setup_ticks", "tolra.x147_accept_releasing_hold", "tolra.x148_accept_deleting_job_costs", "tolra.x149_accept_old_sending", "tolra.x151_accept_deleting_open_invites"];

/** Test-only exact pre-fix 148 function (half-even), from e70f6633b0f02f0e1dd38391ade87330d38a6a1c. Never a release input. */
const LEGACY_ROUND = `CREATE OR REPLACE FUNCTION public.job_cost_round(p_num numeric, p_den numeric) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE q numeric; r numeric;
BEGIN
  IF p_num < 0 OR p_den <= 0 OR p_num <> trunc(p_num) OR p_den <> trunc(p_den) THEN RAISE EXCEPTION 'Invalid cost ratio' USING ERRCODE = '22023'; END IF;
  q := div(p_num, p_den); r := p_num - q * p_den;
  IF 2 * r > p_den OR (2 * r = p_den AND mod(q, 2) = 1) THEN q := q + 1; END IF;
  RETURN q::bigint;
END $$;`;
/** md5 of the whitespace-stripped body of job_cost_round in supabase/release/148_job_profitability_actuals.release.sql (half-up: 2*r >= p_den). */
const HALF_UP_ROUND_MD5 = "ad159bf1a609e5608a47fe28e9db2f98";

const run = randomBytes(3).toString("hex");
let db: Client;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Actor = { id: string; session: string; org: string; email: string; role: string };
const q = async <T = Json>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
const cipher = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(16).toString("base64url")}.${randomBytes(48).toString("base64url")}`;
const hex64 = () => randomBytes(32).toString("hex");
const ref22 = () => randomBytes(16).toString("base64url");
const D = (t: string, day: number) => `2026-10-${String(day).padStart(2, "0")}T${t}:00Z`;

async function as<T = Json>(who: Actor, sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: { code?: string; message: string } }> {
  await db.query("SAVEPOINT as_call");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: who.id, session_id: who.session, role: "authenticated", aal: "aal2", email: who.email }), who.id]);
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT as_call");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT as_call");
    await db.query("RESET ROLE");
    return { error: { code: (e as { code?: string }).code, message: (e as Error).message } };
  }
}
async function svc<T = Json>(sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: { code?: string; message: string } }> {
  await db.query("SAVEPOINT svc_call");
  try {
    await db.query("SET LOCAL ROLE service_role");
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT svc_call");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT svc_call");
    await db.query("RESET ROLE");
    return { error: { code: (e as { code?: string }).code, message: (e as Error).message } };
  }
}
const ok = <T>(r: { rows?: T[]; error?: { message: string } }) => { expect(r.error).toBeUndefined(); return r.rows!; };
async function attempt(sql: string): Promise<string | null> {
  await db.query("SAVEPOINT attempt");
  try { await db.query(sql); await db.query("RELEASE SAVEPOINT attempt"); return null; } catch (e) { await db.query("ROLLBACK TO SAVEPOINT attempt"); return (e as Error).message; }
}
const setSwitches = (on: boolean) => db.query(`SELECT ${SWITCHES.map(s => `set_config('${s}', '${on ? "yes" : ""}', true)`).join(", ")}`);
const markerValue = async (name: string) => (await q<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).find(r => r.check === name)?.value;
async function verifyRows(file: string) {
  const rows = await q<{ ok?: boolean; passed?: boolean }>(read(file));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.filter(r => (r.ok ?? r.passed) !== true)).toEqual([]);
  return rows.length;
}

// ---------------------------------------------------------------- fingerprints of every pre-existing public table
const preCols: Record<string, string[]> = {};
type Print = Record<string, string>;
async function fingerprint(): Promise<Print> {
  const out: Print = {};
  for (const [t, cols] of Object.entries(preCols)) {
    const r = (await q<{ n: number; h: string }>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(r, '|' ORDER BY r), '')) AS h FROM
         (SELECT (SELECT jsonb_object_agg(k, v)::text FROM jsonb_each(to_jsonb(t)) e(k, v) WHERE k = ANY($1)) AS r FROM public.${t} t) s`, [cols]))[0];
    out[t] = `${r.n}:${r.h}`;
  }
  const a = (await q<{ n: number; h: string }>("SELECT count(*)::int AS n, md5(coalesce(string_agg(a::text, '|' ORDER BY a.id), '')) AS h FROM security_audit.audit_log a WHERE a.id = ANY($1)", [auditIds]))[0];
  out["security_audit.audit_log (rows that existed)"] = `${a.n}:${a.h}`;
  out["auth.users"] = String((await q<{ n: number }>("SELECT count(*)::int AS n FROM auth.users WHERE id = ANY($1)", [userIds]))[0].n);
  return out;
}
const differing = (a: Print, b: Print) => Object.keys(a).filter(k => a[k] !== b[k]);
let auditIds: string[] = [];
let userIds: string[] = [];
let pre: Print = {};

// ---------------------------------------------------------------- synthetic data
const S: Json = { sha: {} as Record<number, string> };
async function org(label: string) {
  const id = randomUUID();
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `Synthetic ${label}`, `t-i2-${label}-${run}-${id.slice(0, 6)}`]);
  return id;
}
async function actor(orgId: string, role: string): Promise<Actor> {
  const id = randomUUID(), session = randomUUID(), email = `${id}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)", [id, email, role, orgId]);
  await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,true)", [id, orgId, role]);
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, id, orgId]);
  return { id, session, org: orgId, email, role };
}
async function current143(orgId: string) {
  return (await q<{ j: Json }>(`SELECT jsonb_build_object(
    'materials', coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'price_pence',price_pence,'price_unit',price_unit,'scrap_pct',scrap_pct) ORDER BY id) FROM public.costing_materials WHERE organization_id=$1),'[]'::jsonb),
    'machines', coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'hourly_rate_pence',hourly_rate_pence,'labour_rate_pence',labour_rate_pence) ORDER BY id) FROM public.costing_machines WHERE organization_id=$1),'[]'::jsonb),
    'defaults', (SELECT jsonb_build_object('labour_rate_pence',labour_rate_pence,'programming_rate_pence',programming_rate_pence,'overhead_pct',overhead_pct,'default_margin_pct',default_margin_pct) FROM public.costing_defaults WHERE organization_id=$1)) AS j`, [orgId]))[0].j;
}
/** 143's rates, written only through 143's own save function as the company's admin. */
async function save143(admin: Actor, labour: number, overhead: number, haas: string, hourly: number, machineLabour: number | null) {
  const expected = await current143(admin.org);
  const materials = expected.materials.length ? expected.materials : [{ id: randomUUID(), name: "Aluminium 6082", price_pence: 450, price_unit: "kg", scrap_pct: 5 }];
  const value = { materials, machines: [{ id: haas, name: "Haas VF2", hourly_rate_pence: hourly, labour_rate_pence: machineLabour }],
    defaults: { labour_rate_pence: labour, programming_rate_pence: 3000, overhead_pct: overhead, default_margin_pct: 20 } };
  return as(admin, "SELECT public.save_costing_settings_atomic($1,$2,$3)", [admin.org, JSON.stringify(expected), JSON.stringify(value)]);
}
const machine = async (orgId: string, name: string) => (await q<{ id: string }>("INSERT INTO public.machines(organization_id,name) VALUES($1,$2) RETURNING id", [orgId, name]))[0].id;
const job = async (orgId: string, finished = false) => (await q<{ id: string }>(
  `INSERT INTO public.jobs(organization_id,job_no,customer,description,stage,started_at,finished_at) VALUES($1,$2,'Acme I2','Brackets',$3,now()-interval '9 days',${finished ? "now()-interval '5 days'" : "NULL"}) RETURNING id`,
  [orgId, `J-I2-${randomUUID().slice(0, 8)}`, finished ? "complete" : "machining"]))[0].id;
const labour = (orgId: string, user: string, jobId: string, from: string, to: string) =>
  db.query("INSERT INTO public.operator_sessions(organization_id,user_id,job_id,started_at,ended_at,source,end_source) VALUES($1,$2,$3,$4,$5,'manual','sheet')", [orgId, user, jobId, from, to]);
const machineRun = (orgId: string, jobId: string, machineId: string, operator: string | null, from: string, to: string) =>
  db.query("INSERT INTO public.machine_runs(organization_id,job_id,machine_id,operator_id,started_at,ended_at,end_reason) VALUES($1,$2,$3,$4,$5,$6,'finished')", [orgId, jobId, machineId, operator, from, to]);
const invite = async (orgId: string, by: string, o: { created: string; expires: string; used?: boolean; revoked?: boolean }) =>
  (await q<{ id: string }>(`INSERT INTO public.integration_connect_invites(organization_id,provider,token_hash,created_by,created_at,expires_at,used_at,revoked_at,revoked_by)
    VALUES($1,'xero',$2,$3,${o.created},${o.expires},${o.used ? "now()-interval '30 minutes'" : "NULL"},${o.revoked ? "now()-interval '2 hours'" : "NULL"},${o.revoked ? "$3" : "NULL"}) RETURNING id`, [orgId, hex64(), by]))[0].id;
const oauthState = async (orgId: string, user: string, via: string, o: { consumed: boolean }) => {
  const h = hex64();
  await db.query(`INSERT INTO public.integration_oauth_states(organization_id,provider,user_id,state_hash,verifier_enc,expires_at,via_invite,consumed_at)
    VALUES($1,'xero',$2,$3,$4,now()+interval '9 minutes',$5,${o.consumed ? "now()-interval '1 minute'" : "NULL"})`, [orgId, user, h, cipher(), via]);
  return h;
};

async function populate() {
  // ---- company A: 143 rates, jobs, Xero invitations in every pre-151 state (no connection)
  const A = await org("a"), a = { admin: await actor(A, "admin"), office: await actor(A, "office"), workshop: await actor(A, "workshop") };
  const aMill = await machine(A, "Mill A"), aHaas = randomUUID();
  ok(await save143(a.admin, 2000, 150, aHaas, 4500, 2600));
  const aFin = await job(A, true), aOpen = await job(A);
  for (const [j, day] of [[aFin, 1], [aOpen, 2]] as const) { await labour(A, a.workshop.id, j, D("08:00", day), D("09:30", day)); await machineRun(A, j, aMill, a.workshop.id, D("08:30", day), D("09:00", day)); }
  const open1 = await invite(A, a.admin.id, { created: "now()-interval '1 hour'", expires: "now()+interval '23 hours'" });
  const open2 = await invite(A, a.admin.id, { created: "now()-interval '2 hours'", expires: "now()+interval '22 hours'" });
  const usedA = await invite(A, a.admin.id, { created: "now()-interval '3 hours'", expires: "now()+interval '21 hours'", used: true });
  const expiredA = await invite(A, a.admin.id, { created: "now()-interval '3 days'", expires: "now()-interval '2 days'" });
  const revokedA = await invite(A, a.admin.id, { created: "now()-interval '4 hours'", expires: "now()+interval '20 hours'", revoked: true });
  const stateOpen2 = await oauthState(A, a.admin.id, open2, { consumed: false });
  const stateUsedA = await oauthState(A, a.admin.id, usedA, { consumed: true });
  // ---- company B: 143 rates at 1001p/h (exact half-penny ties), a connected Xero company, only a used (live state) and a revoked invitation
  const B = await org("b"), b = { admin: await actor(B, "admin"), office: await actor(B, "office"), workshop: await actor(B, "workshop") };
  const bMill = await machine(B, "Mill B"), bHaas = randomUUID();
  ok(await save143(b.admin, 1001, 100, bHaas, 1001, null));
  const bLegacy = await job(B), bNew = await job(B);
  for (const [j, day] of [[bLegacy, 5], [bNew, 6]] as const) { await labour(B, b.workshop.id, j, D("10:00", day), D("10:30", day)); await machineRun(B, j, bMill, null, D("11:00", day), D("11:20", day)); }
  const usedB = await invite(B, b.admin.id, { created: "now()-interval '3 hours'", expires: "now()+interval '21 hours'", used: true });
  const revokedB = await invite(B, b.admin.id, { created: "now()-interval '4 hours'", expires: "now()+interval '20 hours'", revoked: true });
  const stateUsedB = await oauthState(B, b.admin.id, usedB, { consumed: false });
  await db.query("INSERT INTO public.integration_connections(organization_id,provider,status,tenant_id,tenant_name,connected_by,connected_at) VALUES($1,'xero','connected',$2,'Synthetic B Ltd',$3,now())", [B, `tenant-b-${run}`, b.admin.id]);
  // ---- AI helper settings rows made BEFORE 150: 122's default (500) with and without a key, and two admin-chosen caps
  const mkAi = async (label: string, cap: number | null, key: boolean) => {
    const id = await org(label), admin = await actor(id, "admin");
    await db.query(`INSERT INTO public.ai_helper_settings(organization_id,roundup_enabled,rfq_enabled${cap === null ? "" : ",monthly_cap_pence"},api_key_last4) VALUES($1,true,false${cap === null ? "" : `,${cap}`},${key ? "'abcd'" : "NULL"})`, [id]);
    if (key) await db.query("INSERT INTO public.ai_helper_secrets(organization_id,api_key_enc) VALUES($1,$2)", [id, cipher()]);
    return { id, admin };
  };
  const ai = { key: await mkAi("ai-key", null, true), noKey: await mkAi("ai-nokey", null, false), c300: await mkAi("ai-300", 300, false), c2500: await mkAi("ai-2500", 2500, true), tolraOwn: await mkAi("ai-tolra-own", null, true) };
  Object.assign(S, { A, B, a, b, aFin, aOpen, bLegacy, bNew, bMill, bHaas, aMill, aHaas, open1, open2, usedA, expiredA, revokedA, usedB, revokedB, stateOpen2, stateUsedA, stateUsedB, ai });
}

// ---------------------------------------------------------------- function bodies: installed vs the candidate files vs the pins
function funcBody(sql: string, schema: string, name: string, args: number): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${name}\\s*\\(`, "gi");
  let found: string | null = null;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    let depth = 1, i = m.index + m[0].length, commas = 0, any = false;
    for (; depth > 0; i++) { const c = sql[i]; if (c === "(") depth++; else if (c === ")") depth--; else if (c === "," && depth === 1) commas++; else if (depth >= 1 && !/\s/.test(c)) any = true; }
    if ((any ? commas + 1 : 0) !== args) continue;
    const rest = sql.slice(i), tag = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(rest);
    if (!tag) continue;
    const start = tag.index + tag[0].length, end = rest.indexOf(tag[1], start);
    found = rest.slice(start, end);
  }
  if (found === null) throw new Error(`no definition of ${schema}.${name}/${args} in the release file`);
  return found;
}
const PINNED_151: Array<[string, string, number]> = [
  ["public.integration_invite_create(text,text,text)", "integration_invite_create", 3], ["public.integration_invite_peek(text)", "integration_invite_peek", 1],
  ["public.integration_invite_code_issue(text,text)", "integration_invite_code_issue", 2], ["public.integration_invite_code_verify(text,text,text,text)", "integration_invite_code_verify", 4],
  ["public.integration_invites_open(text)", "integration_invites_open", 1], ["public.integration_invite_revoke(uuid)", "integration_invite_revoke", 1],
  ["public.integration_oauth_consume_invite(text,text)", "integration_oauth_consume_invite", 2], ["public.integration_invite_refusal_log(text,text,text,uuid)", "integration_invite_refusal_log", 4],
  ["security_audit.integration_invite_refuse(text,text,text,uuid,uuid)", "integration_invite_refuse", 5],
  ["public.integration_invite_store_connection(text,uuid,uuid,text,text,text,text,text,text,timestamptz,integer)", "integration_invite_store_connection", 11],
  ["public.integration_xero_picker_claim(text,text,integer,integer)", "integration_xero_picker_claim", 4],
];
function pinsFromPreflight(): string[] {
  const text = read("supabase/verify/release_preflight.sql");
  const from = text.indexOf("('post-144 marker 151 xero_invite_hardening'");
  const block = text.slice(from, text.indexOf("checks(n, check_name", from));
  const list = /md5\(regexp_replace\(p\.prosrc[^)]*\)\)\s+IN\s*\(([^)]*)\)/.exec(block);
  if (!list) throw new Error("marker 151 pin list not found in release_preflight.sql");
  return [...list[1].matchAll(/'([0-9a-f]{32})'/g)].map(m => m[1]);
}
async function checkPins151() {
  const pins = pinsFromPreflight();
  expect(pins).toHaveLength(11);
  expect(new Set(pins).size).toBe(11);
  const release = read(phase(151).release);
  const installed: string[] = [];
  for (const [sig, name, args] of PINNED_151) {
    const schema = sig.split(".")[0];
    const row = (await q<{ h: string }>("SELECT md5(regexp_replace(p.prosrc, '\\s', '', 'g')) AS h FROM pg_proc p WHERE p.oid = to_regprocedure($1)", [sig]))[0];
    expect(row, sig).toBeDefined();
    installed.push(row.h);
    expect(pins, `${sig} installed body ${row.h} is not a pin of release_preflight.sql marker 151`).toContain(row.h);
    expect(row.h, `${sig}: installed body is not the body in the candidate release file`).toBe(squash(funcBody(release, schema, name, args)));
  }
  expect(new Set(installed)).toEqual(new Set(pins));
}

// ---------------------------------------------------------------- the file under test
beforeAll(async () => {
  await verifyBackendIdentity();
  db = new Client({ connectionString: isolatedBackend().databaseUrl });
  await db.connect();
  await db.query("BEGIN");
  // 1. pre-145 state
  if ((await markerValue(phase(145).marker)) === "applied") {
    await setSwitches(true);
    for (const n of [151, 150, 149, 148, 147, 146, 145]) await db.query(unwrapped(read(phase(n).rollback)));
    // 146's rollback deliberately KEEPS ai_helper_requests.key_source (history is retained), which makes 146's one-time file refuse ("already exists"); a database
    // that never had 146 does not have the column, so it is dropped here (inside this always-rolled-back transaction) to reproduce the pre-146 shape.
    await db.query("ALTER TABLE public.ai_helper_requests DROP COLUMN IF EXISTS key_source");
  }
  await setSwitches(false);
  for (const p of PHASES) expect(await markerValue(p.marker), p.marker).toBe("not applied");
  // 2. populate and fingerprint
  await populate();
  for (const t of (await q<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")))
    preCols[t.table_name] = (await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [t.table_name])).map(c => c.column_name);
  // the invitation table is compared on every column except revoked_at, which 151 is promised to set on open token links (asserted separately)
  preCols["integration_connect_invites"] = preCols["integration_connect_invites"].filter(c => c !== "revoked_at");
  // Release 150 intentionally raises ai_helper_settings rows at 500p to 1000p, so that column is asserted separately (AI-cap block).
  preCols["ai_helper_settings"] = preCols["ai_helper_settings"].filter(c => c !== "monthly_cap_pence");
  auditIds = (await q<{ id: string }>("SELECT id FROM security_audit.audit_log")).map(r => r.id);
  userIds = (await q<{ id: string }>("SELECT id FROM auth.users")).map(r => r.id);
  pre = await fingerprint();
  S.preInvites = await q("SELECT id, organization_id, used_at, revoked_at, revoked_by, expires_at FROM public.integration_connect_invites ORDER BY id");
  S.preConnections = await q("SELECT * FROM public.integration_connections ORDER BY id");
});
afterAll(async () => {
  if (db) { await db.query("ROLLBACK").catch(() => undefined); await db.end().catch(() => undefined); }
});

describe("the populated pre-145 database", () => {
  it("is at the pre-145 state with synthetic data in place: no 145..151 object, old token links, 143 rates, jobs, 122-default AI rows", async () => {
    expect(await q("SELECT to_regclass('public.company_setup_progress') AS t").then(r => r[0].t)).toBeNull();
    expect(await q("SELECT to_regprocedure('public.integration_invite_create(text,text)') AS f").then(r => r[0].f)).not.toBeNull();
    expect((await q("SELECT count(*)::int AS n FROM public.integration_connect_invites WHERE organization_id=$1", [S.A]))[0].n).toBe(5);
    expect((await q("SELECT count(*)::int AS n FROM public.integration_connect_invites WHERE organization_id=$1", [S.B]))[0].n).toBe(2);
    expect((await q("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='integration_connect_invites' AND column_name='ref'"))[0].n).toBe(0);
    expect((await q("SELECT monthly_cap_pence FROM public.ai_helper_settings WHERE organization_id=$1", [S.ai.key.id]))[0].monthly_cap_pence).toBe(500);
    expect((await q("SELECT monthly_cap_pence FROM public.ai_helper_settings WHERE organization_id=$1", [S.ai.noKey.id]))[0].monthly_cap_pence).toBe(500);
    expect((await q("SELECT md5(regexp_replace(prosrc,'\\s','','g')) AS h FROM pg_proc WHERE oid=to_regprocedure('public.save_costing_settings_atomic(uuid,jsonb,jsonb)')"))[0].h).toBe("2c779bca11212d8bf660c4526719c919");
    expect(Object.keys(pre).length).toBeGreaterThan(50);
  });
});

describe("install 145..151 in plan order on the populated database", () => {
  const step = (n: number) => it(`${n}: marker not applied -> candidate file applied -> marker applied, every verify row true, every pre-existing table unchanged`, async () => {
    const p = phase(n), file = read(p.release);
    expect(await markerValue(p.marker)).toBe("not applied");
    S.sha[n] = sha256(file);
    console.log(`release ${n} candidate file ${p.release} sha256 ${S.sha[n]}`);
    await db.query(unwrapped(file));
    expect(await markerValue(p.marker)).toBe("applied");
    const rows = await verifyRows(p.verify);
    if (n === 148) expect(rows).toBe(13);
    expect(differing(pre, await fingerprint()), `pre-existing tables changed by ${n}`).toEqual([]);
    if (n >= 148) expect((await q("SELECT count(*)::int AS n FROM public.job_cost_snapshots"))[0].n).toBe(n === 148 ? 0 : 2);
  });
  for (const n of [145, 146, 147, 148]) step(n);

  it("148: a record taken under the legacy half-even rule is NOT rewritten when the candidate half-up body is installed; a new record on the same exact tie is half-up; 143 is untouched", async () => {
    const { B, b, bMill, bHaas, bLegacy, bNew } = S;
    ok(await as(b.admin, "SELECT public.save_job_costing_machine_links($1,$2)", [B, JSON.stringify([{ machine_id: bMill, costing_machine_id: bHaas }])]));
    ok(await as(b.admin, "SELECT public.set_job_costing_enabled($1,0,true)", [B]));
    for (const j of [bLegacy, bNew]) ok(await as(b.office, "SELECT public.save_job_cost_declarations($1,false,false)", [j]));
    const rates143 = await current143(B);
    // legacy body (what an earlier 148 left): exact ties go to the even penny
    await db.query(LEGACY_ROUND);
    expect(squash((await q<{ s: string }>("SELECT prosrc AS s FROM pg_proc WHERE oid=to_regprocedure('public.job_cost_round(numeric,numeric)')"))[0].s)).not.toBe(HALF_UP_ROUND_MD5);
    expect((await q("SELECT public.job_cost_round(1,2) AS a, public.job_cost_round(3,2) AS b, public.job_cost_round(5,2) AS c"))[0]).toMatchObject({ a: "0", b: "2", c: "2" });
    await db.query("UPDATE public.jobs SET finished_at=now(), stage='complete' WHERE id=$1", [bLegacy]);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    const legacy = (await q("SELECT * FROM public.job_cost_snapshots WHERE job_id=$1", [bLegacy]))[0];
    expect(legacy).toMatchObject({ taken_on: "finished", state: "complete", labour_pence: "500", machine_pence: "334", overhead_pence: "0", supplier_pence: "0" }); // 30 min at 1001p/h = 500.5 -> 500
    expect(legacy.rates).toMatchObject({ defaults: { labour_rate_pence: 1001 } });
    expect(legacy.rates).toMatchObject({ machines: rates143.machines, defaults: { overhead_pct: 100 } });
    const legacyHash = md5(JSON.stringify(legacy));
    // the candidate body, taken from the candidate 148 release file
    const file = read(phase(148).release);
    const stmt = /CREATE FUNCTION public\.job_cost_round[\s\S]*?END \$\$;/.exec(file)![0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
    await db.query(stmt);
    expect(squash(funcBody(file, "public", "job_cost_round", 2))).toBe(HALF_UP_ROUND_MD5);
    expect((await q("SELECT md5(regexp_replace(prosrc,'\\s','','g')) AS h FROM pg_proc WHERE oid=to_regprocedure('public.job_cost_round(numeric,numeric)')"))[0].h).toBe(HALF_UP_ROUND_MD5);
    expect((await q("SELECT public.job_cost_round(1,2) AS a, public.job_cost_round(3,2) AS b, public.job_cost_round(5,2) AS c"))[0]).toMatchObject({ a: "1", b: "2", c: "3" });
    expect((await q("SELECT public.job_cost_round(1,3) AS a, public.job_cost_round(2,3) AS b"))[0]).toMatchObject({ a: "0", b: "1" });
    expect(md5(JSON.stringify((await q("SELECT * FROM public.job_cost_snapshots WHERE job_id=$1", [bLegacy]))[0]))).toBe(legacyHash);
    expect(await verifyRows(phase(148).verify)).toBe(13);
    // a record taken now, same inputs, same exact tie: half-up
    await db.query("UPDATE public.jobs SET finished_at=now(), stage='complete' WHERE id=$1", [bNew]);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    const fresh = (await q("SELECT * FROM public.job_cost_snapshots WHERE job_id=$1", [bNew]))[0];
    expect(fresh).toMatchObject({ taken_on: "finished", state: "complete", labour_pence: "501", machine_pence: "334", overhead_pence: "0" });
    // 143: rates and the one save function are as they were; an edit through 143 afterwards moves neither record
    expect(await current143(B)).toEqual(rates143);
    expect((await q("SELECT md5(regexp_replace(prosrc,'\\s','','g')) AS h FROM pg_proc WHERE oid=to_regprocedure('public.save_costing_settings_atomic(uuid,jsonb,jsonb)')"))[0].h).toBe("2c779bca11212d8bf660c4526719c919");
    await verifyRows("supabase/verify/costing_rates_143.sql");
    // The two jobs this test finished are the only change to pre-existing data (jobs, and the flow events their close writes); everything else is still equal.
    const now = await fingerprint();
    expect(differing(pre, now)).toEqual(["job_flow_events", "jobs"]);
    pre["jobs"] = now["jobs"]; pre["job_flow_events"] = now["job_flow_events"];
    ok(await save143(b.admin, 9000, 300, bHaas, 9999, 9999));
    // this test's own edit through 143's save is the only change to the costing tables from here on
    const edited = await fingerprint();
    const moved = differing(pre, edited);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every(k => k.startsWith("costing_"))).toBe(true);
    for (const k of moved) pre[k] = edited[k];
    S.legacyHash = legacyHash;
    S.freshHash = md5(JSON.stringify((await q("SELECT * FROM public.job_cost_snapshots WHERE job_id=$1", [bNew]))[0]));
    expect(S.freshHash).toBe(md5(JSON.stringify(fresh)));
    expect(md5(JSON.stringify((await q("SELECT * FROM public.job_cost_snapshots WHERE job_id=$1", [bLegacy]))[0]))).toBe(legacyHash);
    // pre-existing jobs finished before 148 got no record (records are taken only at a close after 148)
    expect((await q("SELECT count(*)::int AS n FROM public.job_cost_snapshots WHERE job_id=$1", [S.aFin]))[0].n).toBe(0);
  });
  for (const n of [149, 150, 151]) step(n);
});

describe("151 on the old (107) token invitations", () => {
  const inv = async (id: string) => (await q("SELECT * FROM public.integration_connect_invites WHERE id=$1", [id]))[0];
  it("cancels every open token link (open, open with a state, and the never-used expired one), audited once per company; used and already-revoked links are untouched", async () => {
    for (const id of [S.open1, S.open2, S.expiredA]) expect(await inv(id)).toMatchObject({ used_at: null, revoke_reason: "superseded_151", revoked_by: null, ref: null });
    for (const id of [S.open1, S.open2, S.expiredA]) expect((await inv(id)).revoked_at).not.toBeNull();
    for (const id of [S.usedA, S.usedB]) expect(await inv(id)).toMatchObject({ revoked_at: null, revoke_reason: null });
    expect((await inv(S.usedA)).used_at).not.toBeNull();
    for (const id of [S.revokedA, S.revokedB]) expect(await inv(id)).toMatchObject({ revoke_reason: null, used_at: null });
    // nothing but revoked_at / the 151 columns changed on any pre-existing invitation (the fingerprint covers every other column of every row)
    const post = await q("SELECT id, organization_id, used_at, revoked_by, expires_at FROM public.integration_connect_invites WHERE id = ANY($1) ORDER BY id", [S.preInvites.map((r: Json) => r.id)]);
    expect(post).toEqual(S.preInvites.map((r: Json) => ({ id: r.id, organization_id: r.organization_id, used_at: r.used_at, revoked_by: r.revoked_by, expires_at: r.expires_at })));
    // the previously revoked links kept their own revoked_at
    for (const r of S.preInvites.filter((x: Json) => x.revoked_at)) expect((await inv(r.id)).revoked_at).toEqual(r.revoked_at);
    const audit = await q("SELECT metadata FROM security_audit.audit_log WHERE action='INTEGRATION_INVITE_REVOKED' AND organization_id=ANY($1)", [[S.A, S.B]]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ reason: "superseded_151", count: 3 });
    expect((await q("SELECT count(*)::int AS n FROM security_audit.audit_log WHERE action='INTEGRATION_INVITE_REVOKED' AND organization_id=$1", [S.B]))[0].n).toBe(0);
    // no open token link remains anywhere
    expect((await q("SELECT count(*)::int AS n FROM public.integration_connect_invites WHERE ref IS NULL AND used_at IS NULL AND revoked_at IS NULL"))[0].n).toBe(0);
    // the 107 functions are gone, the 151 ones are there
    for (const f of ["integration_invite_create(text,text)", "integration_invite_redeem(text,text,text)"]) expect((await q("SELECT to_regprocedure($1) AS f", [`public.${f}`]))[0].f).toBeNull();
    expect((await q("SELECT to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') AS f"))[0].f).not.toBeNull();
  });
  it("creates no connection, changes no company's connection, leaves company B's invitations, states and Xero connection byte-identical", async () => {
    expect(await q("SELECT * FROM public.integration_connections ORDER BY id")).toEqual(S.preConnections);
    expect((await q("SELECT count(*)::int AS n FROM public.integration_connections WHERE organization_id=$1", [S.A]))[0].n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM public.integration_connections WHERE organization_id=$1 AND status='connected'", [S.B]))[0].n).toBe(1);
    expect(differing(pre, await fingerprint())).toEqual([]);
  });
  it("a revoked link's pending OAuth state cannot become a connection: the callback is refused as revoked (security log), the final store refuses, nothing is stored", async () => {
    const consumed = ok(await svc<{ c: Json }>("SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [S.stateOpen2]))[0].c;
    expect(consumed).toMatchObject({ ok: false, reason: "revoked" });
    const stored = ok(await svc<{ r: Json }>("SELECT public.integration_invite_store_connection($1,$2,$3,'xero',$4,'Synthetic A Ltd',$5,$6,$7,$8,1) AS r",
      [S.stateOpen2, S.A, S.a.admin.id, `tenant-a-${run}`, randomUUID(), cipher(), cipher(), new Date(Date.now() + 1800_000).toISOString()]))[0].r;
    expect(stored.ok).toBe(false);
    expect((await q("SELECT count(*)::int AS n FROM public.integration_connections WHERE organization_id=$1", [S.A]))[0].n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM public.integration_secrets WHERE organization_id=$1", [S.A]))[0].n).toBe(0);
    expect((await q("SELECT reason FROM security_audit.integration_invite_refusals WHERE organization_id=$1 ORDER BY id", [S.A])).map(r => r.reason)).toEqual(["revoked", "revoked"]);
  });
});

describe("function bodies and hashes against the candidate files", () => {
  it("151: the 11 pinned functions: installed md5 equals the pin in release_preflight.sql AND the body of the candidate release file; release file sha256 recorded", async () => {
    await checkPins151();
    console.log(`release 151 file sha256 ${S.sha[151]} (all 11 installed bodies equal both the pins and the file)`);
    expect(S.sha[151]).toMatch(/^[0-9a-f]{64}$/);
  });
  it("148: job_cost_round is the half-up body of the candidate file (md5 constant, file text, installed body) and behaves half-up on exact ties", async () => {
    const file = read(phase(148).release);
    expect(squash(funcBody(file, "public", "job_cost_round", 2))).toBe(HALF_UP_ROUND_MD5);
    expect((await q("SELECT md5(regexp_replace(prosrc,'\\s','','g')) AS h FROM pg_proc WHERE oid=to_regprocedure('public.job_cost_round(numeric,numeric)')"))[0].h).toBe(HALF_UP_ROUND_MD5);
    expect((await q("SELECT public.job_cost_round(1,2) AS a, public.job_cost_round(3,2) AS b, public.job_cost_round(5,2) AS c, public.job_cost_round(1001,2) AS d"))[0]).toMatchObject({ a: "1", b: "2", c: "3", d: "501" });
  });
  it("the historical snapshots (legacy half-even 500p, new half-up 501p) are byte-identical after 149, 150 and 151", async () => {
    expect(md5(JSON.stringify((await q("SELECT * FROM public.job_cost_snapshots WHERE job_id=$1", [S.bLegacy]))[0]))).toBe(S.legacyHash);
    expect(md5(JSON.stringify((await q("SELECT * FROM public.job_cost_snapshots WHERE job_id=$1", [S.bNew]))[0]))).toBe(S.freshHash);
    expect((await q("SELECT job_id, labour_pence FROM public.job_cost_snapshots ORDER BY labour_pence"))).toEqual([{ job_id: S.bLegacy, labour_pence: "500" }, { job_id: S.bNew, labour_pence: "501" }]);
  });
});

describe("AI monthly cap after 145..151: 1000p per company per month in both key modes (PM requirement; written against the requirement, not the file)", () => {
  const status = async (who: Actor) => ok(await as<{ j: Json }>(who, "SELECT public.ai_helper_status() AS j"))[0].j;
  it("(a) a NEW company with no settings row reads 1000", async () => {
    const id = await org("ai-new"), admin = await actor(id, "admin");
    expect(await status(admin)).toMatchObject({ monthly_cap_pence: 1000, tolra_cap_pence: 1000 });
  });
  it("(b1) a company whose settings row was made BEFORE 150 by 122's default (500), WITH an own key, reads 1000", async () => {
    expect((await status(S.ai.key.admin)).monthly_cap_pence).toBe(1000);
  });
  it("(b2) a company whose settings row was made BEFORE 150 by 122's default (500), WITHOUT a key, reads 1000", async () => {
    expect((await status(S.ai.noKey.admin)).monthly_cap_pence).toBe(1000);
  });
  it("(c) an admin-chosen cap stands (release 150 promises every settings row stays exactly as it was): 300 reads 300, 2500 reads 2500", async () => {
    expect((await status(S.ai.c300.admin)).monthly_cap_pence).toBe(300);
    expect((await status(S.ai.c2500.admin)).monthly_cap_pence).toBe(2500);
  });
  it("(d) Tolra-provided mode: a company with a Tolra row and NO own-key row reads 1000 in both; one with a Tolra row AND a pre-150 own-key row (122 default) has an effective cap of 1000", async () => {
    const id = await org("ai-tolra-only"), admin = await actor(id, "admin");
    await db.query("INSERT INTO public.ai_helper_tolra_companies(organization_id,enabled) VALUES($1,true),($2,true)", [id, S.ai.tolraOwn.id]);
    const only = await status(admin);
    expect(only).toMatchObject({ monthly_cap_pence: 1000, tolra_cap_pence: 1000, tolra_enabled: true });
    const both = await status(S.ai.tolraOwn.admin);
    expect(both).toMatchObject({ tolra_cap_pence: 1000, tolra_enabled: true, key_set: true });
    // 150 enforces least(own-key cap, Tolra cap) for a company in Tolra mode
    expect(Math.min(both.monthly_cap_pence, both.tolra_cap_pence)).toBe(1000);
  });
  it("(e) the column default is 1000 for rows made from now on", async () => {
    expect((await q("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_helper_settings' AND column_name='monthly_cap_pence'"))[0].column_default).toBe("1000");
    const id = await org("ai-default");
    await db.query("INSERT INTO public.ai_helper_settings(organization_id) VALUES($1)", [id]);
    expect((await q("SELECT monthly_cap_pence FROM public.ai_helper_settings WHERE organization_id=$1", [id]))[0].monthly_cap_pence).toBe(1000);
    expect((await q("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_helper_tolra_companies' AND column_name='monthly_cap_pence'"))[0].column_default).toBe("1000");
  });
});

describe("rollback 151..145 on the populated database", () => {
  const guardFirst = (n: number, message: string) => {
    const text = read(phase(n).rollback), at = text.indexOf(message), firstWrite = text.search(/^\s*(DROP|DELETE|ALTER|UPDATE|CREATE)\b/m);
    expect(at).toBeGreaterThan(0);
    expect(firstWrite === -1 || at < firstWrite, `${n}: the refusal is not ahead of the first change in the rollback file`).toBe(true);
  };
  async function refuses(n: number, message: RegExp, literal: string) {
    await setSwitches(false);
    const before = { marker: await markerValue(phase(n).marker), print: await fingerprint() };
    expect(before.marker).toBe("applied");
    expect(await attempt(unwrapped(read(phase(n).rollback)))).toMatch(message);
    expect(await markerValue(phase(n).marker)).toBe("applied");
    expect(differing(before.print, await fingerprint())).toEqual([]);
    guardFirst(n, literal);
  }
  it("151 refuses while a 151 invitation is open (prefix '151 rollback: open connect invites exist')", async () => {
    S.open151 = (await q<{ id: string }>(`INSERT INTO public.integration_connect_invites(organization_id,provider,ref,recipient_email,created_by,created_at,expires_at)
      VALUES($1,'xero',$2,'accountant@firm.example',$3,now(),now()+interval '1 hour') RETURNING id`, [S.A, ref22(), S.a.admin.id]))[0].id;
    await refuses(151, /^151 rollback: open connect invites exist/, "151 rollback: open connect invites exist");
  });
  it("149 refuses while a connected Xero company is held (prefix '149 rollback refused: a connected Xero company is still held')", async () => {
    expect((await q("SELECT enabled FROM public.xero_transfer_hold WHERE organization_id=$1", [S.B]))[0].enabled).toBe(false); // installed off for the pre-existing connected company
    await refuses(149, /^149 rollback refused: a connected Xero company is still held/, "149 rollback refused: a connected Xero company is still held");
  });
  it("148 refuses while job cost records exist (prefix '148 rollback refused: job costing data exists')", async () => {
    await refuses(148, /^148 rollback refused: job costing data exists/, "148 rollback refused: job costing data exists");
  });
  it("147 refuses while a company is held (prefix '147 rollback refused: a company is still held')", async () => {
    expect((await q("SELECT count(*)::int AS n FROM public.dln_numbering_pending"))[0].n).toBeGreaterThan(0); // 147 held the pre-existing companies
    await refuses(147, /^147 rollback refused: a company is still held/, "147 rollback refused: a company is still held");
  });
  it("145 refuses while setup ticks exist (prefix '145 rollback refused: setup ticks exist')", async () => {
    await db.query("INSERT INTO public.company_setup_progress(organization_id, step, completed) VALUES ($1,'company',true)", [S.A]);
    await refuses(145, /^145 rollback refused: setup ticks exist/, "145 rollback refused: setup ticks exist");
  });
  it("an eligible rollback works and the release applies again: 151 (open invitation closed first) then 150; both re-applied from the candidate files; pins, verify rows and every pre-existing table as before", async () => {
    await setSwitches(false);
    const before = await fingerprint();
    await db.query("UPDATE public.integration_connect_invites SET revoked_at=now(), revoke_reason='cancelled' WHERE ref IS NOT NULL");
    await db.query(unwrapped(read(phase(151).rollback)));
    expect(await markerValue(phase(151).marker)).toBe("not applied");
    expect((await q("SELECT to_regprocedure('public.integration_invite_create(text,text)') AS f"))[0].f).not.toBeNull();
    expect((await q("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='integration_connect_invites' AND column_name='ref'"))[0].n).toBe(0);
    // the cancelled token links stay cancelled after the rollback (no resurrection)
    for (const id of [S.open1, S.open2, S.expiredA]) expect((await q("SELECT revoked_at FROM public.integration_connect_invites WHERE id=$1", [id]))[0].revoked_at).not.toBeNull();
    await db.query(unwrapped(read(phase(150).rollback)));
    expect(await markerValue(phase(150).marker)).toBe("not applied");
    for (const n of [150, 151]) {
      await db.query(unwrapped(read(phase(n).release)));
      expect(await markerValue(phase(n).marker)).toBe("applied");
      await verifyRows(phase(n).verify);
    }
    await checkPins151();
    // The only table whose rows changed across rollback + re-apply is the invitation table: 151's own rows (no token) are deleted by 151's rollback, by design.
    // Every row that existed before (token links) is as it was, and nothing in any other table moved.
    expect(differing(before, await fingerprint())).toEqual(["integration_connect_invites"]);
    expect((await q("SELECT count(*)::int AS n FROM public.integration_connect_invites WHERE token_hash IS NULL"))[0].n).toBe(0);
    expect((await q("SELECT id, organization_id, used_at, revoked_by, expires_at FROM public.integration_connect_invites WHERE id = ANY($1) ORDER BY id", [S.preInvites.map((r: Json) => r.id)])))
      .toEqual(S.preInvites.map((r: Json) => ({ id: r.id, organization_id: r.organization_id, used_at: r.used_at, revoked_by: r.revoked_by, expires_at: r.expires_at })));
  });
});
