import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = (name) => readFileSync(resolve(here, name), 'utf8');
const fail = (message) => { throw new Error(message); };
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--run-unit') || args.length > 1) fail('Only --run-unit is supported. No database or deploy command is provided.');
const manifest = JSON.parse(read('manifest.json'));
if (manifest.schemaVersion !== 2 || !manifest.requirements?.length) fail('Expected a version 2 requirement manifest.');
const { requirements, iq, pq } = manifest;
const manual = readFileSync(resolve(root, 'tests/MANUAL-CHECKS-GO-LIVE.md'), 'utf8');
const seen = new Set();
const rowFor = (file, id) => read(file).split('\n').filter(line => line.startsWith(`| ${id} |`));
function requireRow(file, id) {
  const rows = rowFor(file, id);
  if (rows.length !== 1) fail(`Expected exactly one ${id} in ${file}`);
  return rows[0];
}
function manualRefs(refs, id) {
  if (!Array.isArray(refs) || !refs.length) fail(`No manual check for ${id}`);
  for (const ref of refs) {
    if (!/^G\d{2}\.\d+$/.test(ref) || manual.split('\n').filter(line => line.startsWith(`| ${ref} `)).length !== 1) fail(`Missing or duplicate manual step ${ref} for ${id}`);
  }
}
for (const row of requirements) {
  for (const [key, prefix] of [['id', 'URS'], ['risk', 'RISK'], ['oq', 'OQ']]) {
    if (!new RegExp(`^${prefix}-\\d{3}$`).test(row[key]) || seen.has(row[key])) fail(`Invalid or duplicate ID ${row[key]}`);
    seen.add(row[key]);
  }
  if (!requireRow('URS.md', row.id).includes(row.requirement)) fail(`Stale requirement ${row.id}`);
  const riskRow = requireRow('RISK-ASSESSMENT.md', row.risk);
  for (const token of [row.id, row.oq, row.hazard, row.severity, ...row.manual]) if (!riskRow.includes(token)) fail(`Broken risk ${row.risk}: ${token}`);
  const oqRow = requireRow('OQ.md', row.oq);
  const trace = requireRow('TRACEABILITY.md', row.id);
  for (const token of [row.risk, row.oq, ...row.pq, ...row.manual]) if (!trace.includes(token)) fail(`Broken trace ${row.id}: ${token}`);
  if (!row.pq.length || row.pq.some(id => !pq.some(step => step.id === id))) fail(`Missing PQ for ${row.id}`);
  manualRefs(row.manual, row.id);
  for (const ref of row.manual) if (!oqRow.includes(ref)) fail(`OQ omits ${ref}`);
  for (const [kind, directory, extension] of [['unit', 'unit', 'test'], ['database', 'db', 'test'], ['browser', 'e2e', 'spec']]) {
    if (!Array.isArray(row[kind])) fail(`Expected ${kind} paths for ${row.id}`);
    for (const path of row[kind]) {
      if (!new RegExp(`^tests/${directory}/[a-z0-9-]+\\.${extension}\\.ts$`).test(path) || !existsSync(resolve(root, path))) fail(`Missing or unsafe ${kind} path: ${path}`);
      if (!oqRow.includes(`\`${path}\``)) fail(`OQ omits ${path}`);
    }
  }
  if (!row.unit.length && !row.database.length && !row.browser.length && !row.manual.length) fail(`Unmapped ${row.id}`);
  if (row.gap && !requireRow('COVERAGE-GAPS.md', row.id).includes(row.gap)) fail(`Unreported gap ${row.id}`);
}
for (const [file, prefix, expected] of [['URS.md', 'URS', requirements.map(r => r.id)], ['RISK-ASSESSMENT.md', 'RISK', requirements.map(r => r.risk)], ['OQ.md', 'OQ', requirements.map(r => r.oq)]]) {
  const actual = [...read(file).matchAll(new RegExp(`^\\| (${prefix}-\\d{3}) \\|`, 'gm'))].map(m => m[1]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`Unmapped or reordered rows in ${file}`);
}
for (const [file, prefix, steps] of [['IQ.md', 'IQ', iq], ['PQ.md', 'PQ', pq]]) {
  const document = read(file);
  if (!document.includes('Expected result') || !document.includes('Pass / Fail / Not run') || !/evidence/i.test(document)) fail(`Missing protocol columns in ${file}`);
  for (const step of steps) {
    if (seen.has(step.id) || !new RegExp(`^${prefix}-\\d{3}$`).test(step.id)) fail(`Invalid or duplicate protocol ${step.id}`);
    seen.add(step.id);
    requireRow(file, step.id);
    manualRefs(step.manual, step.id);
    const trace = requireRow('TRACEABILITY.md', step.id);
    for (const ref of step.manual) if (!trace.includes(ref) || !document.includes(ref)) fail(`Unmapped ${step.id}: ${ref}`);
  }
  const ids = [...document.matchAll(new RegExp(`^\\| (${prefix}-\\d{3}) \\|`, 'gm'))].map(m => m[1]);
  if (JSON.stringify(ids) !== JSON.stringify(steps.map(s => s.id))) fail(`Unmapped protocol row in ${file}`);
}
const vsr = read('VSR-TEMPLATE.md');
for (const [protocol, count] of [['IQ', iq.length], ['OQ', requirements.length], ['PQ', pq.length]]) {
  if (!vsr.includes(`| ${protocol} | ${count} | ____ | ____ | ____ | ____ |`)) fail(`Stale or prefilled VSR count ${protocol}`);
}
if (!vsr.includes('Rhys, validation lead, name / signature / date: ____')) fail('Rhys sign-off must remain blank.');
for (const file of ['README.md', 'VSR-TEMPLATE.md']) {
  for (const match of read(file).matchAll(/\]\(([^)]+\.md)\)/g)) {
    if (!/^(\.\.\/)?[A-Za-z0-9-]+\.md$/.test(match[1]) || !existsSync(resolve(here, match[1]))) fail(`Broken or unsafe document link ${match[1]}`);
  }
}
console.log(`Pack structure passed: ${requirements.length} requirements; IQ ${iq.length}, OQ ${requirements.length}, PQ ${pq.length}. No wholly unmapped URS rows. Read COVERAGE-GAPS.md for subcondition gaps. Runtime protocols remain NOT TESTED unless scoped actual evidence is recorded; VSR sign-off stays blank.`);
if (args.includes('--run-unit')) {
  const result = spawnSync(process.execPath, [resolve(here, 'run-evidence.mjs')], { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
