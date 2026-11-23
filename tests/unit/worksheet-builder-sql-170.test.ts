/**
 * Release 170 (module K): the SQL files agree with each other and stay inside what was approved: one column, one constraint, one guard
 * function, one trigger; the release body is the proposal's, verbatim; rollback and verify exist; it is not a numbered phase (that needs
 * Rhys's yes) and touches no existing data, policy or grant. The behavioural proof runs on PostgreSQL (tests/postgres/worksheet-custom-170.proof.sql).
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
const plan = JSON.parse(read("supabase/release-plan.json")) as { phases: { number: number }[]; other_proposals: { source: string }[] };

/** The SQL after the proposal's leading comment block. */
const proposalBody = proposal.slice(proposal.search(/^ALTER TABLE/m));
const releaseBody = release.split("-- ---- BODY ----\n")[1];
const sqlOnly = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

describe("release 170", () => {
  it("the release body is the proposal body, verbatim", () => {
    expect(releaseBody).toBe(proposalBody);
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
    expect(rollback).toMatch(/LOST by this rollback/);
    expect(sqlOnly(rollback).match(/^(DROP|ALTER TABLE)[^\n]*/gm)).toEqual([
      "DROP TRIGGER IF EXISTS jobs_worksheet_custom_lock ON public.jobs;",
      "DROP FUNCTION IF EXISTS public.jobs_worksheet_custom_lock();",
      "ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_worksheet_custom_shape;",
      "ALTER TABLE public.jobs DROP COLUMN IF EXISTS worksheet_custom;",
      "DROP TABLE pg_temp.p170_before;",
      "DROP FUNCTION pg_temp.p170_fingerprint();",
    ]);
  });
  it("is registered as a proposal only: not a numbered phase, so nothing installs it without Rhys's yes", () => {
    expect(plan.phases.map((p) => p.number)).not.toContain(170);
    expect(plan.other_proposals.map((p) => p.source)).toContain("supabase/proposals/p170_worksheet_custom.sql");
    expect(read("supabase/verify/release_preflight.sql")).toContain("'supabase/proposals/p170_worksheet_custom.sql'");
    expect(release).toMatch(/NOT yet a numbered phase/);
  });
  it("the app never writes the column anywhere except lib/worksheet-builder/custom-values.ts", () => {
    const out = execSync("grep -rln worksheet_custom app components lib --include=*.ts --include=*.tsx || true", { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).trim().split("\n").sort();
    expect(out).toEqual(["app/(dashboard)/jobs/[id]/print/page.tsx", "components/worksheet-builder/job-custom-fields.tsx", "lib/worksheet-builder/custom-values.ts"].sort());
  });
});
