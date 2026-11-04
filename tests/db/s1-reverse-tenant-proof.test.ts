import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

// Keep the original alpha -> beta proof; add beta -> alpha with the SAME real SQL.
const forward = readFileSync(path.join(__dirname, "../scripts/rls-two-tenant-proof.sql"), "utf8");
const reverse = forward.replaceAll("'alpha'", "'__s1_swap__'").replaceAll("'beta'", "'alpha'").replaceAll("'__s1_swap__'", "'beta'");
type Result = { fields: { name: string }[]; rows: Record<string, unknown>[] };

describe("S1: reverse company isolation on a disposable database", () => {
  it("no beta role or anonymous caller reads or changes alpha rows", async () => {
    await verifyBackendIdentity(); // Refuse missing, hosted or non-synthetic backend before writes.
    const results = await withDb(async db => await db.query(reverse) as unknown as Result[]);
    const summary = results.find(result => result.fields?.some(field => field.name === "tables_with_organization_id"))?.rows[0];
    expect(summary).toBeDefined();
    expect(Number(summary!.tables_with_organization_id)).toBeGreaterThanOrEqual(80);
    expect(Number(summary!.callers)).toBe(5);
    expect(Number(summary!.failed)).toBe(0);
    // Attempt captions keep historical beta names; actual tenant literal bindings above are reversed.
    const attempts = results.find(result => result.fields?.some(field => field.name === "attempt"))?.rows.map(row => row.attempt);
    expect(attempts).toEqual(expect.arrayContaining(["read beta rows", "insert beta row (RLS only)", "unfiltered delete removes nothing of beta's"]));
    const remaining = await withDb(async db => (await db.query("select count(*)::int as n from public.organizations where slug like 't-s1proof-%'")).rows[0].n);
    expect(remaining).toBe(0);
  });
});
