import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, original, save, sha256, subject } from './common.mjs';

const variant = process.argv[2];
assert.ok(['original', 'corrected'].includes(variant));
const db = await connect();
assert.equal((await db.query('SELECT count(*)::int n FROM public.organizations')).rows[0].n, 0, '147 must first install on an empty database');
await db.end();
const temporary = 'tests/db/builder3-original-147.test.ts';
assert.equal(existsSync(temporary), false);
const originalText = execFileSync('git', ['show', `${original}:tests/db/job-delivery-note-147.test.ts`], { encoding: 'utf8' });
const candidateText = execFileSync('git', ['show', `${subject}:tests/db/job-delivery-note-147.test.ts`], { encoding: 'utf8' });
const file = variant === 'original' ? temporary : 'tests/db/job-delivery-note-147.test.ts';
try {
  if (variant === 'original') writeFileSync(temporary, originalText);
  const output = `evidence/builder3/147-${variant}-vitest.json`;
  save(`147-${variant}`, { execution: 'STARTED', originalFileSha256: sha256(originalText), correctedFileSha256: sha256(candidateText) });
  const child = spawnSync('npx', ['vitest', 'run', '-c', 'vitest.db.config.ts', file, '--reporter=verbose', '--reporter=json', `--outputFile.json=${output}`], { stdio: 'inherit' });
  const result = JSON.parse(readFileSync(output, 'utf8'));
  const failed = result.testResults.flatMap(s => s.assertionResults).filter(t => t.status === 'failed');
  const totals = { passed: result.numPassedTests, failed: result.numFailedTests, skipped: result.numPendingTests, total: result.numTotalTests };
  save(`147-${variant}`, { exit: child.status, totals, failures: failed.map(f => ({ name: f.fullName, details: f.failureMessages })), originalFileSha256: sha256(originalText), correctedFileSha256: sha256(candidateText) });
  console.log({ variant, ...totals });
  if (variant === 'original') {
    assert.notEqual(child.status, 0);
    assert.deepEqual(totals, { passed: 2, failed: 1, skipped: 0, total: 3 });
    assert.match(failed[0].fullName, /a double submit from two connections makes one note; rollback keeps every note; the release applies again/);
    assert.match(failed[0].failureMessages.join('\n'), /expected 0 to be greater than 0/);
  } else {
    assert.equal(child.status, 0);
    assert.deepEqual(totals, { passed: 3, failed: 0, skipped: 0, total: 3 });
  }
} finally { if (variant === 'original') rmSync(temporary, { force: true }); }
