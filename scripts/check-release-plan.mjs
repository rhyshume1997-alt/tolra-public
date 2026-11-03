#!/usr/bin/env node
// Read-only: every proposal has a preflight disposition; post-144 release files
// preserve the canonical SQL and are deliberately outside frozen baseline replay.
import { createHash } from 'node:crypto';
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
  let after = plan.numbered_through;
  for (const phase of plan.phases) {
    if (phase.number <= after || Number(phase.after) !== after) problems.push(`Wrong release order: ${phase.number} after ${phase.after}`);
    after = phase.number;
    if (!preflight.includes(`'${phase.marker}'`)) problems.push(`Release marker missing: ${phase.marker}`);
    for (const field of ['source','release','rollback','verify']) if (!existsSync(path.join(root,phase[field]))) problems.push(`Missing ${field}: ${phase[field]}`);
    if (phase.checksums) {
      if (!existsSync(path.join(root,phase.checksums))) problems.push(`Missing checksums: ${phase.checksums}`);
      else {
        const hashes=JSON.parse(read(phase.checksums));
        for (const file of [phase.source,phase.release,phase.rollback,phase.verify,'supabase/verify/chase_steps_138.sql','supabase/verify/release_preflight.sql','supabase/release-plan.json']) {
          if (!existsSync(path.join(root,file)) || hashes.sha256?.[file] !== createHash('sha256').update(read(file)).digest('hex')) problems.push(`Release checksum mismatch: ${file}`);
        }
      }
    }
    if (existsSync(path.join(root,phase.release))) {
      const source = read(phase.source);
      // The existing browser fixture owns its transaction. Keep that canonical
      // proposal unwrapped; production packaging makes only its DDL one-time
      // and explicitly removes the service-role API grant. Function body is pinned.
      const body = phase.source === 'supabase/proposals/builder2_chase_settings_atomic.sql'
        ? source.trim().replace('CREATE OR REPLACE FUNCTION public.save_chase_steps_atomic','CREATE FUNCTION public.save_chase_steps_atomic').replace('FROM PUBLIC,anon;','FROM PUBLIC,anon,service_role;')
        : source.slice(source.indexOf('BEGIN;')+6,source.lastIndexOf('COMMIT;')).trim();
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
  else console.log('release-plan: every proposal accounted for; 144 → 145 N5 → 146 N2/cap → 147 chase settings, no costing, no number collisions');
}
