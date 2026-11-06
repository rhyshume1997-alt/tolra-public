import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

export const subject = 'db3c2aa5415570e4a3c755e1452d2c94bdc52c9b';
export const original = '00765a5991757b689eaa7e81f6aebab1ca318928';
export const read = file => readFileSync(file, 'utf8');
export const phases = JSON.parse(read('supabase/release-plan.json')).phases.filter(p => p.number >= 145 && p.number <= 151);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const sourceSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
export function save(name, data) {
  mkdirSync('evidence/builder3', { recursive: true });
  writeFileSync(`evidence/builder3/${name}.json`, JSON.stringify({ status: 'PRELIMINARY', candidateSha: subject, sourceSha: sourceSha(), ...data }, null, 2));
}
export async function connect() {
  assert.equal(process.env.CI, 'true', 'This harness runs only in its disposable Actions job');
  assert.equal(process.env.GITHUB_HEAD_REF, 'codex/candidate-db3-preflight');
  const api = new URL(process.env.TEST_SUPABASE_URL);
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(api.origin, 'http://127.0.0.1:54321');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '54322');
  assert.equal(url.pathname, '/postgres');
  for (const name of ['TEST_SUPABASE_ANON_KEY', 'TEST_SUPABASE_SERVICE_ROLE_KEY']) {
    const claims = JSON.parse(Buffer.from(process.env[name].split('.')[1], 'base64url').toString());
    assert.equal(claims.ref, undefined, 'Hosted keys are forbidden');
  }
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  const unsafe = (await db.query("SELECT count(*)::int n FROM public.organizations WHERE slug NOT LIKE 't-%'")).rows[0].n;
  assert.equal(unsafe, 0, 'Refusing any non-synthetic company');
  return db;
}
export async function schema(db) {
  const results = {};
  const schemas = "('public','security_audit')";
  for (const [name, sql] of Object.entries({
    functions: `SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,p.proconfig,p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ${schemas} AND p.prokind='f' ORDER BY 1,2,3`,
    columns: `SELECT table_schema,table_name,column_name,ordinal_position,column_default,is_nullable,data_type,udt_schema,udt_name,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema IN ${schemas} ORDER BY table_schema,table_name,ordinal_position`,
    relations: `SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ${schemas} AND c.relkind IN ('r','v','m','S') ORDER BY 1,2`,
    indexes: `SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ${schemas} ORDER BY 1,2,3`,
    constraints: `SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ${schemas} ORDER BY 1,2,3`,
    triggers: `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ${schemas} AND NOT t.tgisinternal ORDER BY 1,2,3`,
    policies: `SELECT * FROM pg_policies WHERE schemaname IN ${schemas} ORDER BY schemaname,tablename,policyname`,
  })) results[name] = (await db.query(sql)).rows;
  return { sha256: sha256(JSON.stringify(results)), objects: Object.fromEntries(Object.entries(results).map(([k,v]) => [k,v.length])), catalogue: results };
}
export async function marker(db, phase) {
  return (await db.query(read('supabase/verify/release_preflight.sql'))).rows.find(r => r.check === phase.marker)?.value;
}
export async function verify(db, phase) {
  assert.equal(await marker(db, phase), 'applied');
  const rows = (await db.query(read(phase.verify))).rows;
  assert.ok(rows.length > 0, `${phase.number}: missing verification rows`);
  assert.deepEqual(rows.filter(r => (r.ok ?? r.passed) !== true), []);
  return rows.length;
}
export function applyFile(file) {
  return execFileSync('psql', [process.env.TEST_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-X', '--single-transaction', '-f', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
