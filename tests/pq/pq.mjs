#!/usr/bin/env node
// Only owns tests/pq/.runtime and the tolra-pq-synthetic Docker project.
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
const local = path.join(root, 'tests/pq/.runtime');
const cli = process.env.SUPABASE_BIN || 'supabase';
const project = 'tolra-pq-synthetic';
const marker = path.join(local, 'PQ-ONLY');
const action = process.argv[2] || 'start';
// Never inherit provider credentials or a hosted Supabase configuration.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME|USER|TMPDIR|TEMP|TMP|CI|LANG|LC_.*|SYSTEMROOT|DOCKER_CONFIG|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/.test(k)));
env.SUPABASE_INTERNAL_IMAGE_REGISTRY = 'ghcr.io';
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
  return r.stdout?.toString() || '';
}
function owned() {
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== project) throw new Error('Not our disposable PQ project');
  const config = readFileSync(path.join(local, 'supabase/config.toml'), 'utf8');
  if (!config.includes(`project_id = "${project}"`)) throw new Error('Unexpected Supabase project');
  if (existsSync(path.join(local, 'supabase/.temp/project-ref'))) throw new Error('Linked projects are forbidden');
}
function status() {
  owned();
  const s = JSON.parse(run(cli, ['status', '--workdir', local, '-o', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] }));
  if (s.API_URL !== 'http://127.0.0.1:55321') throw new Error('PQ API is not the owned loopback endpoint');
  const db = new URL(s.DB_URL);
  if (db.hostname !== '127.0.0.1' || db.port !== '55322' || db.pathname !== '/postgres') throw new Error('Unexpected PQ database');
  for (const key of [s.ANON_KEY, s.SERVICE_ROLE_KEY]) {
    if (!key || JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).ref) throw new Error('Hosted/missing key refused');
  }
  return { TEST_SUPABASE_URL: s.API_URL, TEST_SUPABASE_ANON_KEY: s.ANON_KEY, TEST_SUPABASE_SERVICE_ROLE_KEY: s.SERVICE_ROLE_KEY, TEST_DATABASE_URL: s.DB_URL };
}
if (!['start', 'prepare', 'serve', 'reset', 'stop', 'code'].includes(action)) throw new Error('Use start|prepare|serve|reset|stop|code');
if (action === 'code') {
  // Only synthetic, locally enrolled MFA; never writes a token to source control.
  const { createHmac } = await import('node:crypto');
  const secret = JSON.parse(readFileSync(path.join(local, 'accounts.json'), 'utf8')).totpSecret;
  const bits = [...secret].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const count = Buffer.alloc(8); count.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(count).digest(); const o = h[19] & 15;
  console.log(String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0'));
  process.exit(0);
}
if (action === 'stop' || action === 'reset') {
  owned();
  // Assert the live endpoint before any destructive action.
  status();
  run(cli, ['stop', '--workdir', local, '--no-backup']);
  rmSync(local, { recursive: true });
  if (action === 'stop') process.exit(0);
}
if (action !== 'serve') {
  if (run(cli, ['--version'], { stdio: ['ignore', 'pipe', 'inherit'] }).trim() !== '2.40.7') throw new Error('Supabase CLI 2.40.7 is required');
  if (!existsSync(marker)) {
    mkdirSync(path.join(local, 'supabase'), { recursive: true, mode: 0o700 });
    writeFileSync(marker, project, { mode: 0o600 });
    const config = readFileSync('supabase/config.toml', 'utf8').replace('tolra-local-test', project).replaceAll('5432', '5532').replaceAll(':3001', ':3007');
    writeFileSync(path.join(local, 'supabase/config.toml'), config);
    cpSync('supabase/migrations', path.join(local, 'supabase/migrations'), { recursive: true });
  }
  owned();
  run(cli, ['start', '--workdir', local, '-x', 'studio,realtime,edge-runtime,logflare,vector,imgproxy,supavisor,postgres-meta']);
  Object.assign(env, status());
  if (!existsSync(path.join(local, 'accounts.json'))) run('npx', ['vitest', 'run', '-c', 'tests/pq/vitest.config.ts']);
}
if (action === 'prepare' || action === 'reset') process.exit(0);
Object.assign(env, status());
Object.assign(env, {
  NEXT_PUBLIC_SUPABASE_URL: env.TEST_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: env.TEST_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: env.TEST_SUPABASE_SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3007', NEXT_TELEMETRY_DISABLED: '1',
  AI_HELPER_ENABLED: 'false', REQUIRE_ADMIN_MFA: 'true',
  NODE_OPTIONS: '--require ./tests/support/no-network.cjs',
  E2E_BLOCKED_LOG: path.join(local, 'blocked-network.log'),
});
// Next loads root .env files itself; refuse rather than accidentally inherit provider keys.
for (const f of ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local']) {
  if (existsSync(f)) throw new Error(`Remove/rename ${f} in this dedicated checkout before starting PQ`);
}
console.log('SYNTHETIC PQ ONLY: http://localhost:3007 — accounts: tests/pq/.runtime/accounts.json');
const child = spawn('npx', ['next', 'dev', '--hostname', '127.0.0.1', '--port', '3007'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
