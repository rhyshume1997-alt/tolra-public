import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseSql } from "../../scripts/release-sql.mjs";
const read = (file: string) => readFileSync(new URL(`../../supabase/${file}`, import.meta.url), "utf8");
describe("accounting connection SQL proposal (static checks, not database evidence)", () => {
  it("has an exact atomic release, preserving company/admin/support/AAL checks", () => {
    const migration = read("migrations/144_accounting_connections.sql");
    expect(read("release/144_accounting_connections.release.sql")).toBe(releaseSql(migration, "144_accounting_connections.sql"));
    expect(migration).toContain("public.assert_privileged_aal()");
    expect(migration).toContain("public.has_org_role(ARRAY['admin'])");
    expect(migration).toContain("s.is_support");
    expect(migration).toContain("VALUES (v_org, p_provider, v_uid");
    expect(migration).toContain("c.provider = 'xero'");
    expect(migration).not.toContain("ALTER TABLE public.integration_sends");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
  });
  it("rollback refuses to discard connection/token/state rows", () => {
    const rollback = read("release/144_accounting_connections.rollback.sql");
    for (const table of ["integration_connections", "integration_secrets", "integration_oauth_states"]) expect(rollback).toContain(`SELECT 1 FROM public.${table}`);
    expect(rollback).toContain("RAISE EXCEPTION");
    // Restored function bodies contain their normal future cleanup; rollback itself must delete no rows.
    const executable = rollback.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/g, "");
    expect(executable).not.toMatch(/DELETE FROM|TRUNCATE/);
    expect(executable.indexOf("RAISE EXCEPTION")).toBeLessThan(executable.indexOf("DROP FUNCTION"));
  });
});
