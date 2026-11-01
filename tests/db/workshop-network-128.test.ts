/**
 * Settings > Workshop network (migration 128): runs the SQL proof tests/scripts/workshop-network-128.proof.sql on the disposable database,
 * as one transaction that it rolls back itself. The proof signs in as PostgREST would (role authenticated, the JWT claims, request.headers
 * with cf-connecting-ip) and covers: rename by the admin only (two-step, the caller's company only, keyed and idempotent, the name trimmed to
 * 1 to 60 characters, audited once per real change, the address never changed); an online clock action refused by 114's lock reported by
 * the device and recorded only when the database would refuse that request (status refused_unrecognised, the address kept, never in the
 * audit log), read by the company's admin only and counted by the banner's query; the per-person brake; and the address cleared after
 * 078's 30 days by the cron's site_network_ip_purge, by a new report and by the admin's Delete buttons. Also (ChatGPT's conditions): the
 * same key reported live and again from the offline queue (from any address) is one row; per role, workshop and viewer read no saved
 * network, name, lock or refusal (workshop only their own clock-in address, 078's rule), office no refusal, none of them renames; and
 * the 30 days cover both 078's clock-in addresses and the refusal addresses (rows at 29 and 31 days, through the cron, a clock action
 * and the admin's Delete expired). Each check raises on failure; every one must print PASS.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const PROOF = readFileSync(path.resolve(__dirname, "../scripts/workshop-network-128.proof.sql"), "utf8");
/** The proof without psql's meta-commands (\set, \o): plain SQL, BEGIN ... ROLLBACK. */
const SQL = PROOF.split("\n").filter((line) => !line.startsWith("\\")).join("\n");
/** One PASS per check: each SELECT or PERFORM of pg_temp.ok / pg_temp.expect_refused (not their definitions or grants). */
const CHECKS = (PROOF.match(/(SELECT|PERFORM) pg_temp\.(ok|expect_refused)\(/g) ?? []).length;

beforeAll(async () => { await verifyBackendIdentity(); });

describe("workshop network (128)", () => {
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
      "select count(*)::int as n from public.organizations where slug in ('t-net128-a', 't-net128-b')")).rows[0].n);
    expect(left).toBe(0);
  });
});
