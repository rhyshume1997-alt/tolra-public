/**
 * Release 170 (module K): the SQL files agree with each other and stay inside what was approved: one column, one constraint, one guard
 * function, one trigger; the release body is the proposal's, verbatim; rollback and verify exist; it is phase 170 (after 167) in the release plan and
 * touches no existing data, policy or grant. The behavioural proof is tests/db/worksheet-custom-170.test.ts (Supabase stack, CI) and, on plain
 * PostgreSQL, tests/postgres/worksheet-custom-170.proof.sql.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const proposal = read("supabase/proposals/p170_worksheet_custom.sql");
const release = read("supabase/release/170_worksheet_custom.release.sql");
const rollback = read("supabase/release/170_worksheet_custom.rollback.sql");
const verify = read("supabase/verify/worksheet_custom_170.sql");
const plan = JSON.parse(read("supabase/release-plan.json")) as { phases: { number: number; after: string; source: string; release: string; rollback: string; verify: string; marker: string }[]; other_proposals: { source: string }[] };

/** The SQL after the proposal's leading comment block. */
const proposalBody = proposal.slice(proposal.indexOf("BEGIN;") + 6, proposal.lastIndexOf("COMMIT;")).trim();
const sqlOnly = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

describe("release 170", () => {
  it("the release contains the proposal body verbatim, and starts the way the fixture and the CI install step look for", () => {
    expect(release).toContain(proposalBody);
    expect(release.startsWith("-- Post-144 release step 170 ")).toBe(true);
  });
  it("the function body's fingerprint in the release, rollback and verify is the same and matches the proposal's function", () => {
    const md5s = [release, rollback, verify].map((text) => [...text.matchAll(/'([0-9a-f]{32})'/g)].map((m) => m[1]));
    expect(new Set(md5s.flat()).size).toBe(1);
    const body = proposal.match(/AS \$\$([\s\S]*?)\$\$;/)![1];
    expect(createHash("md5").update(body.replace(/\s/g, "")).digest("hex")).toBe(md5s[0][0]);
  });
  it("adds only the column, its constraint, the guard function and its trigger", () => {
    const sql = sqlOnly(proposalBody);
    expect(sql.match(/^(ALTER TABLE|CREATE|DROP|REVOKE|GRANT|UPDATE|INSERT|DELETE|TRUNCATE)\b[^\n]*/gm)).toEqual([
      "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS worksheet_custom JSONB NOT NULL DEFAULT '{}'::JSONB;",
      "CREATE OR REPLACE FUNCTION public.jobs_worksheet_custom_lock()",
      "REVOKE ALL ON FUNCTION public.jobs_worksheet_custom_lock() FROM PUBLIC, anon, authenticated;",
      "DROP TRIGGER IF EXISTS jobs_worksheet_custom_lock ON public.jobs;",
      "CREATE TRIGGER jobs_worksheet_custom_lock BEFORE UPDATE OF worksheet_custom ON public.jobs",
    ]);
    expect(sql).toMatch(/ADD CONSTRAINT jobs_worksheet_custom_shape CHECK \(jsonb_typeof\(worksheet_custom\) = 'object' AND octet_length\(worksheet_custom::TEXT\) <= 20000\)/);
    expect(sql).not.toMatch(/\b(POLICY|GRANT|DROP TABLE|DROP COLUMN|DELETE|TRUNCATE|UPDATE public\.)\b/);
  });
  it("the guard is a definer with a pinned search path, refuses with 42501 and a hint, and exempts non-browser roles", () => {
    expect(proposal).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
    expect(proposal).toMatch(/ERRCODE = '42501', HINT = 'signed_off_custom_locked'/);
    expect(proposal).toMatch(/NOT IN \('anon', 'authenticated'\)/);
    expect(proposal).toMatch(/s\.kind = 'primary' AND s\.worksheet_version = OLD\.worksheet_version/);
  });
  it("is wrapped in one transaction with a guard that refuses drift and a self-check that compares everything else", () => {
    expect(release.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(release.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(release).toMatch(/DRIFTED/);
    expect(release).toMatch(/p170_fingerprint/);
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback).toMatch(/REFUSES, changing nothing, while any job holds a custom/);
    expect(sqlOnly(rollback).match(/^(DROP|ALTER TABLE)[^\n]*/gm)).toEqual([
      "DROP TRIGGER IF EXISTS jobs_worksheet_custom_lock ON public.jobs;",
      "DROP FUNCTION IF EXISTS public.jobs_worksheet_custom_lock();",
      "ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_worksheet_custom_shape;",
      "ALTER TABLE public.jobs DROP COLUMN IF EXISTS worksheet_custom;",
      "DROP TABLE pg_temp.p170_before;",
      "DROP FUNCTION pg_temp.p170_fingerprint();",
    ]);
  });
  it("is phase 170 after 167 in the plan, with its marker in release preflight, and is no longer a loose proposal", () => {
    expect(plan.phases.find((phase) => phase.number === 170)).toEqual({ number: 170, after: "167", source: "supabase/proposals/p170_worksheet_custom.sql", release: "supabase/release/170_worksheet_custom.release.sql", rollback: "supabase/release/170_worksheet_custom.rollback.sql", verify: "supabase/verify/worksheet_custom_170.sql", marker: "post-144 marker 170 worksheet_custom" });
    expect(plan.other_proposals.map((p) => p.source)).not.toContain("supabase/proposals/p170_worksheet_custom.sql");
    const preflight = read("supabase/verify/release_preflight.sql");
    expect(preflight).toContain("'post-144 marker 170 worksheet_custom'");
    expect(preflight).toContain("'170 needs:");
    expect(preflight).toContain("'supabase/proposals/p170_worksheet_custom.sql'");
  });
  it("the same function fingerprint is in the preflight marker row", () => {
    const md5 = release.match(/= '([0-9a-f]{32})'/)![1];
    expect(read("supabase/verify/release_preflight.sql")).toContain(`= '${md5}'`);
  });
  it("rollback refuses, and changes nothing, while any job holds a custom value", () => {
    expect(rollback).toMatch(/IF v_col THEN[\s\S]*IF EXISTS \(SELECT 1 FROM public\.jobs j WHERE j\.worksheet_custom <> '\{\}'::jsonb\) THEN/);
    expect(rollback).toMatch(/this file never deletes records/);
    expect(rollback.indexOf("worksheet_custom <> '{}'::jsonb")).toBeLessThan(rollback.indexOf("DROP TRIGGER IF EXISTS"));
  });
  it("is wired into CI: the install loop, the schema marker script and the DB proof", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain('"170_worksheet_custom|worksheet_custom_170|post-144 marker 170 worksheet_custom"');
    expect(ci).toContain("tests/db/worksheet-custom-170.test.ts");
    expect(read("scripts/ci-schema-markers.sh")).toContain('"post-144 marker 170 worksheet_custom|worksheet_custom_170|170 worksheet_custom applied"');
    expect(read("tests/support/db-release-sequencer.ts")).toContain('"worksheet-custom-170.test.ts"');
  });
  it("the app never writes the column anywhere except lib/worksheet-builder/custom-values.ts", () => {
    const out = execSync("grep -rln worksheet_custom app components lib --include=*.ts --include=*.tsx || true", { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).trim().split("\n").sort();
    expect(out).toEqual(["app/(dashboard)/jobs/[id]/print/page.tsx", "components/worksheet-builder/job-custom-fields.tsx", "lib/worksheet-builder/custom-values.ts"].sort());
  });
});
