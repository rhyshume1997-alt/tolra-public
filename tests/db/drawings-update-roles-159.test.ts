/**
 * Release 159 (supabase/release/159_drawings_update_roles.release.sql, phase 159 after 156): nobody can replace or delete an object in the
 * job-drawings bucket from the browser (audit finding ST1, P0; the delete policy is refused too, because a delete followed by a new upload at
 * the same path is an overwrite). The DB proof, below the Storage API.
 *
 * Access path: DIRECT SQL on storage.objects as the role `authenticated` with the request JWT claims PostgREST and Storage set
 * (sub, role, session_id, aal), exactly how the policies are evaluated for a browser user. The Storage API itself is not used (it needs the
 * whole stack): an "upsert" is the INSERT ... ON CONFLICT (bucket_id, name) DO UPDATE the Storage API issues. The service role is `set local role
 * service_role` (bypasses row-level security, as it does through the Storage API). Not proved here: the Storage API's own error mapping and
 * its use of the user's role (tests/db/storage.test.ts, a baseline file that runs before the release, still proves the API on the stack).
 *
 * Inputs: the disposable database (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..159. Every observation
 * runs inside a transaction that is ALWAYS rolled back: the release is rolled back inside it to read the "before" (release 131's state),
 * each role's attempts run under a savepoint that is undone, and the release is applied again for the "after". No storage object, policy or
 * change is left behind. The synthetic companies (slug t-<run>-...) and their people are removed by destroySyntheticWorld.
 * Proves: after 159 no browser role (workshop, office, admin, viewer) can update, rename or upsert over an unregistered object in the
 * drawing, certs/ and inspection/ paths (and the object is unchanged), and cannot delete one and upload it again at the same path (also unchanged),
 * while before 159 workshop, office and admin could (the defect); registered files, new uploads, select, revision registration, the service role
 * (which can still update, rename and delete: the clean-up route), the other company and the other buckets are exactly as before; the policy count and every other policy are unchanged; 131's verify accepts exactly two texts for this one policy and nothing
 * else; release / repeat / rollback / re-release behave as 156's do. STATE is the two policies' exact text only (there is no comment: COMMENT ON POLICY
 * needs ownership of storage.objects): absent = both at 131's md5, installed = both at 159's md5, drifted = anything else (a third text on either, a
 * missing policy, another kind, command or role list, or ONE policy at each text: a half install); the drifted shapes are proved against the release guard, the rollback guard, release preflight (marker and row 62)
 * and 131's verify.
 * Must not change: this file proves; it never edits a release, verify or rollback file to make itself pass.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { EMAIL_DOMAIN, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const slug = (label: string) => `t-${runId}-p159-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/159_drawings_update_roles.release.sql";
const ROLLBACK = "supabase/release/159_drawings_update_roles.rollback.sql";
const VERIFY = "supabase/verify/drawings_update_roles_159.sql";
const VERIFY_131 = "supabase/verify/rls_select_wrap_131.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MARKER = "post-144 marker 159 drawings_update_roles";
const POLICY = "job drawings org update";
const POLICY_DEL = "job drawings org delete";
const M131 = "76e489d7de7f079451629dc75177d894";
const M159 = "18b6c82111707e214f8aaa30c5b6e717";
/** The delete policy's md5 of coalesce(qual, '') || '|' || coalesce(with_check, ''): 131's text (pg_policies as 131 left it) and 159's USING (false) = md5('false|'). */
const M131_DEL = "2b7ec566b4506d9dc5918f7b02dd8374";
const M159_DEL = "a1f94f5b6390b515dc6714c2ca6f51b9";

const ROLES = ["workshop", "office", "admin", "viewer"] as const;
type Role = (typeof ROLES)[number];
type Person = { id: string; org: string; role: Role; session: string };
type Co = { o: string; people: Record<Role, Person> };
type Out = { ok: true; n: number } | { ok: false; code: string };
const KINDS = ["draw", "cert", "insp"] as const;
type Kind = (typeof KINDS)[number];

let pool: Pool;
let A: Co;
let B: Co;

