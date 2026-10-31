import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Migration 102 goes to production, which has 095 and 100 but NOT 099 or 101 (they ship later, with 103). So none of 102's files may
// name an object that 099 or 101 creates or replaces: a function, table, column, trigger or index. 103 (the AI helper part of the same
// review) needs 101 and must say so in its guard. The database side of this (102 applied with 101 and 103 taken away; 103 refused) is
// in tests/db/security-guards-102.test.ts.
const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/** Every object name a migration creates or replaces. */
function objectsOf(sql: string): string[] {
  const patterns = [
    /CREATE (?:OR REPLACE )?FUNCTION (?:public|security_audit)\.(\w+)\(/gi,
    /CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)/gi,
    /ADD COLUMN IF NOT EXISTS (\w+)/gi,
    /CREATE TRIGGER (\w+)/gi,
    /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+)/gi,
  ];
  return [...new Set(patterns.flatMap((re) => [...sql.matchAll(re)].map((m) => m[1].toLowerCase())))].sort();
}

const files102 = ["supabase/migrations/102_security_guards.sql", "supabase/release/102_security_guards.release.sql",
  "supabase/release/102_security_guards.rollback.sql", "supabase/verify/security_guards_102.sql"];

describe("102 is independent of 099 and 101", () => {
  for (const source of ["supabase/migrations/099_part_despatch_invoice_quantity.sql", "supabase/migrations/101_ai_helper.sql"]) {
    it(`names no object ${path.basename(source)} creates or replaces`, () => {
      const objects = objectsOf(read(source));
      expect(objects.length).toBeGreaterThan(5);
      for (const file of files102) {
        const text = read(file).toLowerCase();
        const named = objects.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
        expect(named, file).toEqual([]);
      }
    });
  }

  it("names no ai_helper object at all, and 103 (not 102) holds the AI helper changes", () => {
    for (const file of files102) expect(read(file), file).not.toMatch(/ai_helper/);
    const m103 = read("supabase/migrations/103_ai_helper_service_role.sql");
    expect(m103).toMatch(/CREATE OR REPLACE FUNCTION public\.ai_helper_reserve\(/);
    expect(m103).toMatch(/CREATE OR REPLACE FUNCTION public\.ai_helper_settle\(/);
    expect(m103).toMatch(/RAISE EXCEPTION '103: the AI helper \(101\) is not applied; apply 101 first'/);
  });
});
