import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = (name) => readFileSync(resolve(here, name), 'utf8');
const { requirements } = JSON.parse(read('manifest.json'));
const fail = (message) => { throw new Error(message); };
if (process.argv.slice(2).some((arg) => arg !== '--run-unit')) fail('Only --run-unit is supported. No database or deploy command is provided.');
const seen = new Set();
for (const row of requirements) {
  for (const key of ['id', 'risk', 'oq']) {
    if (seen.has(row[key])) fail(`Duplicate ID ${row[key]}`);
    seen.add(row[key]);
  }
  for (const [file, id] of [['URS.md', row.id], ['RISK-ASSESSMENT.md', row.risk], ['OQ.md', row.oq]]) {
    if (!read(file).includes(`| ${id} |`)) fail(`Missing ${id} in ${file}`);
  }
  const trace = read('TRACEABILITY.md').split('\n').find((line) => line.startsWith(`| ${row.id} |`));
  if (!trace?.includes(row.risk) || !trace.includes(row.oq)) fail(`Broken trace for ${row.id}`);
  for (const path of [row.unit, row.browser].filter(Boolean)) {
    if (!/^tests\/(unit|e2e)\/[a-z0-9-]+\.(test|spec)\.ts$/.test(path) || !existsSync(resolve(root, path))) fail(`Missing or unsafe test path: ${path}`);
    if (!read('OQ.md').includes(`\`${path}\``)) fail(`OQ omits ${path}`);
  }
}
for (const [file, prefix, count] of [['IQ.md', 'IQ', 6], ['OQ.md', 'OQ', 10], ['PQ.md', 'PQ', 5]]) {
  const text = read(file);
  if (!text.includes('Expected result') || !text.includes('Pass / Fail / Not run') || !/evidence/i.test(text)) fail(`Missing protocol columns in ${file}`);
  for (let i = 1; i <= count; i++) if (!text.includes(`| ${prefix}-${String(i).padStart(3, '0')} |`)) fail(`Missing step ${prefix}-${i}`);
}
for (const match of read('README.md').matchAll(/\]\(([^)]+\.md)\)/g)) if (!existsSync(resolve(here, match[1]))) fail(`Broken document link ${match[1]}`);
console.log(`Pack structure passed: ${requirements.length} requirements; IQ 6, OQ 10, PQ 5. Protocol execution evidence remains blank.`);
if (process.argv.includes('--run-unit')) {
  const files = [...new Set(requirements.map((row) => row.unit))];
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', 'vitest', 'run', ...files], { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
