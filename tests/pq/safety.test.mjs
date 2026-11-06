// Guard tests use a fake CLI, never a substitute for the real-stack proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tolra-pq-guard-'));
  const local = path.join(root, 'tests/pq/.runtime');
  mkdirSync(path.join(local, 'supabase/.temp'), { recursive: true });
  copyFileSync(new URL('./pq.mjs', import.meta.url), path.join(root, 'tests/pq/pq.mjs'));
  writeFileSync(path.join(local, 'PQ-ONLY'), 'tolra-pq-synthetic');
  writeFileSync(path.join(local, 'supabase/config.toml'), 'project_id = "tolra-pq-synthetic"');
  const status = { API_URL: 'http://127.0.0.1:55321', DB_URL: 'postgresql://postgres:fake@127.0.0.1:55322/postgres', ANON_KEY: jwt({ role: 'anon' }), SERVICE_ROLE_KEY: jwt({ role: 'service_role' }) };
  const cli = path.join(root, 'cli');
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='status') console.log(fs.readFileSync('status.json','utf8'));
else if(process.argv[2]==='stop') fs.writeFileSync('stopped','yes');
else process.exit(42);
`, { mode: 0o700 });
  return { root, local, status, run() {
    writeFileSync(path.join(root, 'status.json'), JSON.stringify(status));
    return spawnSync(process.execPath, ['tests/pq/pq.mjs', 'stop'], { cwd: root, encoding: 'utf8', env: { ...process.env, SUPABASE_BIN: cli } });
  }, close() { rmSync(root, { recursive: true, force: true }); } };
}
for (const [name, change] of [
  ['hosted database', f => { f.status.DB_URL = 'postgresql://fake@hosted.invalid:55322/postgres'; }],
  ['another local database port', f => { f.status.DB_URL = 'postgresql://fake@127.0.0.1:54322/postgres'; }],
  ['hosted API', f => { f.status.API_URL = 'https://fake.supabase.co'; }],
  ['hosted key', f => { f.status.SERVICE_ROLE_KEY = jwt({ ref: 'hosted-fake' }); }],
  ['missing ownership marker', f => { rmSync(path.join(f.local, 'PQ-ONLY')); }],
  ['linked project', f => { writeFileSync(path.join(f.local, 'supabase/.temp/project-ref'), 'fake-project'); }],
  ['another project name', f => { writeFileSync(path.join(f.local, 'supabase/config.toml'), 'project_id = "other"'); }],
]) {
  test(`reset/stop guard refuses ${name} before deletion`, () => {
    const f = fixture();
    try { change(f); assert.notEqual(f.run().status, 0); assert.equal(existsSync(path.join(f.root, 'stopped')), false); assert.equal(existsSync(f.local), true); }
    finally { f.close(); }
  });
}
test('stop deletes only the owned project and preserves sibling files', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.root, 'keep'), 'other work');
    const r = f.run(); assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(path.join(f.root, 'stopped')), true);
    assert.equal(existsSync(f.local), false);
    assert.equal(existsSync(path.join(f.root, 'keep')), true);
  } finally { f.close(); }
});
