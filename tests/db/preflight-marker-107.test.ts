/**
 * Preflight marker 107 (integrations connect) in every state around release 151, on a disposable database. The marker (and the output
 * column that adds the marker-151 requirement) is cut out of release_preflight.sql and evaluated with a stand-in for to_regprocedure,
 * a temp function in this session only: nothing shared is created, dropped or changed. The two 107 tables are real.
 *   original 107 and no 151 -> applied; complete 151 with marker 151 -> applied;
 *   both families, part of 151, neither, an unrelated function, or complete objects with marker 151 not applied -> not applied.
 * Finally the whole preflight is run once: marker 107 appears exactly once and reads applied (before or after 151 alike).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { FAKE_FUNCTION, SCENARIOS, buildQuery } from "../support/preflight-marker-107";

const preflight = readFileSync(path.resolve(__dirname, "../../supabase/verify/release_preflight.sql"), "utf8");

beforeAll(async () => { await verifyBackendIdentity(); });

describe("preflight marker 107 before, during and after release 151", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} -> ${scenario.expected}`, async () => {
      const value = await withDb(async (db) => {
        await db.query(FAKE_FUNCTION);
        await db.query("SELECT set_config('test.present', $1, false)", [scenario.present.join(";")]);
        return (await db.query(buildQuery(preflight, scenario.marker151))).rows[0].value as string;
      });
      expect(value).toBe(scenario.expected);
    });
  }
  it("the real preflight lists marker 107 once and it reads applied", async () => {
    const rows = await withDb(async (db) => (await db.query(preflight)).rows as Array<{ check: string; value: string }>);
    const hits = rows.filter((row) => row.check === "marker 107 integrations connect");
    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe("applied");
  });
});
