/**
 * Migration 133 (AI-PRE, before the AI helper is switched on for any company; E9 Q4 and Q6):
 *   - Q6 retention: ai_helper_purge_requests(p_limit) deletes requests (and the suggestion each holds) made more than 12 months ago, for
 *     EVERY company, oldest first, at most p_limit a call; requests younger than that stay, in every company; one audit row per company
 *     it deleted from (a count, no content); the service role only (not admin, office or anon); a bad limit is refused; no signed-in
 *     role may delete a request directly.
 *   - Q4 settle: a request charged in full by 133's stale sweep keeps that charge when its late answer arrives (no refund, no second
 *     charge); one released by the sweep before 133 (cost NULL) still adds its cost, as 103 did. (The sweep itself, through reserve:
 *     tests/db/ai-helper-101.test.ts.)
 *   - supabase/verify/ai_helper_pre_enable_133.sql is TRUE on every row; the rollback puts 103's bodies back and removes the purge.
 * Plain SQL with synthetic rows, inside transactions that are rolled back (nothing is kept), as the 116 suite does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const run = randomUUID().slice(0, 8);
const DIGEST = "a".repeat(64);

/** fn inside one transaction that is always rolled back. */
async function rolledBack<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}
async function org(db: Client, label: string) {
  const id = randomUUID();
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `133 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-133-${label}`]);
  return id;
}
/** A request row made `ageDays` ago, holding a suggestion. */
async function request(db: Client, organization: string, ageDays: number, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const row = { status: "suggested", reserved_pence: 5, cost_pence: 3, model: "claude-opus-5-5", output: { kind: "rfq", lines: [] }, ...extra };
  await db.query(
    `insert into public.ai_helper_requests (id, organization_id, user_id, feature, month, status, input_digest, input_bytes, reserved_pence, cost_pence, model, output, created_at, settled_at)
     values ($1, $2, $3, 'rfq', date_trunc('month', now() - make_interval(days => $4))::date, $5, $6, 10, $7, $8, $9, $10, now() - make_interval(days => $4), now() - make_interval(days => $4))`,
    [id, organization, randomUUID(), ageDays, row.status, DIGEST, row.reserved_pence, row.cost_pence, row.model, row.output === null ? null : JSON.stringify(row.output)]);
  return id;
}
/** One statement as a role: 'service_role', 'authenticated' (a made-up person) or 'anon'; the rows, or the SQLSTATE. */
async function as(db: Client, role: "service_role" | "authenticated" | "anon", sql: string, params: unknown[] = []) {
  await db.query("savepoint s");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(role === "authenticated" ? { sub: randomUUID(), role } : { role })]);
    await db.query(`set local role ${role}`);
    const { rows } = await db.query(sql, params);
    await db.query("reset role");
    await db.query("release savepoint s");
    return { rows, code: null as string | null };
  } catch (err) {
    await db.query("rollback to savepoint s");
    await db.query("reset role");
    return { rows: [], code: (err as { code?: string }).code ?? "?" };
  }
}
const exists = async (db: Client, ids: string[]) => (await db.query<{ id: string }>("select id from public.ai_helper_requests where id = any($1)", [ids])).rows.map((r) => r.id).sort();

beforeAll(async () => {
  await verifyBackendIdentity();
});

describe("133 Q6: AI helper requests are deleted after 12 months, in every company", () => {
  it("old rows of BOTH companies go (oldest first, p_limit at a time); younger rows of both stay; one audit row per company", async () => {
    await rolledBack(async (db) => {
      const a = await org(db, "alpha");
      const b = await org(db, "beta");
      const oldA = [await request(db, a, 400), await request(db, a, 380, { status: "approved" })];
      const oldB = [await request(db, b, 500, { status: "failed", model: null, output: null })];
      const keepA = [await request(db, a, 300), await request(db, a, 0, { status: "reserved", cost_pence: null, model: null, output: null })];
      const keepB = [await request(db, b, 360)];
      // One at a time: the oldest of all companies first (Beta's 500 days).
      expect((await as(db, "service_role", "select public.ai_helper_purge_requests(1) as n")).rows[0].n).toBe(1);
      expect(await exists(db, oldB)).toEqual([]);
      expect(await exists(db, oldA)).toEqual([...oldA].sort());
      // The rest in one call: both of Alpha's old rows; nothing younger than 12 months, in either company.
      expect((await as(db, "service_role", "select public.ai_helper_purge_requests(1000) as n")).rows[0].n).toBe(2);
      expect(await exists(db, [...oldA, ...oldB])).toEqual([]);
      expect(await exists(db, [...keepA, ...keepB])).toEqual([...keepA, ...keepB].sort());
      // Run again: nothing left to delete.
      expect((await as(db, "service_role", "select public.ai_helper_purge_requests(1000) as n")).rows[0].n).toBe(0);
      // audit_log.id is a random uuid, so the rows are ordered by their count (Beta's purge deleted 1, Alpha's 2).
      const audit = (await db.query<{ organization_id: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
        "select organization_id, actor_user_id, metadata from security_audit.audit_log where action = 'ai_helper_requests_purged' and organization_id = any($1) order by (metadata ->> 'deleted')::int",
        [[a, b]])).rows;
      expect(audit.map((r) => [r.organization_id, r.metadata.deleted, r.actor_user_id])).toEqual([[b, 1, null], [a, 2, null]]);
      expect(Object.keys(audit[0].metadata).sort()).toEqual(["created_before", "deleted", "source"]);
    });
  });

  it("the boundary: a request made exactly 12 months ago stays; one a microsecond older goes", async () => {
    await rolledBack(async (db) => {
      // One transaction, so now() is the same here and inside the purge: the cut-off is exactly now() - 12 months.
      const a = await org(db, "edge");
      const exact = await request(db, a, 365);
      const older = await request(db, a, 365);
      await db.query("update public.ai_helper_requests set created_at = now() - interval '12 months', month = date_trunc('month', now() - interval '12 months')::date where id = $1", [exact]);
      await db.query("update public.ai_helper_requests set created_at = now() - interval '12 months' - interval '1 microsecond', month = date_trunc('month', now() - interval '12 months')::date where id = $1", [older]);
      expect((await as(db, "service_role", "select public.ai_helper_purge_requests(1000) as n")).rows[0].n).toBe(1);
      expect(await exists(db, [exact, older])).toEqual([exact]);
    });
  });

  it("only the service role may purge; a bad limit is refused; nobody signed in may delete a request directly", async () => {
    await rolledBack(async (db) => {
      const a = await org(db, "grants");
      const old = await request(db, a, 400);
      expect((await as(db, "authenticated", "select public.ai_helper_purge_requests(10)")).code).toBe("42501");
      expect((await as(db, "anon", "select public.ai_helper_purge_requests(10)")).code).toBe("42501");
      for (const bad of [0, -1, 10001]) expect((await as(db, "service_role", "select public.ai_helper_purge_requests($1)", [bad])).code).toBe("22023");
      expect((await as(db, "service_role", "select public.ai_helper_purge_requests(null)")).code).toBe("22023");
      expect((await as(db, "authenticated", "delete from public.ai_helper_requests where id = $1", [old])).code).toBe("42501");
      expect(await exists(db, [old])).toEqual([old]);
    });
  });
});

