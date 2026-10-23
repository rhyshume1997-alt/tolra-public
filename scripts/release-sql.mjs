#!/usr/bin/env node
/**
 * Release SQL for one migration (audit B10; independent review of 0604bf4): the file wrapped in BEGIN ... COMMIT, so
 * it applies completely or not at all. This exact text is what the upgrade rehearsal executes, and what the run sheet
 * (docs/RELEASE.md) pastes into the SQL editor or runs with psql. Postgres stops at the first error inside the
 * transaction, the COMMIT never runs, and when the session ends (or COMMIT runs on the failed transaction) everything
 * since BEGIN is rolled back: none of that file's changes remain, and earlier files stay applied.
 *
 *   node scripts/release-sql.mjs supabase/migrations/027_draft_issue_and_delivery.sql > 027.release.sql
 *
 * Refuses a file that manages its own transaction or contains statements that can't run inside one.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** Problems that make a file unsafe to wrap (empty = fine). Checks top-level lines only, not function bodies' BEGIN. */
export function wrapProblems(sql) {
  const problems = [];
  const lines = sql.split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/--.*$/, "").trim();
    // A function body's own BEGIN has no semicolon and its END; closes the body, so neither is matched here.
    if (/^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;$/i.test(code) || /^(SAVEPOINT|RELEASE|ROLLBACK\s+TO)\b/i.test(code)) {
      problems.push(`line ${i + 1}: transaction control "${code}"`);
    }
    if (/\bCONCURRENTLY\b|^VACUUM\b|^ALTER\s+SYSTEM\b|^(CREATE|DROP)\s+DATABASE\b/i.test(code)) problems.push(`line ${i + 1}: can't run inside a transaction: "${code}"`);
  });
  return problems;
}

/** The migration wrapped for release. Throws if it can't be wrapped safely. */
export function releaseSql(sql, name = "migration") {
  const problems = wrapProblems(sql);
  if (problems.length) throw new Error(`${name} can't be applied as one transaction:\n  ${problems.join("\n  ")}`);
  return `-- ${name}: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.\nBEGIN;\n\n${sql.trimEnd()}\n\nCOMMIT;\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/release-sql.mjs <migration.sql>");
    process.exit(2);
  }
  try {
    process.stdout.write(releaseSql(readFileSync(file, "utf8"), basename(file)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
