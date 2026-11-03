/**
 * S1 (pre-go-live security pass): the two-company row-level-security proof over EVERY table with an organization_id, as the
 * database runs a signed-in request (role authenticated + request.jwt.claims). The proof itself is the SQL file, so it can be
 * rerun by hand with psql against any disposable copy of the schema; this test runs it on the local stack so CI does too.
 *
 * tests/db/tenancy.test.ts covers 12 business tables through the real API and the role matrix; tests/db/definer-functions.test.ts
 * covers every SECURITY DEFINER function. This covers the rest of the tables: read, insert, update (filtered and unfiltered),
 * move and delete of the other company's rows, by each of the four roles and by anon, with the policies alone (no triggers)
 * and, for inserts and moves, as deployed. The file runs in one transaction and rolls back: nothing is left behind.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TABLES } from "../support/tenancy-tables";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const PROOF = readFileSync(path.join(__dirname, "../scripts/rls-two-tenant-proof.sql"), "utf8");

type Result = { command: string; fields: { name: string }[]; rows: Record<string, unknown>[] };

describe("two-company RLS proof over every table with an organization_id", () => {
  it("no role of one company, and no signed-out request, reads or changes a row of the other", async () => {
    await verifyBackendIdentity();
    const results = await withDb(async (db) => (await db.query(PROOF)) as unknown as Result[]);
    const summary = results.find((r) => r.fields?.some((f) => f.name === "tables_with_organization_id"))?.rows[0];
    expect(summary).toBeDefined();
    // The catalogue found the tables (81 public tables at 101, of which 78 have an organization_id, plus security_audit's).
    expect(Number(summary!.tables_with_organization_id)).toBeGreaterThanOrEqual(80);
    expect(Number(summary!.callers)).toBe(5);
    expect(Number(summary!.failed)).toBe(0);
    // The 12 tables the API-level matrix covers are among them.
    const listed = results.find((r) => r.fields?.some((f) => f.name === "attempt") && r.fields.some((f) => f.name === "checks"));
    expect(listed?.rows.map((r) => r.attempt)).toEqual(expect.arrayContaining(["read beta rows", "insert beta row (RLS only)", "unfiltered delete removes nothing of beta's"]));
    const tables = await withDb(async (db) => (await db.query<{ t: string }>(
      "select c.relname as t from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'")).rows.map((r) => r.t));
    expect(tables).toEqual(expect.arrayContaining(Object.keys(TABLES)));
    // Rolled back: no company or person of the proof is left.
    const left = await withDb(async (db) => (await db.query("select count(*)::int as n from public.organizations where slug like 't-s1proof-%'")).rows[0].n);
    expect(left).toBe(0);
  });
});
