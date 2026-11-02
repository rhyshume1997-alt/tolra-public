/**
 * Migration 132: the dashboard's tile figures counted in the database (E6). On the real database (CI) this proves what the local
 * PostgreSQL 16 stand-in proved (tests/scripts/sql/132_dashboard_tile_figures.proof.sql):
 *   - on the seed (tests/scripts/sql/132_dashboard_tile_figures.seed.sql) each of the six functions gives, for each of five people,
 *     exactly the answer recorded in tests/fixtures/dashboard-tiles-132.json; tests/unit/dashboard-tile-figures.test.ts proves those
 *     answers give the same figures on screen as the page's old reads of the same rows. So the real database is checked against the
 *     fixture, and the fixture against the old arithmetic;
 *   - every answer is whole numbers in its JSON text (no float, whose text depends on the session's extra_float_digits: Supabase's
 *     server sets 0, PostgreSQL's default is 1), checked under both 0 and 1, with the same text under each;
 *   - row-level security applies (an office login with Quotes hidden counts no quote; Beta sees only Beta) and anon is refused;
 *   - supabase/verify/dashboard_tiles_132.sql is TRUE on every row, and the rollback removes all six (inside a rolled-back transaction).
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 093, 101, 103 and 116 suites do. Everything runs in one
 * transaction that is rolled back, so the seed's two companies are never committed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const fixture = JSON.parse(read("tests/fixtures/dashboard-tiles-132.json"));
const PEOPLE: Record<string, string> = {
  alpha_admin: "a0000000-0000-0000-0000-0000000001a1",
  alpha_office_quotes_hidden: "a0000000-0000-0000-0000-0000000001a2",
  beta_admin: "b0000000-0000-0000-0000-0000000001b1",
  gamma_admin: "c0000000-0000-0000-0000-0000000001c1",
  delta_admin: "d0000000-0000-0000-0000-0000000001d1",
};
const CALLS = `select public.dashboard_open_quotes('2026-10-20') as open, public.dashboard_quotes_sent('2026-10-01') as sent,
  public.dashboard_quotes_won('2026-10-01') as won, public.dashboard_quote_outcomes('2026-07-22', '2026-10-20') as outcomes,
  public.dashboard_rfqs_to_quote() as rfqs, public.dashboard_money_owed('2026-10-20') as owed`;
/** The same six answers as the JSON text the server sends (what PostgREST passes on). */
const TEXT_CALLS = `select row_to_json(t)::text as text from (${CALLS}) t`;
/** Numbers in a JSON text with every key and string taken out: whole numbers only (no decimal point, no exponent). */
const onlyWholeNumbers = (text: string) => !/[.eE]/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'));

/** fn inside one transaction that is always rolled back, with the seed in it. */
async function seeded<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local time zone 'UTC'");
      await db.query(read("tests/scripts/sql/132_dashboard_tile_figures.seed.sql"));
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}
async function asUser(db: Client, user: string | null, sql: string) {
  await db.query("savepoint s");
  try {
    if (user) {
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2" }), user]);
      await db.query("set local role authenticated");
    } else {
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true)", [JSON.stringify({ role: "anon" })]);
      await db.query("set local role anon");
    }
    const { rows } = await db.query(sql);
    await db.query("release savepoint s");
    await db.query("reset role");
    return { rows, code: null as string | null };
  } catch (err) {
    await db.query("rollback to savepoint s");
    await db.query("reset role");
    return { rows: [], code: (err as { code?: string }).code ?? "?" };
  }
}

beforeAll(async () => {
  await verifyBackendIdentity();
});

describe("132: dashboard tile figures", () => {
  it("each person's six answers are exactly the fixture's (so, through the unit test, the page's old figures), whole numbers only, under extra_float_digits 0 and 1", async () => {
    await seeded(async (db) => {
      const texts: Record<string, string[]> = {};
      for (const digits of [0, 1]) {
        await db.query(`set local extra_float_digits = ${digits}`);
        for (const [who, user] of Object.entries(PEOPLE)) {
          const { rows, code } = await asUser(db, user, CALLS);
          expect(code, `${who} (${digits})`).toBeNull();
          expect(rows[0], `${who} (${digits})`).toStrictEqual(fixture.people[who].rpc);
          const sent = await asUser(db, user, TEXT_CALLS);
          expect(sent.code, `${who} (${digits})`).toBeNull();
          const text = sent.rows[0].text as string;
          expect(onlyWholeNumbers(text), `${who} (${digits}): ${text}`).toBe(true);
          expect(JSON.parse(text), `${who} (${digits})`).toStrictEqual(fixture.people[who].rpc);
          (texts[who] ??= []).push(text);
        }
      }
      for (const [who, [at0, at1]] of Object.entries(texts)) expect(at0, who).toBe(at1);
    });
  });

  it("anon is refused every function (42501)", async () => {
    await seeded(async (db) => {
      for (const call of ["dashboard_open_quotes('2026-10-20')", "dashboard_quotes_sent('2026-10-01')", "dashboard_quotes_won('2026-10-01')",
        "dashboard_quote_outcomes('2026-07-22', '2026-10-20')", "dashboard_rfqs_to_quote()", "dashboard_money_owed('2026-10-20')"]) {
        expect((await asUser(db, null, `select public.${call}`)).code, call).toBe("42501");
      }
    });
  });

  it("verify file TRUE on every row; the rollback removes all six (rolled back)", async () => {
    await withDb(async (db) => {
      const verify = await db.query(read("supabase/verify/dashboard_tiles_132.sql"));
      expect(verify.rows.map((r) => [r.check_name, r.ok])).toEqual(verify.rows.map((r) => [r.check_name, true]));
      expect(verify.rows.length).toBe(6);
      await db.query("begin");
      try {
        await db.query(unwrapped(read("supabase/release/132_dashboard_tile_figures.rollback.sql")));
        const after = await db.query(read("supabase/verify/dashboard_tiles_132.sql"));
        expect(after.rows.find((r) => r.check_name === "six_functions")?.ok).toBe(false);
      } finally {
        await db.query("rollback");
      }
    });
  });
});
