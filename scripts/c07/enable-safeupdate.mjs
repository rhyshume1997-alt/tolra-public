import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
const env = Object.fromEntries(readFileSync('.env.test.local', 'utf8').split('\n').filter((s) => /^TEST_[A-Z_]+=/.test(s)).map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const url = new URL(env.TEST_DATABASE_URL);
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/postgres', 'Fresh local postgres only');
// The shell runner refuses an existing stack and owns this newly created database.
const db = new pg.Client({ connectionString: url.href });
await db.connect();
try {
  // Supabase's postgres role is intentionally not a superuser: plain LOAD is denied (42501).
  // Configure only this fresh role/database through its existing local bootstrap administrator.
  const current = (await db.query("show session_preload_libraries")).rows[0].session_preload_libraries;
  const libraries = [...new Set([...current.split(',').map((x) => x.trim()).filter(Boolean), 'safeupdate'])].join(',');
  assert(/^[A-Za-z0-9_$,./-]+$/.test(libraries), 'Unexpected library configuration');
  execFileSync('docker', ['exec', 'supabase_db_tolra-local-test', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-c', `ALTER ROLE postgres IN DATABASE postgres SET session_preload_libraries = '${libraries}'`], { stdio: 'inherit' });
} finally { await db.end(); }
const fresh = new pg.Client({ connectionString: url.href });
await fresh.connect();
try {
  assert.equal((await fresh.query("select current_setting('safeupdate.enabled') as enabled")).rows[0].enabled, 'on');
  await fresh.query('create temporary table c07_probe (n integer)');
  for (const [sql, message] of [['update c07_probe set n = 1', 'UPDATE requires a WHERE clause'], ['delete from c07_probe', 'DELETE requires a WHERE clause']]) {
    await assert.rejects(fresh.query(sql), (e) => e.message === message);
  }
  await fresh.query('update c07_probe set n = 1 where true');
  console.log('C07: genuine safeupdate fresh-session library preload + UPDATE/DELETE refusal + qualified control passed.');
} finally { await fresh.end(); }
