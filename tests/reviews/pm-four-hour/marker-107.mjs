// Real PostgreSQL, exact candidate preflight; mutations confined to this job's disposable DB.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
const candidate = 'cbff130342145884fca10d2fb227f4888ac53ea3';
assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_HEAD_REF, 'codex/cbff-safety-verification');
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '54322'); assert.equal(url.pathname, '/postgres');
assert.equal(new URL(process.env.TEST_SUPABASE_URL).origin, 'http://127.0.0.1:54321');
const db = new pg.Client({ connectionString: url.toString() }); await db.connect();
const read = p => readFileSync(p, 'utf8');
const report = { status: 'PRELIMINARY', candidate, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), rows: [] };
const preflight = read('supabase/verify/release_preflight.sql');
async function values() {
  const rows = (await db.query(preflight)).rows;
  const pick = check => { const matches = rows.filter(r => r.check === check); assert.equal(matches.length, 1); return matches[0].value; };
  return { marker107: pick('marker 107 integrations connect'), marker151: pick('post-144 marker 151 xero_invite_hardening') };
}
async function check(name, expected, mutate) {
  await db.query('BEGIN');
  let actual;
  try {
    if (mutate) await mutate();
    actual = await values();
    assert.deepEqual(actual, expected);
    report.rows.push({ name, status: 'PASS', expected, actual });
  } catch (e) {
    report.rows.push({ name, status: 'FAIL', expected, actual, sqlstate: e.code?.startsWith?.('ERR_') ? null : e.code ?? null, error: e.message });
  } finally { await db.query('ROLLBACK'); }
}
try {
  assert.equal((await db.query('SELECT count(*)::int n FROM public.organizations')).rows[0].n, 0, 'Fresh synthetic-only database required');
  await check('107 original function family only', { marker107: 'applied', marker151: 'not applied' });
  const phases = JSON.parse(read('supabase/release-plan.json')).phases.filter(p => p.number >= 145 && p.number <= 151);
  for (const phase of phases) {
    execFileSync('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-X', '--single-transaction', '-f', phase.release], { stdio: 'pipe' });
    const rows = (await db.query(read(phase.verify))).rows;
    assert.ok(rows.length > 0); assert.deepEqual(rows.filter(r => (r.ok ?? r.passed) !== true), []);
  }
  await check('151 complete family supersedes original 107', { marker107: 'applied', marker151: 'applied' });
  const legacy = read('supabase/migrations/107_integrations_connect.sql');
  const definition = name => { const start = legacy.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); assert.ok(start >= 0); const end = legacy.indexOf('$$;', start); assert.ok(end > start); return legacy.slice(start, end + 3); };
  await check('mixed old token and new recipient-bound families are refused', { marker107: 'not applied', marker151: 'not applied' }, async () => {
    await db.query(definition('integration_invite_create'));
    await db.query(definition('integration_invite_redeem'));
    assert.equal((await db.query("SELECT to_regprocedure('public.integration_invite_create(text,text)') IS NOT NULL AND to_regprocedure('public.integration_invite_create(text,text,text)') IS NOT NULL AS both")).rows[0].both, true);
  });
  await check('partial 151 without recipient verification is refused', { marker107: 'not applied', marker151: 'not applied' }, async () => {
    await db.query('DROP FUNCTION public.integration_invite_code_verify(text,text,text,text)');
  });
} catch (e) { report.setupFailure = { error: e.message, sqlstate: e.code ?? null, stderr: e.stderr?.toString() }; }
finally {
  await db.end(); mkdirSync('evidence/builder3', { recursive: true });
  writeFileSync('evidence/builder3/marker-107.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.setupFailure || report.rows.length !== 4 || report.rows.some(r => r.status !== 'PASS')) process.exitCode = 1;
}
