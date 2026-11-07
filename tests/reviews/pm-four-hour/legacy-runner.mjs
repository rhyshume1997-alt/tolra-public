// Reset only the already-guarded disposable Actions database to genuine pre099 definitions.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_HEAD_REF, 'codex/cbff-safety-verification');
const db = new URL(process.env.TEST_DATABASE_URL);
assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '54322');
assert.equal(new URL(process.env.TEST_SUPABASE_URL).origin, 'http://127.0.0.1:54321');
const work = mkdtempSync(join(tmpdir(), 'builder3-pre099-'));
try {
  cpSync('supabase', join(work, 'supabase'), { recursive: true });
  for (const file of readdirSync(join(work, 'supabase/migrations'))) {
    if (/^\d{3}_.*\.sql$/.test(file) && file.slice(0, 3) >= '099') rmSync(join(work, 'supabase/migrations', file));
  }
  execFileSync('supabase', ['db', 'reset', '--local', '--no-seed', '--workdir', work], { stdio: 'inherit' });
  execFileSync('bash', ['scripts/test-backend.sh', 'env'], { stdio: 'inherit' });
  execFileSync('npx', ['vitest', 'run', '-c', 'tests/reviews/pm-four-hour/legacy.config.ts', '--reporter=verbose', '--reporter=json', '--outputFile.json=evidence/legacy099.json'], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
  execFileSync('bash', ['scripts/test-backend.sh', 'reset'], { stdio: 'inherit' });
}
