#!/usr/bin/env node
// Read-only: every proposal has a preflight disposition; post-144 release files
// preserve the canonical SQL and are deliberately outside frozen baseline replay.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function checkReleasePlan(root) {
  const read = p => readFileSync(path.join(root, p), 'utf8');
  const problems = [];
  const plan = JSON.parse(read('supabase/release-plan.json'));
  const preflight = read('supabase/verify/release_preflight.sql');
  const proposals = readdirSync(path.join(root, 'supabase/proposals')).filter(f => f.endsWith('.sql')).map(f => `supabase/proposals/${f}`);
  const accounted = [...plan.phases, ...plan.other_proposals].map(p => p.source);
  for (const file of proposals) {
    if (!accounted.includes(file)) problems.push(`Proposal missing from release plan: ${file}`);
    if (!preflight.includes(`'${file}'`)) problems.push(`Proposal missing from release preflight: ${file}`);
  }
  for (const file of accounted) if (!proposals.includes(file)) problems.push(`Unknown proposal in release plan: ${file}`);
  if (new Set(accounted).size !== accounted.length) problems.push('Proposal appears more than once in release plan');
  const numbers = readdirSync(path.join(root, 'supabase/migrations')).filter(f => /^\d{3}_.*\.sql$/.test(f)).map(f => Number(f.slice(0,3)));
  if (Math.max(...numbers) !== plan.numbered_through) problems.push('Numbered baseline no longer matches release plan');
  const ids = [...numbers, ...plan.phases.map(p => p.number)];
  if (new Set(ids).size !== ids.length) problems.push('Release/migration number collision');
  // The numbered releases the JNR cutover applies, in order: each has a migration, release, rollback, verify file and preflight marker.
  const cutover = plan.jnr_cutover_numbered_order ?? [];
  let previous = 0;
  for (const entry of cutover) {
    if (entry.number <= previous || entry.number > plan.numbered_through) problems.push(`Wrong cutover order or number: ${entry.number}`);
    previous = entry.number;
    if (!preflight.includes(`'${entry.marker}'`)) problems.push(`Cutover marker missing: ${entry.marker}`);
    for (const field of ['migration','release','rollback','verify']) if (!existsSync(path.join(root,entry[field]))) problems.push(`Missing cutover ${field}: ${entry[field]}`);
    if (!numbers.includes(entry.number)) problems.push(`Cutover number has no migration: ${entry.number}`);
  }
  for (const required of [138, 140, 141, 143, 144]) if (!cutover.some(entry => entry.number === required)) problems.push(`Required JNR cutover release missing from the plan: ${required}`);
  let after = plan.numbered_through;
  for (const phase of plan.phases) {
    if (phase.number <= after || Number(phase.after) !== after) problems.push(`Wrong release order: ${phase.number} after ${phase.after}`);
    after = phase.number;
    if (!preflight.includes(`'${phase.marker}'`)) problems.push(`Release marker missing: ${phase.marker}`);
    for (const field of ['source','release','rollback','verify']) if (!existsSync(path.join(root,phase[field]))) problems.push(`Missing ${field}: ${phase[field]}`);
    if (existsSync(path.join(root,phase.release))) {
      const source = read(phase.source);
      const body = source.slice(source.indexOf('BEGIN;')+6,source.lastIndexOf('COMMIT;')).trim();
      const release = read(phase.release);
      if (!release.includes(body)) problems.push(`Canonical proposal changed without packaging update: ${phase.source}`);
      if (!release.includes('DO $post_release_guard$') || !release.trimEnd().endsWith('COMMIT;')) problems.push(`Missing transactional prerequisite guard: ${phase.release}`);
    }
  }
  return problems;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const problems = checkReleasePlan(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  problems.forEach(p => console.error(`FAIL ${p}`));
  if (problems.length) process.exitCode = 1;
  else console.log('release-plan: every proposal accounted for; 143 costing rates → 144 → 145 N5 → 146 N2/cap → 147 C17 → 148 job costing → 149 Xero switch → 150 AI cap/key-off → 151 Xero invite hardening → 152 SliQ import route, no number collisions');
}
