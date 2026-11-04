#!/usr/bin/env node
/** Migration 148 only; synthetic prerequisites. Creates its own network-isolated disposable PostgreSQL.
 * Accepts NO database URL or credentials. Full Supabase/Auth regression is a separate release gate.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const nonce = randomUUID();
const name = `tolra-costing-${nonce}`;
const database = `synthetic_${nonce.replaceAll('-', '')}`;
const image = 'postgres@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1';
const logs = resolve(process.env.TMPDIR || '/tmp', name);
mkdirSync(logs);
const commit = spawnSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const records = [];
let id;
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}
function checked(args, input) {
  const r = docker(args,input);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}
function identity() {
  const c = JSON.parse(checked(['inspect',name]))[0];
  if (c.Id !== id || c.Config.Labels?.['tolra.disposable'] !== nonce || c.HostConfig.NetworkMode !== 'none'
    || !c.HostConfig.Tmpfs?.['/var/lib/postgresql/data'] || c.Config.Image !== image
    || !c.Config.Env.includes(`POSTGRES_DB=${database}`)) throw new Error('Disposable identity mismatch; no SQL permitted');
  const found = checked(['exec',name,'psql','-X','-At','-U','postgres','-d',database,'-c','SELECT current_database(), current_user']);
  if (found !== `${database}|postgres`) throw new Error('Database identity mismatch; no write permitted');
}
function sql(label, content) {
  identity();
  const start = new Date().toISOString();
  const r = docker(['exec','-i',name,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],content);
  const log = `${r.stdout}\n${r.stderr}`;
  writeFileSync(resolve(logs,`${records.length}-${label}.log`),log);
  records.push({ label, commit, environment: { container: id, database, network: 'none', synthetic: true }, sql_sha256: createHash('sha256').update(content).digest('hex'), time: start, exit_code: r.status, log_sha256: createHash('sha256').update(log).digest('hex') });
  writeFileSync(resolve(logs,'results.json'),JSON.stringify(records,null,2));
  if (r.status !== 0) throw new Error(`${label} failed; original log retained at ${logs}`);
  return r.stdout.trim();
}
const file = p => readFileSync(resolve(root,p),'utf8');
try {
  id = checked(['run','-d','--pull=never','--name',name,'--network','none','--label',`tolra.disposable=${nonce}`,'--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e',`POSTGRES_DB=${database}`,image]);
  let ready = false;
  for (let attempt=0;attempt<40;attempt++) {
    if (docker(['exec',name,'pg_isready','-U','postgres','-d',database]).status === 0) { ready=true; break; }
    await new Promise(resolve => setTimeout(resolve,500));
  }
  if (!ready) throw new Error('Disposable database did not become ready');
  sql('synthetic-setup',file('tests/fixtures/job-costing/setup.sql'));
  const snapshot = "SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) FROM (SELECT to_jsonb(x) t FROM invoices x UNION ALL SELECT to_jsonb(x) FROM credit_notes x UNION ALL SELECT to_jsonb(x) FROM purchase_orders x UNION ALL SELECT to_jsonb(x) FROM operator_sessions x UNION ALL SELECT to_jsonb(x) FROM machine_runs x UNION ALL SELECT to_jsonb(x) FROM job_machines x UNION ALL SELECT to_jsonb(x) FROM quote_line_items x) all_rows;";
  const before = sql('legacy-before',snapshot);
  const migration = file('supabase/migrations/148_job_profitability_actuals.sql');
  if (migration !== file('supabase/release/148_job_profitability_actuals.release.sql')) throw new Error('Release differs from migration');
  sql('migration',migration);
  sql('security-and-inputs',file('tests/fixtures/job-costing/checks.sql'));
  const verify = sql('verify',file('supabase/verify/job_profitability_actuals_148.sql'));
  if (verify.split('\n').length !== 6 || verify.split('\n').some(line => !line.endsWith('|t'))) throw new Error('Verification failed');
  if (sql('legacy-after',snapshot) !== before) throw new Error('Legacy rows changed');
  sql('rollback',file('supabase/release/148_job_profitability_actuals.rollback.sql'));
  if (sql('rollback-objects',"SELECT to_regclass('public.job_costing_settings') IS NULL AND to_regclass('public.job_machine_cost_rates') IS NULL AND to_regclass('public.job_cost_estimates') IS NULL AND to_regclass('public.job_costing_rate_history') IS NULL;") !== 't') throw new Error('Rollback left costing tables');
  if (sql('legacy-after-rollback',snapshot) !== before) throw new Error('Rollback changed legacy data');
  sql('release-after-rollback',migration);
  console.log(`Migration, security, inputs, legacy preservation, rollback and re-release passed. Logs: ${logs}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (id) checked(['rm','-fv',name]); }
