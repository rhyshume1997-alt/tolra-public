/**
 * Regression & contract tests for Release 174 (CR-010, CR-011, CR-012, CR-013, CR-020):
 * Verifies forward-only creation idempotency SQL packaging, grants, immutability guards,
 * non-destructive rollback, and release-plan/check-migrations compliance.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkMigrations } from "../../scripts/check-migrations.mjs";
import { checkReleasePlan } from "../../scripts/check-release-plan.mjs";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("Release 174: forward-only creation idempotency (CR-010, CR-011, CR-012, CR-013, CR-020)", () => {
  const proposal = read("supabase/proposals/p174_create_idempotency.sql");
  const release = read("supabase/release/174_create_idempotency.release.sql");
  const rollback = read("supabase/release/174_create_idempotency.rollback.sql");
  const verify = read("supabase/verify/create_idempotency_174.sql");

  it("passes checkMigrations and checkReleasePlan with zero problems", () => {
    expect(checkReleasePlan(root)).toEqual([]);
    expect(checkMigrations(root).problems).toEqual([]);
  });

  it("copies the canonical proposal body verbatim inside the transactional release package", () => {
    const body = proposal.slice(proposal.indexOf("BEGIN;") + 6, proposal.lastIndexOf("COMMIT;")).trim();
    expect(body.length).toBeGreaterThan(200);
    expect(release).toContain(body);
    expect(release).toContain("DO $post_release_guard$");
    expect(release).toContain("DO $p174_self_check$");
    expect(release.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("adds nullable request_id UUID, partial unique index, and immutability trigger on all 5 tables without deleting history", () => {
    for (const table of ["quotes", "invoices", "sales_orders", "purchase_orders", "jobs"]) {
      expect(proposal).toContain(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS request_id UUID;`);
      expect(proposal).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_org_request_uniq`);
      expect(proposal).toContain(`ON public.${table} (organization_id, request_id)`);
      expect(proposal).toContain(`CREATE TRIGGER ${table}_request_id_immutable`);
    }
    expect(proposal).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(proposal).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("defines all 4 idempotent create RPCs with advisory locks, pinned search_path, and authenticated-only EXECUTE", () => {
    const rpcs = [
      "public.create_with_lines_idempotent(UUID, TEXT, JSONB, TEXT, TEXT, JSONB)",
      "public.create_sales_order_idempotent(UUID, JSONB)",
      "public.create_purchase_order_idempotent(UUID, JSONB)",
      "public.create_job_idempotent(UUID, TEXT, TEXT, BOOLEAN, UUID, DATE, JSONB, BOOLEAN, JSONB, TEXT)",
    ];
    for (const sig of rpcs) {
      expect(proposal).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon;`);
      expect(proposal).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;`);
    }
    expect(proposal).toContain("REVOKE ALL ON FUNCTION public.create_request_id_immutable() FROM PUBLIC, anon, authenticated;");
    expect(proposal).toContain("pg_advisory_xact_lock(hashtextextended('create_with_lines:'");
    expect(proposal).toContain("pg_advisory_xact_lock(hashtextextended('sales_orders:'");
    expect(proposal).toContain("pg_advisory_xact_lock(hashtextextended('purchase_orders:'");
    expect(proposal).toContain("pg_advisory_xact_lock(hashtextextended('job-no:'");
    expect(proposal.match(/SET search_path = pg_catalog, public/g)?.length).toBe(5);
  });

  it("ships a non-destructive rollback that refuses whenever any table holds a non-null request_id", () => {
    for (const table of ["quotes", "invoices", "sales_orders", "purchase_orders", "jobs"]) {
      expect(rollback).toContain(`IF EXISTS (SELECT 1 FROM public.${table} WHERE request_id IS NOT NULL)`);
      expect(rollback).toContain(`ALTER TABLE public.${table} DROP COLUMN IF EXISTS request_id;`);
    }
    expect(rollback).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(verify).toContain("all 5 target tables have nullable request_id uuid column");
    expect(verify).toContain("all 4 idempotent create RPCs exist with pinned search_path and authenticated-only EXECUTE");
  });
});
