import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
const env = Object.fromEntries(readFileSync('.env.test.local', 'utf8').split('\n').filter((s) => /^TEST_[A-Z_]+=/.test(s)).map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const url = new URL(env.TEST_DATABASE_URL);
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/postgres', 'Fresh local postgres only');
// The shell runner refuses an existing stack and owns this newly created database.
const db = new pg.Client({ connectionString: url.href });
await db.connect();
try {
  await db.query("LOAD 'safeupdate'"); // actual shared library; fail loudly if absent/unloadable
  assert.equal((await db.query("select current_setting('safeupdate.enabled') as enabled")).rows[0].enabled, 'on');
  await db.query("alter database postgres set session_preload_libraries = 'safeupdate'");
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
  console.log('C07: genuine safeupdate LOAD + fresh-session preload + UPDATE/DELETE refusal + qualified control passed.');
} finally { await fresh.end(); }
