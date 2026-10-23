/**
 * PostgreSQL as the oracle for the injection-point picker (tests/rehearsal/inject-point.ts), independent of its tokenizer: for every
 * adversarial fixture, (1) the text ABOVE the chosen point runs as complete statements (the expected number of them), (2) the text
 * with the probe inserted there raises exactly the probe's exception (message and SQLSTATE), so the probe is a top-level statement
 * and not text inside a body, string or comment, and (3) the old picker's point, where it differs, does NOT give that result, so
 * the oracle can tell a bad point from a good one. Everything runs in a transaction that is rolled back, on temp objects only.
 * Runs with the rehearsal suite (local disposable database only).
 */
import type { Client } from "pg";
import { describe, expect, it } from "vitest";

import { withDb } from "../support/fixtures";
import { FIXTURES, legacyInjectPoint } from "./inject-fixtures";
import { INJECT_SQLSTATE, injectPoint, probeMessage, probeSql } from "./inject-point";

type PgError = { code?: string; message: string };

/** Runs `text` in a transaction that is always rolled back; the error it raised, or null. */
async function attempt(db: Client, text: string): Promise<{ error: PgError | null; results: number }> {
  await db.query("begin");
  try {
    const res = await db.query(text);
    return { error: null, results: Array.isArray(res) ? res.length : 1 };
  } catch (err) {
    return { error: err as PgError, results: 0 };
  } finally {
    await db.query("rollback");
  }
}

const insertAt = (ls: string[], at: number, probe: string) => [...ls.slice(0, at), probe, ...ls.slice(at)].join("\n");

describe("injection point, checked by PostgreSQL", () => {
  for (const fx of FIXTURES) {
    it(`fixture: ${fx.name}`, async () => {
      const ls = fx.sql.split("\n");
      const at = injectPoint(ls)!;
      const unique = `fixture-probe-${Math.random().toString(36).slice(2)}`;
      const probe = probeSql(unique, "fixture", "true");
      await withDb(async (db) => {
        const above = await attempt(db, ls.slice(0, at).join("\n"));
        expect(above.error, "the text above the point is complete statements").toBeNull();
        expect(above.results).toBe(fx.before);

        const broken = await attempt(db, insertAt(ls, at, probe));
        expect(broken.error?.message).toBe(probeMessage(unique, "fixture", true));
        expect(broken.error?.code).toBe(INJECT_SQLSTATE);

        const old = legacyInjectPoint(ls);
        if (old !== undefined && old !== at) {
          const wrong = await attempt(db, insertAt(ls, old, probe));
          expect(wrong.error?.code, `the old pick (line ${old}) is not a valid point: ${wrong.error?.message ?? "the probe never raised"}`).not.toBe(INJECT_SQLSTATE);
        }
      });
    });
  }
});
