// Run manually after review. Never reads DATABASE_URL or connects to an existing server.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const name = `tolra-atomic-${randomBytes(8).toString('hex')}`;
const database = `tolra_atomic_${randomBytes(8).toString('hex')}`;
const password = randomBytes(24).toString('hex');
function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`Docker failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout.trim();
}
let started = false;
try {
  docker(['run', '--detach', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${database}`, '-p', '127.0.0.1::5432', 'postgres:17']);
  started = true;
  const deadline = Date.now() + 30_000;
  while (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', database], { stdio: 'ignore' }).status !== 0) {
    if (Date.now() >= deadline) throw new Error('Throwaway Postgres did not become ready.');
    await delay(150);
  }
  const binding = docker(['port', name, '5432/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Unexpected Docker port binding.');
  const r = spawnSync(process.execPath, ['--test', 'tests/postgres/atomic-settings.test.mjs'], {
    cwd: root, stdio: 'inherit', timeout: 120_000, env: { ...process.env,
      TOLRA_ATOMIC_TEST_URL: `postgresql://postgres:${password}@${binding}/${database}`,
      TOLRA_ATOMIC_TEST_DB: database },
  });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
} finally {
  if (started) docker(['rm', '--force', name]);
}