// ---- Synthetic companies, as 156's test makes them (no Auth API: rows only) ---------------------------------------------------------
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
async function makeCompany(label: string): Promise<Co> {
  const o = randomUUID();
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic p159 ${o.slice(0, 8)}`, slug(label)]);
  const people = {} as Record<Role, Person>;
  for (const role of ROLES) {
    const id = randomUUID();
    const mail = email(`${label}-${role}`);
    await q("insert into auth.users (id, email) values ($1, $2)", [id, mail]);
    await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', $3, $4, true, false)", [id, mail, role, o]);
    await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, $3, true)", [o, id, role]);
    // Storage's RESTRICTIVE "storage requires active session" policy (033) needs a live session row for the token's session_id.
    const session = randomUUID();
    await q("insert into auth.sessions (id, user_id) values ($1, $2)", [session, id]);
    people[role] = { id, org: o, role, session };
  }
  return { o, people };
}

// ---- Roles inside one open transaction ---------------------------------------------------------------------------------------------
const claims = (p: Person) => ({ sub: p.id, role: "authenticated", aud: "authenticated", session_id: p.session, aal: "aal2", email: `${p.id.slice(0, 8)}@example.test` });
async function asUser(db: PoolClient, p: Person) {
  await db.query("reset role");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(p)), p.id]);
}
async function asService(db: PoolClient) {
  await db.query("reset role");
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
}
const asOwner = (db: PoolClient) => db.query("reset role");
/** One statement that may be refused: undone with a savepoint, resolves with the row count or the SQLSTATE. */
async function attempt(db: PoolClient, sql: string, params: unknown[] = []): Promise<Out> {
  await db.query("savepoint att");
  try {
    const r = await db.query(sql, params);
    await db.query("release savepoint att");
    return { ok: true, n: r.rowCount ?? 0 };
  } catch (e) {
    await db.query("rollback to savepoint att");
    return { ok: false, code: (e as { code?: string }).code ?? "?" };
  }
}
/** Runs fn and then undoes everything it did (rows, role, settings): the next caller sees the scene as it was. */
async function isolated<T>(db: PoolClient, fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint iso");
  try { return await fn(); } finally { await db.query("rollback to savepoint iso"); await db.query("release savepoint iso"); }
}
async function rolledBack<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    // The Storage API sets this to delete rows itself; a database that guards direct deletes (storage.protect_delete) then lets the policies decide.
    await db.query("select set_config('storage.allow_delete_query', 'true', true)");
    return await fn(db);
  } finally { await db.query("rollback").catch(() => undefined); db.release(); }
}
/** A release or rollback file without its own BEGIN / COMMIT, to run inside a test transaction. */
function body(file: string) {
  const s = read(file);
  expect(s.match(/^BEGIN;$/gm), file).toHaveLength(1);
  expect(s.match(/^COMMIT;$/gm), file).toHaveLength(1);
  return s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}
const install = async (db: PoolClient) => { await asOwner(db); await db.query(body(RELEASE)); };
const uninstall = async (db: PoolClient) => { await asOwner(db); await db.query(body(ROLLBACK)); };
/** A refused file or statement: the SQLSTATE and message, the transaction left as it was. */
async function refused(db: PoolClient, sql: string) {
  await db.query("savepoint refused");
  try { await db.query(sql); await db.query("release savepoint refused"); return null; } catch (e) { await db.query("rollback to savepoint refused"); return (e as Error).message; }
}

// ---- What the database says about the policy ------------------------------------------------------------------------------------------
type DrawingsState = { m: string; permissive: string; cmd: string; roles: string };
async function drawingsState(db: PoolClient, policy: string = POLICY): Promise<DrawingsState> {
  await asOwner(db);
  return (await db.query(`select md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) as m, p.permissive, p.cmd, p.roles::text as roles
      from pg_policies p
      where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = $1`, [policy])).rows[0] as DrawingsState;
}
const deleteState = (db: PoolClient) => drawingsState(db, POLICY_DEL);
const STATE_UPDATE = { permissive: "PERMISSIVE", cmd: "UPDATE", roles: "{authenticated}" };
const STATE_DELETE = { permissive: "PERMISSIVE", cmd: "DELETE", roles: "{authenticated}" };
/** Both policies as the database has them: { update, del } as md5 states. */
async function bothStates(db: PoolClient) { return { update: await drawingsState(db), del: await deleteState(db) }; }
type PolicyRow = { key: string; text: string };
/** Every policy in the database as "schema.table :: name" and its whole definition. */
async function policies(db: PoolClient): Promise<PolicyRow[]> {
  await asOwner(db);
  return (await db.query(`select schemaname || '.' || tablename || ' :: ' || policyname as key,
      concat_ws(' | ', permissive, roles::text, cmd, coalesce(qual, ''), coalesce(with_check, '')) as text
      from pg_policies order by 1`)).rows as PolicyRow[];
}
/** Every role membership as a stable text (the whole pg_auth_members row), to show a release or a refusal changed none. */
async function memberships(db: PoolClient): Promise<string[]> {
  await asOwner(db);
  return (await db.query(`select to_jsonb(m)::text as t from pg_catalog.pg_auth_members m order by m.roleid, m.member, m.grantor`)).rows.map((r) => r.t as string);
}
const withoutDrawings = (rows: PolicyRow[]) => rows.filter((r) => r.key !== `storage.objects :: ${POLICY}` && r.key !== `storage.objects :: ${POLICY_DEL}`);
async function verifyRows(db: PoolClient, file: string) {
  await asOwner(db);
  return (await db.query(read(file))).rows as { check_name: string; ok: boolean }[];
}
const failing = (rows: { check_name: string; ok: boolean }[]) => rows.filter((r) => r.ok !== true).map((r) => r.check_name);
/**
 * 131's verify is a baseline-state file: its row no_helper_called_per_row says "a later migration that adds such a policy makes this FALSE", and
 * releases 145 (company_setup_progress) and 152 (import_source_*) do add policies that call a helper per row. That row is FALSE here with or
 * without 159, so inside the rolled-back transaction those policies are dropped (the same condition the verify file uses) and every row of
 * 131's verify can then be read as the baseline reads it. The list returned is what was dropped, to prove the failure is theirs and not 159's.
 */
async function dropLaterHelperPolicies(db: PoolClient): Promise<string[]> {
  await asOwner(db);
  const rows = (await db.query(String.raw`select p.schemaname, p.tablename, p.policyname from pg_catalog.pg_policies p
      where (p.schemaname = 'public' or (p.schemaname, p.tablename) in (('storage', 'objects'), ('security_audit', 'audit_log')))
        and (p.schemaname, p.tablename, p.policyname) not in (('public', 'user_profiles', 'Users update own profile'), ('public', 'email_history', 'email_history rbac insert'))
        and regexp_replace(coalesce(p.qual, '') || ' | ' || coalesce(p.with_check, ''), '\( SELECT (auth\.)?[a-z_]+\([^()]*\) AS [a-z_]+\)', '', 'g')
            ~ '(^|[^a-z_.])(has_org_role|section_allowed|current_user_organization_id|user_organization_id|current_user_role|current_user_secondary_role|session_read_only|session_is_active)\(|auth\.(uid|jwt|role)\('
      order by 1, 2, 3`)).rows as { schemaname: string; tablename: string; policyname: string }[];
  for (const r of rows) await db.query(`drop policy "${r.policyname}" on "${r.schemaname}"."${r.tablename}"`);
  return rows.map((r) => `${r.tablename} :: ${r.policyname}`);
}
async function preflight(db: PoolClient, check: string) {
  await asOwner(db);
  return ((await db.query(read(PREFLIGHT))).rows as { check: string; value: string }[]).find((r) => r.check === check)?.value;
}
const ROW_60 = '159 needs: policy "job drawings org update" (UPDATE) / policy "job drawings org delete" (DELETE) on storage.objects, their texts (131 / 159 / other / missing each)';
const alterDrawings = async (db: PoolClient, text: string) => { await asOwner(db); await db.query(`alter policy "${POLICY}" on storage.objects ${text}`); };
/** Replaces the policy by one of another shape (kind, command or roles), as a hand-made drift. Rolled back with the transaction. */
const recreateDrawings = async (db: PoolClient, shape: string) => { await asOwner(db); await db.query(`drop policy "${POLICY}" on storage.objects`); await db.query(`create policy "${POLICY}" on storage.objects ${shape}`); };
const dropDrawings = async (db: PoolClient) => { await asOwner(db); await db.query(`drop policy "${POLICY}" on storage.objects`); };
const alterDelete = async (db: PoolClient, text: string) => { await asOwner(db); await db.query(`alter policy "${POLICY_DEL}" on storage.objects ${text}`); };
const recreateDelete = async (db: PoolClient, shape: string) => { await asOwner(db); await db.query(`drop policy "${POLICY_DEL}" on storage.objects`); await db.query(`create policy "${POLICY_DEL}" on storage.objects ${shape}`); };
const THIRD = "using (bucket_id = 'job-drawings') with check (bucket_id = 'job-drawings')";
const UPD_MISSING = /^159: policy "job drawings org update" on storage.objects is missing or is not the PERMISSIVE UPDATE policy/;
const UPD_NEITHER = /^159: policy "job drawings org update" is neither 131's nor 159's/;
const DEL_MISSING = /^159: policy "job drawings org delete" on storage.objects is missing or is not the PERMISSIVE DELETE policy/;
const DEL_NEITHER = /^159: policy "job drawings org delete" is neither 131's nor 159's/;
const HALF = /^159: the update and delete policies of job-drawings are in different states/;
const rb = (re: RegExp) => new RegExp(re.source.replace("^159:", "^159 rollback:").replace("neither 131's nor 159's", "neither 159's nor 131's"));
type Shape = { name: string; make: (db: PoolClient) => Promise<void>; row62: string; release: RegExp };
/**
 * Every drifted shape, each built from 131's state (both policies at 131's text), and what row 62 of release preflight reads for it
 * ("update / delete"; 'missing' also covers a wrong kind, command or role list). The rollback's message is the release's with its prefix.
 */
const DRIFTED: Shape[] = [
  // the update policy
  { name: "update: a third text", make: (db) => alterDrawings(db, THIRD), row62: "other / 131", release: UPD_NEITHER },
  { name: "update: using (true) with check (true)", make: (db) => alterDrawings(db, "using (true) with check (true)"), row62: "other / 131", release: UPD_NEITHER },
  { name: "update: 159's text but FOR DELETE (wrong command)", make: (db) => recreateDrawings(db, "for delete to authenticated using (false)"), row62: "missing / 131", release: UPD_MISSING },
  { name: "update: 159's text but roles {anon,authenticated} (wrong roles)", make: (db) => recreateDrawings(db, "for update to authenticated, anon using (false) with check (false)"), row62: "missing / 131", release: UPD_MISSING },
  { name: "update: 159's text but RESTRICTIVE (wrong kind)", make: (db) => recreateDrawings(db, "as restrictive for update to authenticated using (false) with check (false)"), row62: "missing / 131", release: UPD_MISSING },
  { name: "update: 131's text but roles {authenticated,anon} (wrong roles)", make: (db) => alterDrawings(db, "to authenticated, anon"), row62: "missing / 131", release: UPD_MISSING },
  { name: "update: the policy is missing", make: dropDrawings, row62: "missing / 131", release: UPD_MISSING },
  // the delete policy
  { name: "delete: a third text", make: (db) => alterDelete(db, "using (bucket_id = 'job-drawings')"), row62: "131 / other", release: DEL_NEITHER },
  { name: "delete: using (true)", make: (db) => alterDelete(db, "using (true)"), row62: "131 / other", release: DEL_NEITHER },
  { name: "delete: 159's text but FOR SELECT (wrong command)", make: (db) => recreateDelete(db, "for select to authenticated using (false)"), row62: "131 / missing", release: DEL_MISSING },
  { name: "delete: 159's text but roles {anon,authenticated} (wrong roles)", make: (db) => recreateDelete(db, "for delete to authenticated, anon using (false)"), row62: "131 / missing", release: DEL_MISSING },
  { name: "delete: 159's text but RESTRICTIVE (wrong kind)", make: (db) => recreateDelete(db, "as restrictive for delete to authenticated using (false)"), row62: "131 / missing", release: DEL_MISSING },
  { name: "delete: 131's text but roles {authenticated,anon} (wrong roles)", make: (db) => alterDelete(db, "to authenticated, anon"), row62: "131 / missing", release: DEL_MISSING },
  { name: "delete: the policy is missing", make: async (db) => { await asOwner(db); await db.query(`drop policy "${POLICY_DEL}" on storage.objects`); }, row62: "131 / missing", release: DEL_MISSING },
  // a MIX: one policy at 159's text, the other at 131's (a half install, in either direction)
  { name: "MIX: update at 159's text, delete at 131's", make: (db) => alterDrawings(db, "using (false) with check (false)"), row62: "159 / 131", release: HALF },
  { name: "MIX: update at 131's text, delete at 159's", make: (db) => alterDelete(db, "using (false)"), row62: "131 / 159", release: HALF },
];
/** Puts the open transaction in release 131's state (159 absent), whatever the database had. */
async function beforeState(db: PoolClient) {
  const s = await bothStates(db);
  if (s.update.m === M159 && s.del.m === M159_DEL) await uninstall(db);
  expect(await bothStates(db)).toEqual({ update: { m: M131, ...STATE_UPDATE }, del: { m: M131_DEL, ...STATE_DELETE } });
}

// ---- The scene: one company with a job, registered and unregistered objects in every bucket ---------------------------------------------
type Scene = { job: string; jobB: string; unreg: Record<Kind, string>; reg: Record<Kind, string>; del: Record<string, string>; bObj: string; quote: string; logo: string; photo: string; regFile: string };
const folder = (k: Kind) => (k === "draw" ? "" : k === "cert" ? "certs/" : "inspection/");
const EXT = (k: Kind) => (k === "cert" ? "pdf" : "png");
async function seed(db: PoolClient): Promise<Scene> {
  await asOwner(db);
  const job = (await db.query(`insert into public.jobs (organization_id, job_no, customer, stage, started_at, quantity_required) values ($1, $2, 'Drawings Co', 'material', '2026-10-01T08:00:00Z', 5) returning id`, [A.o, `J-P159-${runId}-A`])).rows[0].id as string;
  const jobB = (await db.query(`insert into public.jobs (organization_id, job_no, customer, stage, started_at, quantity_required) values ($1, $2, 'Other Co', 'material', '2026-10-01T08:00:00Z', 5) returning id`, [B.o, `J-P159-${runId}-B`])).rows[0].id as string;
  const unreg = {} as Record<Kind, string>;
  const reg = {} as Record<Kind, string>;
  for (const k of KINDS) {
    unreg[k] = `${A.o}/${job}/${folder(k)}200-unreg-${k}.${EXT(k)}`;
    reg[k] = `${A.o}/${job}/${folder(k)}100-reg-${k}.${EXT(k)}`;
  }
  const del: Record<string, string> = {};
  for (const who of [...ROLES, "b"]) del[who] = `${A.o}/${job}/300-del-${who}.png`;
  const scene: Scene = { job, jobB, unreg, reg, del, bObj: `${B.o}/${jobB}/200-b.png`, quote: `${A.o}/q-unreg.png`, logo: `${A.o}/logo.png`, photo: `${A.o}/photo.png`, regFile: "" };
  // Registered: a job_files row (drawing, cert) and an inspection's attachment_path, written as the database owner (a fixture write).
  scene.regFile = (await db.query(`insert into public.job_files (organization_id, job_id, kind, ref, revision, file_name, storage_bucket, storage_path, created_by) values ($1, $2, 'drawing', 'DWG-159', 'A', 'reg-draw.png', 'job-drawings', $3, $4) returning id`, [A.o, job, reg.draw, A.people.admin.id])).rows[0].id as string;
  await db.query(`insert into public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, created_by) values ($1, $2, 'cert', 'CERT-159', 'reg-cert.pdf', 'job-drawings', $3, $4)`, [A.o, job, reg.cert, A.people.admin.id]);
  await db.query(`insert into public.job_inspections (organization_id, job_id, result, release_decision, measured_notes, attachment_path, attachment_name, inspector_id, inspector_name, worksheet_version) values ($1, $2, 'pass', 'released', 'ok', $3, 'reg-insp.png', null, 'Legacy', 0)`, [A.o, job, reg.insp]);
  // The objects, written as the service role (row-level security bypassed, as the Storage API's own writes are).
  await asService(db);
  const put = (bucket: string, name: string) => db.query(`insert into storage.objects (bucket_id, name, metadata) values ($1, $2, '{"v": 1}'::jsonb)`, [bucket, name]);
  for (const k of KINDS) { await put("job-drawings", unreg[k]); await put("job-drawings", reg[k]); }
  for (const name of Object.values(del)) await put("job-drawings", name);
  await put("job-drawings", scene.bObj);
  await put("quote-attachments", scene.quote);
  await put("org-logos", scene.logo);
  await put("job-photos", scene.photo);
  await asOwner(db);
  return scene;
}
type Snap = Record<string, string>;
/** Every object of the two companies as name -> metadata, read as the service role. */
async function snapshot(db: PoolClient): Promise<Snap> {
  await asService(db);
  const rows = (await db.query(`select bucket_id || ':' || name as k, coalesce(metadata::text, '') as m from storage.objects where name like $1 or name like $2 order by 1`, [`${A.o}/%`, `${B.o}/%`])).rows as { k: string; m: string }[];
  return Object.fromEntries(rows.map((r) => [r.k, r.m]));
}
const changedObjects = (b: Snap, a: Snap) => Object.keys({ ...b, ...a }).filter((k) => b[k] !== a[k]).sort();

const UPDATE_META = `update storage.objects set metadata = '{"v": 2}'::jsonb where bucket_id = 'job-drawings' and name = $1`;
const UPDATE_NAME = `update storage.objects set name = name || '.moved' where bucket_id = 'job-drawings' and name = $1`;
const UPSERT = `insert into storage.objects (bucket_id, name, metadata) values ('job-drawings', $1, '{"v": 2}'::jsonb) on conflict (bucket_id, name) do update set metadata = excluded.metadata`;
const INSERT = `insert into storage.objects (bucket_id, name, metadata) values ('job-drawings', $1, '{"v": 3}'::jsonb)`;
const DELETE = `delete from storage.objects where bucket_id = 'job-drawings' and name = $1`;
const seen = async (db: PoolClient, name: string) => Number((await db.query(`select count(*) as n from storage.objects where bucket_id = 'job-drawings' and name = $1`, [name])).rows[0].n);

/** What one person's attempts do to the unregistered objects (update, rename, upsert), and which objects end up different. Undone afterwards. */
async function probeUpdates(db: PoolClient, who: Person, s: Scene) {
  return isolated(db, async () => {
    const before = await snapshot(db);
    await asUser(db, who);
    const out: Record<string, Out> = {};
    for (const k of KINDS) out[`update-${k}`] = await attempt(db, UPDATE_META, [s.unreg[k]]);
    out["rename-draw"] = await attempt(db, UPDATE_NAME, [s.unreg.draw]);
    for (const k of KINDS) out[`upsert-${k}`] = await attempt(db, UPSERT, [s.unreg[k]]);
    return { out, changed: changedObjects(before, await snapshot(db)) };
  });
}
/** Insert, read, delete and the registered files' protection, for one person. Undone afterwards. */
async function probeRest(db: PoolClient, who: Person, s: Scene, base = A.o) {
  return isolated(db, async () => {
    await asUser(db, who);
    const out: Record<string, unknown> = {};
    for (const k of KINDS) out[`insert-${k}`] = await attempt(db, INSERT, [`${base}/${s.job}/${folder(k)}400-new-${who.role}-${k}.${EXT(k)}`]);
    for (const k of KINDS) out[`select-${k}`] = await seen(db, s.unreg[k]);
    out["select-registered"] = await seen(db, s.reg.draw);
    out["delete-own"] = await attempt(db, DELETE, [s.del[who.org === A.o ? who.role : "b"]]);
    out["delete-own-still-there"] = await seen(db, s.del[who.org === A.o ? who.role : "b"]);
    for (const k of KINDS) out[`delete-registered-${k}`] = await attempt(db, DELETE, [s.reg[k]]);
    for (const k of KINDS) out[`update-registered-${k}`] = await attempt(db, UPDATE_META, [s.reg[k]]);
    for (const k of KINDS) out[`upsert-registered-${k}`] = await attempt(db, UPSERT, [s.reg[k]]);
    return out;
  });
}
/**
 * Delete, then upload again at the same path, in the drawing, certs/ and inspection/ folders, for one person: the way to overwrite an object
 * without any UPDATE. Before 159 an admin, office or workshop user deletes and re-inserts (the object is replaced); after it the delete finds no
 * row it may remove (0 rows, no error), the second insert then meets the object that is still there (a unique violation, 23505; a viewer or another
 * company's user is stopped by row-level security first, 42501), and no object changed. Undone afterwards.
 */
async function probeDeleteReupload(db: PoolClient, who: Person, s: Scene) {
  return isolated(db, async () => {
    const before = await snapshot(db);
    await asUser(db, who);
    const out: Record<string, Out> = {};
    for (const k of KINDS) {
      out[`delete-${k}`] = await attempt(db, DELETE, [s.unreg[k]]);
      out[`reupload-${k}`] = await attempt(db, INSERT, [s.unreg[k]]);
    }
    return { out, changed: changedObjects(before, await snapshot(db)) };
  });
}
/** The three other buckets (quote-attachments, org-logos, job-photos): an update attempt by one person on the company's object. */
async function probeOtherBuckets(db: PoolClient, who: Person, s: Scene) {
  return isolated(db, async () => {
    await asUser(db, who);
    const upd = (bucket: string, name: string) => attempt(db, `update storage.objects set metadata = '{"v": 2}'::jsonb where bucket_id = $1 and name = $2`, [bucket, name]);
    return { quote: await upd("quote-attachments", s.quote), logo: await upd("org-logos", s.logo), photo: await upd("job-photos", s.photo) };
  });
}
/** One full matrix for the open transaction: every person of A, and company B's admin against A's folder. */
async function matrix(db: PoolClient, s: Scene) {
  const actors: [string, Person][] = [...ROLES.map((r) => [r, A.people[r]] as [string, Person]), ["otherCompanyAdmin", B.people.admin]];
  const m: Record<string, { updates: Awaited<ReturnType<typeof probeUpdates>>; rest: Record<string, unknown>; other: Awaited<ReturnType<typeof probeOtherBuckets>>; reup: Awaited<ReturnType<typeof probeDeleteReupload>> }> = {};
  for (const [name, who] of actors) m[name] = { updates: await probeUpdates(db, who, s), rest: await probeRest(db, who, s), other: await probeOtherBuckets(db, who, s), reup: await probeDeleteReupload(db, who, s) };
  return m;
}
/** Before (release 131's state) and after (159 installed) matrices of the same scene, in one rolled-back transaction. */
async function beforeAndAfter() {
  return rolledBack(async (db) => {
    await beforeState(db);
    const s = await seed(db);
    const before = await matrix(db, s);
    await install(db);
    expect(await bothStates(db)).toEqual({ update: { m: M159, ...STATE_UPDATE }, del: { m: M159_DEL, ...STATE_DELETE } });
    const after = await matrix(db, s);
    return { s, before, after };
  });
}

const REFUSED = { ok: false, code: "42501" } as const;
const ZERO = { ok: true, n: 0 } as const;
const ONE = { ok: true, n: 1 } as const;

describe("release 159: nobody can replace an object in the job-drawings bucket from the browser", () => {
  let result: Awaited<ReturnType<typeof beforeAndAfter>>;

  beforeAll(async () => {
    await verifyBackendIdentity();
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 4 });
    // storage.objects is shaped as Storage makes it: one object per (bucket, name), row security on.
    const shape = await q<{ idx: string; rls: boolean }>(`select (select count(*) from pg_indexes where schemaname = 'storage' and tablename = 'objects' and indexdef ilike '%unique%(bucket_id, name)%')::text as idx,
        (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) as rls`);
    expect(shape[0]).toEqual({ idx: "1", rls: true });
    A = await makeCompany("a");
    B = await makeCompany("b");
    result = await beforeAndAfter();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await destroySyntheticWorld(runId);
  });

  it("1. before 159 workshop, office and admin could update, rename and upsert over an unregistered object (the defect); after it nobody can, and the object is unchanged", () => {
    for (const role of ["workshop", "office", "admin"] as const) {
      const b = result.before[role].updates;
      for (const k of KINDS) { expect(b.out[`update-${k}`], `${role} before ${k}`).toEqual(ONE); expect(b.out[`upsert-${k}`], `${role} before upsert ${k}`).toEqual(ONE); }
      expect(b.changed.length, `${role} before: objects changed`).toBeGreaterThan(0);
    }
    // The viewer never could.
    for (const k of KINDS) { expect(result.before.viewer.updates.out[`update-${k}`]).toEqual(ZERO); expect(result.before.viewer.updates.out[`upsert-${k}`]).toEqual(REFUSED); }
    expect(result.before.viewer.updates.changed).toEqual([]);
    // After: an update or rename finds no row it may touch (0 rows, no error); an upsert is refused by row-level security (42501); nothing changed.
    for (const role of ROLES) {
      const a = result.after[role].updates;
      for (const k of KINDS) { expect(a.out[`update-${k}`], `${role} update ${k}`).toEqual(ZERO); expect(a.out[`upsert-${k}`], `${role} upsert ${k}`).toEqual(REFUSED); }
      expect(a.out["rename-draw"], `${role} rename`).toEqual(ZERO);
      expect(a.changed, `${role}: objects changed`).toEqual([]);
    }
  });

  it("1b. the three paths are the drawing, certs/ and inspection/ folders of the job, and an unchanged object keeps its bytes' metadata after every refused attempt", async () => {
    expect(result.s.unreg.draw).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/200-unreg-draw\.png$/);
    expect(result.s.unreg.cert).toMatch(/\/certs\/200-unreg-cert\.pdf$/);
    expect(result.s.unreg.insp).toMatch(/\/inspection\/200-unreg-insp\.png$/);
    // Read it back inside the release state: the metadata is still the seeded {"v": 1} after the refused attempts of all four roles.
    await rolledBack(async (db) => {
      await beforeState(db);
      const s = await seed(db);
      await install(db);
      for (const role of ROLES) await probeUpdates(db, A.people[role], s);
      const snap = await snapshot(db);
      for (const k of KINDS) expect(JSON.parse(snap[`job-drawings:${s.unreg[k]}`])).toEqual({ v: 1 });
    });
  });

  it("2. registered objects (a job_files row, a job_inspections attachment_path) are protected exactly as before: no update, upsert or delete, before and after", () => {
    for (const role of ROLES) {
      for (const k of KINDS) {
        for (const side of ["before", "after"] as const) {
          const r = result[side][role].rest;
          expect(r[`update-registered-${k}`], `${role} ${side} update registered ${k}`).toEqual(ZERO);
          expect(r[`upsert-registered-${k}`], `${role} ${side} upsert registered ${k}`).toEqual(REFUSED);
          expect(r[`delete-registered-${k}`], `${role} ${side} delete registered ${k}`).toEqual(ZERO);
        }
      }
    }
  });

  it("3. new uploads still work: workshop, office and admin insert a new object under their company folder (drawing, certs/, inspection/); the viewer still cannot", () => {
    for (const side of ["before", "after"] as const) {
      for (const role of ["workshop", "office", "admin"] as const) for (const k of KINDS) expect(result[side][role].rest[`insert-${k}`], `${role} ${side} insert ${k}`).toEqual(ONE);
      for (const k of KINDS) expect(result[side].viewer.rest[`insert-${k}`], `viewer ${side} insert ${k}`).toEqual(REFUSED);
    }
  });

  it("4. select is unchanged for every role; DELETE of an unregistered object is now REFUSED for admin, office, workshop and viewer (0 rows, the object stays)", () => {
    // CHANGE OF MEANING (release 159, delete policy): this test used to read "select and delete are unchanged for every role" and expected
    // delete-own to give the same result before and after (1 row for admin, office, workshop; 0 for the viewer). Browser deletes are now refused
    // too, because a delete followed by a new upload at the same path would overwrite an object that the update policy protects. Select is still
    // compared before and after, unchanged. The before side below still shows the defect (the three roles could delete).
    for (const role of ROLES) {
      const b = result.before[role].rest;
      const a = result.after[role].rest;
      for (const k of KINDS) expect(a[`select-${k}`], `${role} select ${k}`).toEqual(b[`select-${k}`]);
      expect(a["select-registered"]).toEqual(b["select-registered"]);
      expect(a["select-draw"], `${role} select`).toBe(1);
      expect(b["delete-own"], `${role} delete before 159`).toEqual(role === "viewer" ? ZERO : ONE);
      expect(b["delete-own-still-there"], `${role} object before 159`).toBe(role === "viewer" ? 1 : 0);
      expect(a["delete-own"], `${role} delete after 159`).toEqual(ZERO);
      expect(a["delete-own-still-there"], `${role} object after 159`).toBe(1);
    }
  });

  it("4b. delete then re-upload at the same path is refused in all three folders (drawing, certs/, inspection/) for every role, and the other company is unaffected", () => {
    // Before 159 workshop, office and admin could delete an unregistered object and upload another one at its path (an overwrite without UPDATE).
    for (const role of ["workshop", "office", "admin"] as const) {
      const b = result.before[role].reup;
      for (const k of KINDS) { expect(b.out[`delete-${k}`], `${role} before delete ${k}`).toEqual(ONE); expect(b.out[`reupload-${k}`], `${role} before reupload ${k}`).toEqual(ONE); }
      expect(b.changed.length, `${role} before: objects changed`).toBe(KINDS.length);
    }
    for (const k of KINDS) { expect(result.before.viewer.reup.out[`delete-${k}`]).toEqual(ZERO); expect(result.before.viewer.reup.out[`reupload-${k}`]).toEqual(REFUSED); }
    // After 159: the delete removes nothing, the re-upload meets the object that is still there (23505) or, for the viewer, is stopped by row-level security; nothing changed.
    const UNIQUE = { ok: false, code: "23505" } as const;
    for (const role of ROLES) {
      const a = result.after[role].reup;
      for (const k of KINDS) {
        expect(a.out[`delete-${k}`], `${role} after delete ${k}`).toEqual(ZERO);
        expect(a.out[`reupload-${k}`], `${role} after reupload ${k}`).toEqual(role === "viewer" ? REFUSED : UNIQUE);
      }
      expect(a.changed, `${role} after: objects changed`).toEqual([]);
    }
    // The other company's admin, against company A's paths: before and after, nothing is deleted, nothing is inserted, nothing changed.
    for (const side of ["before", "after"] as const) {
      const o = result[side].otherCompanyAdmin.reup;
      for (const k of KINDS) { expect(o.out[`delete-${k}`], `${side} B delete ${k}`).toEqual(ZERO); expect(o.out[`reupload-${k}`], `${side} B reupload ${k}`).toEqual(REFUSED); }
      expect(o.changed, `${side} B: objects changed`).toEqual([]);
    }
  });

  it("5. admin revision registration works end to end after 159 and needs no UPDATE on storage.objects", async () => {
    await rolledBack(async (db) => {
      await beforeState(db);
      const s = await seed(db);
      await install(db);
      const admin = A.people.admin;
      const newPath = `${A.o}/${s.job}/500-bracket-B.png`;
      await asUser(db, admin);
      // The new revision's file is a plain upload (an INSERT), then bump_drawing_revision registers it: job_files and jobs rows only.
      expect(await attempt(db, INSERT, [newPath])).toEqual(ONE);
      const bumped = (await db.query("select public.bump_drawing_revision($1, 'B', 'bracket-B.png', $2) as id", [s.regFile, newPath])).rows[0].id as string;
      expect(bumped).toMatch(/^[0-9a-f-]{36}$/);
      await asOwner(db);
      const files = (await db.query("select id, revision, storage_path, superseded_at is not null as superseded, superseded_by from public.job_files where job_id = $1 and kind = 'drawing' order by revision", [s.job])).rows;
      expect(files).toEqual([
        { id: s.regFile, revision: "A", storage_path: s.reg.draw, superseded: true, superseded_by: bumped },
        { id: bumped, revision: "B", storage_path: newPath, superseded: false, superseded_by: null },
      ]);
      // set_job_drawing_revision (083), by the admin: the job's own revision and whether it is required.
      await asUser(db, admin);
      const set = (await db.query("select public.set_job_drawing_revision($1, true, 'B', 'Revision B approved by the customer') as r", [s.job])).rows[0].r;
      expect(set).toMatchObject({ drawing_revision: "B", drawing_revision_required: true, changed: true });
      // A workshop user registers a cert for a plain upload too (job_files insert, as the app does) and the new revision is protected like any registered file.
      const certPath = `${A.o}/${s.job}/certs/510-cert.pdf`;
      await asUser(db, A.people.workshop);
      expect(await attempt(db, INSERT, [certPath])).toEqual(ONE);
      expect(await attempt(db, "insert into public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path) values ($1, $2, 'cert', 'C-510', 'cert.pdf', 'job-drawings', $3)", [A.o, s.job, certPath])).toEqual(ONE);
      await asUser(db, admin);
      expect(await attempt(db, UPDATE_META, [newPath])).toEqual(ZERO);
      expect(await attempt(db, UPSERT, [newPath])).toEqual(REFUSED);
      // Nothing in the revision path writes storage.objects: the functions and every trigger on the tables they write.
      await asOwner(db);
      const sources = (await db.query(`select p.proname, p.prosrc from pg_proc p where p.oid in (to_regprocedure('public.bump_drawing_revision(uuid,text,text,text)'), to_regprocedure('public.set_job_drawing_revision(uuid,boolean,text,text)'))
        union all select p.proname, p.prosrc from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid in ('public.job_files'::regclass, 'public.jobs'::regclass, 'public.job_inspections'::regclass) and not t.tgisinternal`)).rows as { proname: string; prosrc: string }[];
      expect(sources.length).toBeGreaterThan(2);
      expect(sources.filter((r) => /storage\.objects|storage\.|from storage|update\s+storage/i.test(r.prosrc)).map((r) => r.proname)).toEqual([]);
    });
  });

  it("6. the service role can still update and replace an object, and rename and delete it (the clean-up route), before and after (authorised service operations)", async () => {
    for (const installed of [false, true]) {
      await rolledBack(async (db) => {
        await beforeState(db);
        const s = await seed(db);
        if (installed) await install(db);
        await asService(db);
        expect(await attempt(db, UPDATE_META, [s.unreg.draw]), `update installed=${installed}`).toEqual(ONE);
        expect(await attempt(db, UPSERT, [s.unreg.cert]), `upsert installed=${installed}`).toEqual(ONE);
        expect(await attempt(db, UPDATE_META, [s.reg.draw]), `registered installed=${installed}`).toEqual(ONE);
        expect(await attempt(db, UPDATE_NAME, [s.unreg.insp]), `rename installed=${installed}`).toEqual(ONE);
        expect(await attempt(db, DELETE, [s.del.admin]), `delete installed=${installed}`).toEqual(ONE);
        expect(await seen(db, s.del.admin), `deleted installed=${installed}`).toBe(0);
        const snap = await snapshot(db);
        expect(JSON.parse(snap[`job-drawings:${s.unreg.draw}`])).toEqual({ v: 2 });
        expect(JSON.parse(snap[`job-drawings:${s.unreg.cert}`])).toEqual({ v: 2 });
        // The clean-up route for a half-finished upload (an unregistered object): the service role deletes it, in every folder, before and after.
        expect(await attempt(db, DELETE, [s.unreg.draw]), `cleanup drawing installed=${installed}`).toEqual(ONE);
        expect(await attempt(db, DELETE, [s.unreg.cert]), `cleanup cert installed=${installed}`).toEqual(ONE);
        expect(await attempt(db, DELETE, [`${s.unreg.insp}.moved`]), `cleanup renamed inspection object installed=${installed}`).toEqual(ONE);
        expect(await seen(db, s.unreg.draw) + (await seen(db, s.unreg.cert)) + (await seen(db, `${s.unreg.insp}.moved`)), `cleaned installed=${installed}`).toBe(0);
      });
    }
  });

  it("7. a user of company B cannot update, insert into, select or delete in company A's folder, before and after", () => {
    for (const side of ["before", "after"] as const) {
      const u = result[side].otherCompanyAdmin;
      for (const k of KINDS) {
        expect(u.updates.out[`update-${k}`], `${side} update ${k}`).toEqual(ZERO);
        expect(u.updates.out[`upsert-${k}`], `${side} upsert ${k}`).toEqual(REFUSED);
        expect(u.rest[`insert-${k}`], `${side} insert ${k}`).toEqual(REFUSED);
        expect(u.rest[`select-${k}`], `${side} select ${k}`).toBe(0);
        expect(u.rest[`delete-registered-${k}`]).toEqual(ZERO);
      }
      expect(u.updates.out["rename-draw"]).toEqual(ZERO);
      expect(u.updates.changed).toEqual([]);
      expect(u.rest["delete-own"]).toEqual(ZERO);
    }
  });

  it("8. other buckets are unaffected: quote-attachments, org-logos and job-photos answer an update exactly as before", () => {
    for (const role of ROLES) {
      expect(result.after[role].other, role).toEqual(result.before[role].other);
      const o = result.after[role].other;
      // quote-attachments: admin and office (006); org-logos: admin (008); job-photos: nobody (040's RESTRICTIVE rule).
      expect(o.quote, `${role} quote-attachments`).toEqual(role === "admin" || role === "office" ? ONE : ZERO);
      expect(o.logo, `${role} org-logos`).toEqual(role === "admin" ? ONE : ZERO);
      expect(o.photo, `${role} job-photos`).toEqual(ZERO);
    }
    expect(result.after.otherCompanyAdmin.other).toEqual(result.before.otherCompanyAdmin.other);
    expect(result.after.otherCompanyAdmin.other).toEqual({ quote: ZERO, logo: ZERO, photo: ZERO });
  });

  it("9. the catalogue: the policy count is unchanged, only the two drawings policies differ (159's md5s), and 131's verify is true with 159 installed and after the rollback", async () => {
    await rolledBack(async (db) => {
      await beforeState(db);
      // As the database stands (145..159 installed) only no_helper_called_per_row fails, and it fails the same with 159 absent and installed.
      expect(failing(await verifyRows(db, VERIFY_131)), "131 verify, 159 absent, later releases in place").toEqual(["no_helper_called_per_row"]);
      await install(db);
      expect(failing(await verifyRows(db, VERIFY_131)), "131 verify, 159 installed, later releases in place").toEqual(["no_helper_called_per_row"]);
      await uninstall(db);
      expect((await dropLaterHelperPolicies(db)).map((x) => x.split(" :: ")[0]).sort()).toEqual(expect.arrayContaining(["company_setup_progress", "import_source_batches", "import_source_rows"]));
      const was = await policies(db);
      expect(await bothStates(db)).toEqual({ update: { m: M131, ...STATE_UPDATE }, del: { m: M131_DEL, ...STATE_DELETE } });
      expect(failing(await verifyRows(db, VERIFY_131)), "131 verify, 159 absent").toEqual([]);
      await install(db);
      const now = await policies(db);
      expect(now).toHaveLength(was.length);
      expect(withoutDrawings(now)).toEqual(withoutDrawings(was));
      expect(now.filter((r, i) => r.text !== was[i].text).map((r) => r.key)).toEqual([`storage.objects :: ${POLICY_DEL}`, `storage.objects :: ${POLICY}`]);
      expect(await bothStates(db)).toEqual({ update: { m: M159, ...STATE_UPDATE }, del: { m: M159_DEL, ...STATE_DELETE } });
      expect(now.find((r) => r.key === `storage.objects :: ${POLICY}`)!.text).toBe("PERMISSIVE | {authenticated} | UPDATE | false | false");
      expect(now.find((r) => r.key === `storage.objects :: ${POLICY_DEL}`)!.text).toBe("PERMISSIVE | {authenticated} | DELETE | false | ");
      expect((await verifyRows(db, VERIFY_131)).length).toBe(4);
      expect(failing(await verifyRows(db, VERIFY_131)), "131 verify, 159 installed").toEqual([]);
      expect(failing(await verifyRows(db, VERIFY)), "159 verify").toEqual([]);
      await uninstall(db);
      expect(await policies(db)).toEqual(was);
      expect(failing(await verifyRows(db, VERIFY_131)), "131 verify after rollback").toEqual([]);
      // 159's own verify is not true once rolled back (the policies are 131's again).
      expect(failing(await verifyRows(db, VERIFY)).length).toBeGreaterThan(0);
    });
  });

  it("9b. 131's verify accepts EXACTLY two texts for each of the two drawings policies (131's, 159's): any third text, a missing policy, or another kind, command or role list is FALSE; drift in another policy is FALSE", async () => {
    const wrapped = async (db: PoolClient) => failing(await verifyRows(db, VERIFY_131));
    await rolledBack(async (db) => {
      await beforeState(db);
      await dropLaterHelperPolicies(db);
      // 159 absent (131's texts): TRUE. Every drifted shape that is not a MIX: FALSE. A MIX is judged by 159's own verify and preflight, not by 131's per-policy rows (each text is one of its two).
      expect(await wrapped(db)).toEqual([]);
      for (const [i, shape] of DRIFTED.entries()) {
        await db.query(`savepoint d${i}`); await shape.make(db);
        expect(await wrapped(db), `${shape.name}, 159 absent`).toEqual(shape.name.startsWith("MIX") ? [] : ["policies_131_wrapped"]);
        await db.query(`rollback to savepoint d${i}`);
      }
      // Another policy's drift is still found with 159 absent.
      await db.query("savepoint s4");
      await asOwner(db); await db.query(`alter policy "job drawings org select" on storage.objects using (bucket_id = 'job-drawings')`);
      expect(await wrapped(db), "another policy, 159 absent").toEqual(["policies_131_wrapped"]);
      await db.query("rollback to savepoint s4");
      expect(await wrapped(db)).toEqual([]);

      // 159 installed (159's texts): TRUE, with no comment or other trace read. A third text or a changed shape on either policy: FALSE.
      await install(db);
      expect(await bothStates(db)).toEqual({ update: { m: M159, ...STATE_UPDATE }, del: { m: M159_DEL, ...STATE_DELETE } });
      expect(await wrapped(db)).toEqual([]);
      const installedDrift: [string, (db: PoolClient) => Promise<void>][] = [
        ["update: third text", (d) => alterDrawings(d, THIRD)],
        ["update: using (true)", (d) => alterDrawings(d, "using (true) with check (true)")],
        ["update: wrong roles", (d) => alterDrawings(d, "to authenticated, anon")],
        ["update: wrong command", (d) => recreateDrawings(d, "for delete to authenticated using (false)")],
        ["update: missing", dropDrawings],
        ["delete: third text", (d) => alterDelete(d, "using (bucket_id = 'job-drawings')")],
        ["delete: using (true)", (d) => alterDelete(d, "using (true)")],
        ["delete: wrong roles", (d) => alterDelete(d, "to authenticated, anon")],
        ["delete: wrong command", (d) => recreateDelete(d, "for select to authenticated using (false)")],
        ["delete: missing", async (d) => { await asOwner(d); await d.query(`drop policy "${POLICY_DEL}" on storage.objects`); }],
      ];
      for (const [i, [name, make]] of installedDrift.entries()) {
        await db.query(`savepoint e${i}`); await make(db);
        expect(await wrapped(db), `${name}, 159 installed`).toEqual(["policies_131_wrapped"]);
        await db.query(`rollback to savepoint e${i}`);
      }
      await db.query("savepoint s9");
      await asOwner(db); await db.query(`alter policy "job drawings org select" on storage.objects using (bucket_id = 'job-drawings')`);
      expect(await wrapped(db), "another policy, 159 installed").toEqual(["policies_131_wrapped"]);
      await db.query("rollback to savepoint s9");
      expect(await wrapped(db)).toEqual([]);
      // Every other check in the file still reads as before.
      expect((await verifyRows(db, VERIFY_131)).map((r) => r.check_name)).toEqual(["policies_131_wrapped", "no_helper_called_per_row", "wrapped_helpers_are_stable", "legacy_audit_log_policy_wrapped"]);
    });
  });

  it("10. release mechanics: the committed state is installed and verified; repeating changes nothing; rollback restores 131's exact texts and md5s; re-release; role memberships untouched", async () => {
    // The fixture installed 159 and verified every row before this file began.
    await rolledBack(async (db) => {
      expect(await bothStates(db)).toEqual({ update: { m: M159, ...STATE_UPDATE }, del: { m: M159_DEL, ...STATE_DELETE } });
      expect(failing(await verifyRows(db, VERIFY))).toEqual([]);
      expect(await preflight(db, MARKER)).toBe("applied");
      expect(await preflight(db, ROW_60)).toBe("159 / 159");
      await dropLaterHelperPolicies(db);
      const installed = await policies(db);
      const members = await memberships(db);
      await install(db); // repeat: installed -> nothing changes
      expect(await policies(db)).toEqual(installed);
      expect(await bothStates(db)).toEqual({ update: { m: M159, ...STATE_UPDATE }, del: { m: M159_DEL, ...STATE_DELETE } });
      expect(await memberships(db)).toEqual(members);

      await uninstall(db);
      const rolled = await policies(db);
      expect(await bothStates(db)).toEqual({ update: { m: M131, ...STATE_UPDATE }, del: { m: M131_DEL, ...STATE_DELETE } });
      expect(rolled.find((r) => r.key === `storage.objects :: ${POLICY}`)!.text).toContain("job-drawings");
      expect(rolled.find((r) => r.key === `storage.objects :: ${POLICY_DEL}`)!.text).toContain("job-drawings");
      expect(await preflight(db, MARKER)).toBe("not applied");
      expect(await preflight(db, ROW_60)).toBe("131 / 131");
      await uninstall(db); // rollback twice = once (absent: the rollback re-asserts 131's texts and changes nothing)
      expect(await policies(db)).toEqual(rolled);
      expect(failing(await verifyRows(db, VERIFY_131))).toEqual([]);

      await install(db);
      expect(await policies(db)).toEqual(installed);
      expect(failing(await verifyRows(db, VERIFY))).toEqual([]);
      expect(await preflight(db, MARKER)).toBe("applied");
      expect(await memberships(db)).toEqual(members);
    });
  });

  it("10a. rollback then re-release: the rollback's texts are 131's byte for byte (the text pg_policies gave before 159), and re-releasing verifies", async () => {
    const texts = async (db: PoolClient) => (await db.query(`select policyname, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ($1, $2) order by policyname`, [POLICY, POLICY_DEL])).rows;
    await rolledBack(async (db) => {
      await beforeState(db);
      const text131 = await texts(db);
      expect(text131).toHaveLength(2);
      await install(db);
      expect(await texts(db)).toEqual([{ policyname: POLICY_DEL, qual: "false", with_check: null }, { policyname: POLICY, qual: "false", with_check: "false" }]);
      await uninstall(db);
      expect(await texts(db)).toEqual(text131);
      await install(db);
      expect(failing(await verifyRows(db, VERIFY))).toEqual([]);
    });
  });

  it("10b. DRIFTED (every shape, a MIX of the two policies included): the release and the rollback refuse with a clear message and change nothing; preflight does not read 'applied'", async () => {
    for (const shape of DRIFTED) {
      await rolledBack(async (db) => {
        await beforeState(db);
        await shape.make(db);
        const drifted = await policies(db);
        const members = await memberships(db);
        expect(await refused(db, body(RELEASE)), `release on ${shape.name}`).toMatch(shape.release);
        expect(await refused(db, body(ROLLBACK)), `rollback on ${shape.name}`).toMatch(rb(shape.release));
        expect(await policies(db), `${shape.name}: nothing changed`).toEqual(drifted);
        expect(await memberships(db)).toEqual(members);
        expect(await preflight(db, MARKER), `marker on ${shape.name}`).toBe("not applied");
        expect(await preflight(db, ROW_60), `row 62 on ${shape.name}`).toBe(shape.row62);
        expect(failing(await verifyRows(db, VERIFY)).length, `159 verify on ${shape.name}`).toBeGreaterThan(0);
      });
    }
    // Each policy at 159's text but with a wrong kind, command or roles is not "installed" (the marker, 159's verify) though the md5 of its text is 159's.
    await rolledBack(async (db) => {
      await beforeState(db);
      await install(db);
      await alterDrawings(db, "to authenticated, anon");
      expect((await drawingsState(db)).m).toBe(M159);
      expect(await preflight(db, MARKER)).toBe("not applied");
      expect(await preflight(db, ROW_60)).toBe("missing / 159");
      expect(failing(await verifyRows(db, VERIFY)).length).toBeGreaterThan(0);
    });
    await rolledBack(async (db) => {
      await beforeState(db);
      await install(db);
      await alterDelete(db, "to authenticated, anon");
      expect((await deleteState(db)).m).toBe(M159_DEL);
      expect(await preflight(db, MARKER)).toBe("not applied");
      expect(await preflight(db, ROW_60)).toBe("159 / missing");
      expect(failing(await verifyRows(db, VERIFY)).length).toBeGreaterThan(0);
    });
  });

  it("10c. a partial install is never accepted: from either half-installed state the marker is not applied, 159's verify is false, the release does not complete it and the rollback does not guess", async () => {
    for (const [name, make, row62] of [
      ["update at 159, delete at 131", (db: PoolClient) => alterDrawings(db, "using (false) with check (false)"), "159 / 131"],
      ["update at 131, delete at 159", (db: PoolClient) => alterDelete(db, "using (false)"), "131 / 159"],
    ] as const) {
      await rolledBack(async (db) => {
        await beforeState(db);
        await make(db);
        const half = await policies(db);
        expect(await preflight(db, MARKER), name).toBe("not applied");
        expect(await preflight(db, ROW_60), name).toBe(row62);
        expect(failing(await verifyRows(db, VERIFY)).length, name).toBeGreaterThan(0);
        expect(await refused(db, body(RELEASE)), name).toMatch(HALF);
        expect(await refused(db, body(ROLLBACK)), name).toMatch(rb(HALF));
        expect(await policies(db), name).toEqual(half);
      });
    }
  });

  it("10d. the three states in one place: absent (131's texts) releases, installed (159's texts) repeats unchanged, and the marker reads applied only for installed", async () => {
    await rolledBack(async (db) => {
      await beforeState(db);
      expect(await preflight(db, MARKER)).toBe("not applied");
      expect(await preflight(db, ROW_60)).toBe("131 / 131");
      expect(await refused(db, body(RELEASE))).toBeNull();
      expect(await bothStates(db)).toEqual({ update: { m: M159, ...STATE_UPDATE }, del: { m: M159_DEL, ...STATE_DELETE } });
      expect(await preflight(db, MARKER)).toBe("applied");
      expect(await preflight(db, ROW_60)).toBe("159 / 159");
      const installed = await policies(db);
      expect(await refused(db, body(RELEASE))).toBeNull();
      expect(await policies(db)).toEqual(installed);
    });
  });
});
