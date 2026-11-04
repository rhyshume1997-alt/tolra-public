import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
// No arbitrary commands, filters, environment dumps, SQL or browser execution.
if (process.argv.length !== 2) throw new Error('No arguments supported. Only manifest unit files run.');
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw new Error(`Cannot identify tested checkout: git ${args[0]}`);
  return result.stdout.trim();
};
const started = new Date().toISOString();
const commit = git('rev-parse', 'HEAD');
const stamp = started.replaceAll(':', '-');
mkdirSync(resolve(here, 'evidence'), { recursive: true });
const destination = mkdtempSync(resolve(here, 'evidence', `${stamp}-${commit.slice(0, 12)}-`));
const summary = {
  startedUtc: started, finishedUtc: null, commit,
  worktreeDirtyBeforeRun: Boolean(git('status', '--porcelain', '--untracked-files=normal')),
  node: process.version, npm: process.env.npm_config_user_agent?.split(' ')[0] ?? 'not recorded (run via npm)',
  base: null, status: 'FAILED', commands: [], inputsSha256: {}, tests: null,
  notRun: ['Full unit suite unless separately recorded', 'Database permissions and cap race', 'Browser and provider sandboxes', 'IQ/OQ/PQ manual checks', 'VSR approval and Rhys sign-off'],
};
const save = () => writeFileSync(resolve(destination, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const sha = content => createHash('sha256').update(content).digest('hex');
function command(label, args, allowFailure = false) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024, env: {...process.env, NO_COLOR: '1', FORCE_COLOR: '0'} });
  const log = [`Command: node ${args.map(a => a.startsWith(root + '/') ? a.slice(root.length + 1) : a).join(' ')}`, `Exit: ${result.status ?? 'not started'}`, result.stdout ?? '', result.stderr ?? '', result.error?.message ?? ''].join('\n');
  writeFileSync(resolve(destination, `${label}.log`), log);
  summary.commands.push({log: `${label}.log`, exit: result.status, signal: result.signal, sha256: sha(log)});
  save();
  if (result.error || (result.status !== 0 && !allowFailure)) throw new Error(`${label} failed; see dated evidence log.`);
  return result;
}
try {
  save();
  command('mapping', [resolve(here, 'check-pack.mjs')]);
  const manifest = JSON.parse(readFileSync(resolve(here, 'manifest.json'), 'utf8'));
  summary.base = manifest.base;
  const units = [...new Set(manifest.requirements.flatMap(row => row.unit))].sort();
  if (!units.length) throw new Error('No mapped unit files.');
  const inputs = [...units, 'package.json', 'package-lock.json', 'vitest.config.ts', 'tests/MANUAL-CHECKS-GO-LIVE.md', ...readdirSync(here).filter(name => /\.(md|mjs|json)$/.test(name)).map(name => `tests/validation/${name}`)];
  for (const file of inputs) summary.inputsSha256[file] = sha(readFileSync(resolve(root, file)));
  const report = resolve(destination, 'unit-results.json');
  const unitRun = command('mapped-unit', [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', ...units, '--maxWorkers=4', '--minWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], true);
  if (!existsSync(report)) throw new Error('Unit reporter did not produce results. See mapped-unit.log.');
  const results = JSON.parse(readFileSync(report, 'utf8'));
  rmSync(report);
  summary.tests = {files: units.length, total: results.numTotalTests, passed: results.numPassedTests, failed: results.numFailedTests, skipped: results.numPendingTests, todo: results.numTodoTests ?? 0};
  const assertions = (results.testResults ?? []).flatMap(file => file.assertionResults ?? []);
  const executedFiles = new Set((results.testResults ?? []).map(file => file.name));
  const incomplete = assertions.some(result => result.status !== 'passed');
  if (unitRun.status !== 0 || !results.success || summary.tests.total <= 0 || summary.tests.passed !== summary.tests.total || summary.tests.failed !== 0 || summary.tests.skipped !== 0 || summary.tests.todo !== 0 || incomplete || units.some(file => !executedFiles.has(resolve(root, file)))) throw new Error('Mapped unit evidence is incomplete, failed or skipped. This is not a pass.');
  // Keep aggregate counts and console logs; no raw individual fixture records.
  summary.status = 'MAPPED UNIT PASS ONLY';
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  summary.finishedUtc = new Date().toISOString();
  save();
  console.log(`Evidence: ${destination.slice(root.length + 1)}/summary.json`);
  console.log(summary.status);
}