describe("133 Q4: a swept request's charge stands", () => {
  it("charged in full by the sweep: the late answer is recorded, spent unchanged; released before 133 (cost NULL): its cost is added", async () => {
    await rolledBack(async (db) => {
      const a = await org(db, "settle");
      await db.query("insert into public.ai_helper_usage (organization_id, month, reserved_pence, spent_pence) values ($1, date_trunc('month', now() at time zone 'Europe/London')::date, 0, 50)", [a]);
      const swept = await request(db, a, 0, { status: "expired", reserved_pence: 9, cost_pence: 9, model: null, output: null });
      const released = await request(db, a, 0, { status: "expired", reserved_pence: 9, cost_pence: null, model: null, output: null });
      await db.query("update public.ai_helper_requests set month = date_trunc('month', now() at time zone 'Europe/London')::date where organization_id = $1", [a]);
      const spent = async () => (await db.query<{ spent_pence: number; reserved_pence: number }>("select spent_pence, reserved_pence from public.ai_helper_usage where organization_id = $1", [a])).rows[0];
      const settle = (id: string, cost: number) => as(db, "service_role", "select public.ai_helper_settle($1, 'suggested', null, $2, 'claude-opus-5-5', '{\"kind\":\"rfq\",\"lines\":[]}'::jsonb)", [id, cost]);
      expect((await settle(swept, 4)).code).toBeNull();
      expect(await spent()).toEqual({ spent_pence: 50, reserved_pence: 0 });
      expect((await db.query("select status, cost_pence from public.ai_helper_requests where id = $1", [swept])).rows[0]).toEqual({ status: "suggested", cost_pence: 9 });
      expect((await settle(swept, 4)).code).toBe("42501"); // once only
      expect((await settle(released, 4)).code).toBeNull();
      expect(await spent()).toEqual({ spent_pence: 54, reserved_pence: 0 });
      expect((await db.query("select status, cost_pence from public.ai_helper_requests where id = $1", [released])).rows[0]).toEqual({ status: "suggested", cost_pence: 4 });
    });
  });
});

describe("133 release files", () => {
  it("verify TRUE on every row; the rollback puts 103's bodies back and removes the purge (rolled back); the release applies again, twice", async () => {
    await withDb(async (db) => {
      const v = (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/ai_helper_pre_enable_133.sql"))).rows;
      expect(v.filter((r) => !r.ok)).toEqual([]);
      expect(v.length).toBe(5);
      await db.query("begin");
      try {
        await db.query(unwrapped(read("supabase/release/133_ai_helper_pre_enable.rollback.sql")));
        expect((await db.query<{ ok: boolean }>(read("supabase/verify/ai_helper_service_role_103.sql"))).rows.every((r) => r.ok)).toBe(true);
        expect((await db.query("select to_regprocedure('public.ai_helper_purge_requests(integer)') is null as gone")).rows[0].gone).toBe(true);
        for (let i = 0; i < 2; i += 1) {
          await db.query(unwrapped(read("supabase/release/133_ai_helper_pre_enable.release.sql")));
          expect((await db.query<{ ok: boolean }>(read("supabase/verify/ai_helper_pre_enable_133.sql"))).rows.every((r) => r.ok)).toBe(true);
        }
      } finally {
        await db.query("rollback");
      }
    });
  });
});
