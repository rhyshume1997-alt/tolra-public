/**
 * The daily clock-in address purge (Vercel Cron, app/api/cron/ip-purge) calls site_network_ip_purge(company, limit) from migration 078
 * with the server's service-role key. Proves, on the real function and its real triggers:
 *   * service_role can run it; anon and authenticated cannot (it is internal);
 *   * it deletes only the company's addresses older than 30 days (oldest first, at most the limit), keeps newer ones and every other
 *     company's, and a second run finds nothing (safe to run twice).
 * Every test runs in a transaction that is rolled back. The kept addresses are inserted with foreign keys off (session_replication_role
 * = replica, owner only) and switched back on before the purge runs, so the purge itself runs under its normal triggers and role.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const PURGE = "select public.site_network_ip_purge($1, $2) as n";

/** Runs `fn` as `role` inside a transaction that is always rolled back, after seeding addresses `days` old for each company. */
async function seeded<T>(rows: { org: string; days: number }[], role: "service_role" | "authenticated" | "anon", fn: (db: Client, ids: string[]) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      const ids: string[] = [];
      for (const [i, r] of rows.entries()) {
        const id = randomUUID();
        ids.push(id);
        await db.query(
          "insert into public.attendance_event_network_ips (event_id, organization_id, user_id, ip, checked_at) values ($1, $2, $3, $4, now() - make_interval(days => $5))",
          [id, r.org, randomUUID(), `203.0.113.${i + 1}`, r.days],
        );
      }
      await db.query("set local session_replication_role = origin");
      await db.query(`set local role ${role}`);
      return await fn(db, ids);
    } finally {
      await db.query("rollback");
    }
  });
}
const left = async (db: Client, ids: string[]) => (await db.query<{ event_id: string }>("select event_id from public.attendance_event_network_ips where event_id = any($1::uuid[])", [ids])).rows.map((r) => r.event_id).sort();

beforeAll(async () => { await verifyBackendIdentity(); });

describe("site_network_ip_purge as the server's service role", () => {
  it("deletes only the company's addresses older than 30 days; newer ones and other companies' stay; a second run finds nothing", async () => {
    const A = randomUUID();
    const B = randomUUID();
    const rows = [{ org: A, days: 40 }, { org: A, days: 31 }, { org: A, days: 29 }, { org: A, days: 1 }, { org: A, days: 0 }, { org: B, days: 45 }, { org: B, days: 2 }];
    await seeded(rows, "service_role", async (db, ids) => {
      const [, , a29, a1, a0, b45, b2] = ids;
      expect((await db.query(PURGE, [A, 500])).rows[0].n).toBe(2);
      expect(await left(db, ids)).toEqual([a29, a1, a0, b45, b2].sort());
      expect((await db.query(PURGE, [A, 500])).rows[0].n).toBe(0);
      expect(await left(db, ids)).toEqual([a29, a1, a0, b45, b2].sort());
      expect((await db.query(PURGE, [B, 500])).rows[0].n).toBe(1);
      expect(await left(db, ids)).toEqual([a29, a1, a0, b2].sort());
    });
  });

  it("takes at most the limit, oldest first", async () => {
    const A = randomUUID();
    await seeded([{ org: A, days: 33 }, { org: A, days: 50 }, { org: A, days: 40 }], "service_role", async (db, ids) => {
      const [d33] = ids;
      expect((await db.query(PURGE, [A, 2])).rows[0].n).toBe(2);
      expect(await left(db, ids)).toEqual([d33]);
      expect((await db.query(PURGE, [A, 2])).rows[0].n).toBe(1);
      expect(await left(db, ids)).toEqual([]);
    });
  });

  it("a company with nothing stored is a no-op", async () => {
    await seeded([], "service_role", async (db) => {
      expect((await db.query(PURGE, [randomUUID(), 500])).rows[0].n).toBe(0);
    });
  });
});

describe("site_network_ip_purge is internal", () => {
  it.each(["anon", "authenticated"] as const)("%s cannot purge", async (role) => {
    const A = randomUUID();
    await seeded([{ org: A, days: 40 }], role, async (db) => {
      await expect(db.query(PURGE, [A, 500])).rejects.toMatchObject({ code: "42501" });
    });
  });
});
