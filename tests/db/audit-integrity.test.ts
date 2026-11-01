/**
 * S10: the audit trail of financial documents is tamper-evident and no API role can change or delete it. The proof is the SQL file
 * (plain SQL, one transaction, rolled back), so the same text can be rerun by hand with psql against any disposable copy of the schema:
 *
 *   PGPASSWORD=... psql -X -q -v ON_ERROR_STOP=1 -o /dev/null -d <disposable copy> -f tests/scripts/audit-integrity-proof.sql
 *
 * It proves, on the CI stack's database: nobody but the table owner holds a write privilege on security_audit.audit_log; anon,
 * authenticated and service_role are refused INSERT / UPDATE / DELETE / TRUNCATE (table and view); the append-only trigger and the chain
 * trigger hold even if an API role is given every privilege and an open policy; write_audit cannot make up VOID_INVOICE, ISSUE, MARK_PAID,
 * WRITE_OFF_INVOICE and the like; an invoice issued, paid and voided through the real functions leaves chained rows by the right actor;
 * the chain verification reports an edited payload, a deleted row, a rewritten hash and a back-dated insert (and the exemptions it cannot
 * see are listed as GAP lines, not hidden); the view gives each company's admins their own rows and no one else's.
 *
 * The same text is NOT re-implemented here: the file is the single source, so this test cannot drift from it. This test adds only what a
 * SQL file cannot see: the file's own summary, that nothing was left behind, and that PostgREST does not expose the security_audit schema.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const PROOF = readFileSync(path.join(__dirname, "../scripts/audit-integrity-proof.sql"), "utf8");
const CONFIG = readFileSync(path.join(__dirname, "../../supabase/config.toml"), "utf8");

type Result = { command: string; fields?: { name: string }[]; rows: Record<string, unknown>[] };

describe("audit log integrity (security_audit.audit_log)", () => {
  it("no API role can insert, change or delete an audit row; the chain verifies and detects tampering; the view shows each company its own rows", async () => {
    await verifyBackendIdentity();
    // Any failed property raises inside the file (FAIL <what>) and rejects here; the file rolls itself back.
    const results = await withDb(async (db) => (await db.query(PROOF)) as unknown as Result[]);
    const summary = results.find((r) => r.fields?.some((f) => f.name === "tampers_detected"))?.rows[0];
    expect(summary).toBeDefined();
    expect(summary!.result).toBe("PASS audit integrity proof");
    // 137 checks, 66 refusals and 13 detected tampers when written; a lower number means a section stopped running.
    expect(Number(summary!.checks)).toBeGreaterThanOrEqual(130);
    expect(Number(summary!.refusals)).toBeGreaterThanOrEqual(60);
    expect(Number(summary!.tampers_detected)).toBeGreaterThanOrEqual(13);
    // The reported exemptions are known and counted: a new one (or one fewer) is a decision, not an accident.
    expect(Number(summary!.gaps)).toBeGreaterThanOrEqual(7);
  });

  it("the file left nothing behind (no proof company, no proof user, no scratch schema)", async () => {
    const left = await withDb(async (db) => ({
      orgs: (await db.query("select count(*)::int as n from public.organizations where slug like 's10-proof-%'")).rows[0].n,
      users: (await db.query("select count(*)::int as n from auth.users where email like '%.s10proof@example.test'")).rows[0].n,
      schema: (await db.query("select count(*)::int as n from pg_namespace where nspname = 's10p'")).rows[0].n,
      forged: (await db.query("select count(*)::int as n from security_audit.audit_log where action = 'S10_FORGED'")).rows[0].n,
    }));
    expect(left).toEqual({ orgs: 0, users: 0, schema: 0, forged: 0 });
  });

  it("PostgREST exposes only public and graphql_public: security_audit is reachable by an API role only through the public view and functions", () => {
    const schemas = /^\s*schemas\s*=\s*\[(.*?)\]/m.exec(CONFIG)?.[1] ?? "";
    expect(schemas).toContain('"public"');
    expect(schemas).not.toContain("security_audit");
  });
});
