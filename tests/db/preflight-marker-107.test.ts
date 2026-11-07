/**
 * Preflight marker 107 (integrations connect) against simulated function sets, on a disposable database. The marker is cut out of
 * release_preflight.sql and evaluated with a stand-in "fn" list, so nothing in the database is created, dropped or changed (no DDL,
 * no write). The two 107 tables are real: the baseline database has release 107.
 *   before 151: the 107 token functions exist                              -> applied
 *   after 151:  integration_invite_redeem is gone, 151's function exists   -> applied (this was "not applied" before the fix)
 *   151 half-way / both present                                            -> applied
 *   neither function (107 damaged, or 151 incomplete)                      -> not applied
 *   an unrelated function only                                             -> not applied
 * Finally the whole preflight is run once: marker 107 appears exactly once and reads applied.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const preflight = read("supabase/verify/release_preflight.sql");

function marker107(): string {
  const m = /\('107 integrations connect',([\s\S]*?)\),\s*\n\s*\('108 /.exec(preflight);
  if (!m) throw new Error("marker 107 not found in release_preflight.sql");
  return m[1];
}

/** The stand-in for the preflight's "fn" list: only the names given, all in schema public, with an empty body. */
function standIn(names: string[]): string {
  const values = names.map((name) => `('public', '${name}', '')`).join(", ");
  return names.length > 0
    ? `fn AS (SELECT nspname, proname, prosrc FROM (VALUES ${values}) AS t(nspname, proname, prosrc))`
    : "fn AS (SELECT ''::text AS nspname, ''::text AS proname, ''::text AS prosrc WHERE false)";
}

async function applied(names: string[]): Promise<boolean> {
  return withDb(async (db) => {
    const res = await db.query(`WITH ${standIn(names)} SELECT (${marker107()}) AS ok`);
    return res.rows[0].ok === true;
  });
}

beforeAll(async () => { await verifyBackendIdentity(); });

describe("preflight marker 107 before and after release 151", () => {
  it("before 151: the 107 token functions exist -> applied", async () => {
    expect(await applied(["integration_invite_create", "integration_invite_redeem"])).toBe(true);
  });
  it("after 151: the redeem function is dropped and 151's function exists -> applied", async () => {
    expect(await applied(["integration_invite_store_connection"])).toBe(true);
  });
  it("both families present (151 half-way) -> applied", async () => {
    expect(await applied(["integration_invite_redeem", "integration_invite_store_connection"])).toBe(true);
  });
  it("neither function (damaged, or 151 incomplete) -> not applied", async () => {
    expect(await applied([])).toBe(false);
  });
  it("an unrelated function only -> not applied", async () => {
    expect(await applied(["integration_invite_peek"])).toBe(false);
  });
  it("the real preflight lists marker 107 once and it reads applied", async () => {
    const rows = await withDb(async (db) => (await db.query(preflight)).rows as Array<{ check: string; value: string }>);
    const hits = rows.filter((row) => row.check === "marker 107 integrations connect");
    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe("applied");
  });
});
