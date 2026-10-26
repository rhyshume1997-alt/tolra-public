#!/usr/bin/env node
/**
 * Applied-migration freeze and new-migration file set (Tolra pre-go-live guardrails c and d).
 *
 *   node scripts/check-migrations.mjs [repoRoot]
 *
 * (c) Every file listed in supabase/applied-migrations.json (migration, release, verify, rollback) must exist at its
 *     path with the recorded sha256. An applied migration is never edited, renamed or removed: write a new one.
 *     Documented exception: the manifest's top-level "exceptions" object maps a file path to { sha256, commit, reason,
 *     production_note }. That exact path also passes with that exact repository sha256 (the applied sha256 stays
 *     recorded as what production ran). Anything else still fails; an exception missing a field fails the check.
 *     Used only for 080 (guard-only edit, commit a7198394); production was not repasted.
 * (d) Every migration file NOT in the manifest (a new one, above the highest applied) must ship, as 081 to 083 do:
 *       supabase/release/NNN_slug.release.sql, supabase/release/NNN_slug.rollback.sql, a verify script
 *       supabase/verify/<name>_NNN.sql, and a marker ('NNN ...') in supabase/verify/release_preflight.sql.
 *     The catalogue snapshot is not checked here (test:db covers it).
 * Exits 1 and prints every problem. Read only.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const list = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

/** Returns { problems: string[], applied: number, added: string[] } for the tree at `root`. */
export function checkMigrations(root) {
  const problems = [];
  const manifestPath = path.join(root, "supabase/applied-migrations.json");
  if (!existsSync(manifestPath)) return { problems: ["supabase/applied-migrations.json is missing"], applied: 0, added: [] };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")).migrations;
  } catch (e) {
    return { problems: [`supabase/applied-migrations.json is not valid JSON: ${e.message}`], applied: 0, added: [] };
  }
  if (!manifest || typeof manifest !== "object") return { problems: ["supabase/applied-migrations.json has no \"migrations\" object"], applied: 0, added: [] };

  let exceptions = {};
  try {
    exceptions = JSON.parse(readFileSync(manifestPath, "utf8")).exceptions ?? {};
  } catch {
    /* already reported above */
  }
  if (!exceptions || typeof exceptions !== "object" || Array.isArray(exceptions)) {
    problems.push('supabase/applied-migrations.json "exceptions" must be an object keyed by file path');
    exceptions = {};
  }
  const valid = {};
  for (const [p, x] of Object.entries(exceptions)) {
    const missing = ["sha256", "commit", "reason", "production_note"].filter((k) => typeof x?.[k] !== "string" || !x[k].trim());
    if (missing.length) problems.push(`Exception for ${p} is malformed: missing ${missing.join(", ")}`);
    else valid[p] = x.sha256;
  }

  // (c) every listed file exists and is byte for byte what was applied.
  for (const [num, files] of Object.entries(manifest)) {
    for (const [kind, f] of Object.entries(files)) {
      const file = path.join(root, f.path);
      if (!existsSync(file)) {
        problems.push(`Applied migration ${num} ${kind} file is missing or renamed: ${f.path}: write a new migration instead`);
      } else if (sha256(file) !== f.sha256 && sha256(file) !== valid[f.path]) {
        problems.push(`Applied migration ${num} changed: write a new migration instead (${kind} file ${f.path})`);
      }
    }
  }

  // An applied number is never reused by another file; a file not in the manifest is a new migration.
  const migrations = list(path.join(root, "supabase/migrations")).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const added = [];
  for (const f of migrations) {
    const num = f.slice(0, 3);
    const listed = manifest[num]?.migration?.path;
    if (listed === `supabase/migrations/${f}`) continue;
    if (listed) problems.push(`Applied migration ${num} number reused by supabase/migrations/${f}: write a new migration instead`);
    else added.push(f);
  }

  // (d) a new migration ships its release, rollback and verify files and a preflight marker.
  const verifyFiles = list(path.join(root, "supabase/verify"));
  const preflightPath = path.join(root, "supabase/verify/release_preflight.sql");
  const preflight = existsSync(preflightPath) ? readFileSync(preflightPath, "utf8") : null;
  for (const f of added) {
    const num = f.slice(0, 3);
    const slug = f.replace(/\.sql$/, "");
    const missing = [];
    for (const kind of ["release", "rollback"]) {
      const rel = `supabase/release/${slug}.${kind}.sql`;
      if (!existsSync(path.join(root, rel))) missing.push(`${kind} file ${rel}`);
    }
    if (!verifyFiles.some((v) => v.endsWith(`_${num}.sql`))) missing.push(`verify file supabase/verify/<name>_${num}.sql`);
    if (preflight === null) missing.push("supabase/verify/release_preflight.sql itself");
    else if (!new RegExp(`\\('${num} `).test(preflight)) missing.push(`preflight marker ('${num} ...') in supabase/verify/release_preflight.sql`);
    if (missing.length) problems.push(`New migration ${num} (${f}) is missing: ${missing.join("; ")}`);
  }
  return { problems, applied: Object.keys(manifest).length, added };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const { problems, applied, added } = checkMigrations(root);
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`check-migrations: ${applied} applied migrations unchanged; ${added.length} new (${added.map((f) => f.slice(0, 3)).join(", ") || "none"}) with release, rollback, verify and preflight marker.`);
}
