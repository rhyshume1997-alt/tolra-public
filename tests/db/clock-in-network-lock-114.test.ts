/**
 * Clock-in network lock (migration 114, M27): runs the SQL proof tests/scripts/clock-in-network-lock-114.proof.sql on the disposable
 * database, as one transaction that it rolls back itself. The proof signs in as PostgREST would (role authenticated, the JWT claims,
 * request.headers with cf-connecting-ip) and covers: unlocked by default; lock and unlock admin only, two-step, from the request's own
 * address only (never x-forwarded-for, never a private one); the lock covers everyone: a default person's clock in, clock out, break
 * start and break end from another address refused with nothing recorded (075's On site only flag ignored); the locked address, its
 * IPv6 /64 and a saved site network allowed; the per-person off-site exception (admin only, two-step, own company) lets that person
 * through only while locked; another company and an admin correction never checked; synced-later and address-less actions accepted and marked
 * network_unverified (immutable); who reads what; re-capture; unlock. Each check raises on failure; every one must print PASS.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const PROOF = readFileSync(path.resolve(__dirname, "../scripts/clock-in-network-lock-114.proof.sql"), "utf8");
/** The proof without psql's meta-commands (\set, \o): plain SQL, BEGIN ... ROLLBACK. */
const SQL = PROOF.split("\n").filter((line) => !line.startsWith("\\")).join("\n");
/** One PASS per check: each SELECT or PERFORM of pg_temp.ok / pg_temp.expect_refused (not their definitions or grants). */
const CHECKS = (PROOF.match(/(SELECT|PERFORM) pg_temp\.(ok|expect_refused)\(/g) ?? []).length;

beforeAll(async () => { await verifyBackendIdentity(); });

describe("clock-in network lock (114)", () => {
  it("every check of the SQL proof passes, and nothing it wrote is kept", async () => {
    const notices: string[] = [];
    await withDb(async (db) => {
      const listen = (n: { message?: string }) => { if (n.message) notices.push(n.message); };
      db.on("notice", listen);
      try {
        await db.query(SQL);
      } catch (err) {
        await db.query("rollback");
        throw err;
      } finally {
        db.off("notice", listen);
      }
    });
    const passed = notices.filter((n) => n.startsWith("PASS "));
    expect(notices.filter((n) => n.startsWith("FAIL "))).toEqual([]);
    expect(passed.length).toBe(CHECKS);
    const left = await withDb(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from public.organizations where slug in ('t-lock114-a', 't-lock114-b')")).rows[0].n);
    expect(left).toBe(0);
  });
});
