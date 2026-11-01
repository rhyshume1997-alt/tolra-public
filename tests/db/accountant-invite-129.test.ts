/**
 * Migration 129: "Invite your accountant", an expiring, single-use VIEWER invite on 007's organization_invites, against the database of the
 * local stack. The proof is the SQL file (plain SQL, one transaction, rolled back), so the same text runs by hand with psql against any
 * disposable copy of the schema:
 *
 *   PGPASSWORD=... psql -X -q -v ON_ERROR_STOP=1 -d <disposable copy> -f tests/scripts/accountant-invite-129.proof.sql
 *
 * It proves create (admin, aal2, current company only; office, viewer, an aal1 admin and an admin whose session is in another company are
 * refused), the role always viewer and 7 days, the hash never readable, redeem once for the invite's e-mail only (expired, revoked, used and
 * another e-mail refused; an existing member's role never changed; a switched-off membership never revived), revoke by the company's admin
 * only, the sign-up trigger (valid accountant invite: viewer and marked used; expired or revoked: skipped; ordinary invites as 007), and an
 * audit row for every action. This test adds what the file cannot see: that it ran to the end and left nothing behind, and the verify script.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const PROOF = readFileSync(path.join(ROOT, "tests/scripts/accountant-invite-129.proof.sql"), "utf8");
const VERIFY = readFileSync(path.join(ROOT, "supabase/verify/accountant_invite_129.sql"), "utf8");

type Result = { command: string; fields?: { name: string }[]; rows: Record<string, unknown>[] };

describe("129 accountant invite", () => {
  it("every property of the proof holds, and the proof leaves nothing behind", async () => {
    await verifyBackendIdentity();
    const before = await withDb(async (db) => (await db.query("select count(*)::int as n from public.organization_invites")).rows[0].n as number);
    // Any failed property raises inside the file (FAIL <what>) and rejects here; the file rolls itself back.
    const results = await withDb(async (db) => (await db.query(PROOF)) as unknown as Result[]);
    const summary = results.find((r) => r.fields?.some((f) => f.name === "checks"))?.rows[0];
    expect(summary).toBeDefined();
    expect(summary!.result).toBe("PASS accountant invite 129 proof");
    // 70 checks when written; fewer means a section stopped running.
    expect(Number(summary!.checks)).toBeGreaterThanOrEqual(70);
    const after = await withDb(async (db) => ({
      invites: (await db.query("select count(*)::int as n from public.organization_invites")).rows[0].n as number,
      orgs: (await db.query("select count(*)::int as n from public.organizations where slug like 'proof129-%'")).rows[0].n as number,
    }));
    expect(after).toEqual({ invites: before, orgs: 0 });
  });

  it("supabase/verify/accountant_invite_129.sql answers TRUE on every row (12)", async () => {
    await verifyBackendIdentity();
    const rows = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(VERIFY)).rows);
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
  });
});
