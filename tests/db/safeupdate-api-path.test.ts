/**
 * pg-safeupdate through the ACTUAL API execution path (PostgREST of the disposable Supabase stack), as the reviewer requires: an
 * UPDATE or DELETE sent without any filter must be refused by the database ("UPDATE requires a WHERE clause", SQLSTATE 21000) and
 * change nothing. A direct database session cannot prove this on the CLI stack (the `postgres` role may not LOAD safeupdate, see
 * tests/support/safeupdate-session.ts), so the proof is made over HTTP with the service-role key against a throwaway table that this
 * file creates and drops. A filtered UPDATE through the same path is the positive control: it must work.
 *
 * Runs wherever the disposable API is configured; in CI (env CI) an unconfigured API is a failure, not a skip.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

const API = (() => {
  try { isolatedBackend(); return true; } catch { return false; }
})();
const table = `zz_safeupdate_probe_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

async function rest(method: string, query: string, body?: unknown) {
  const backend = isolatedBackend();
  const res = await fetch(`${backend.apiUrl}/rest/v1/${table}${query}`, {
    method,
    headers: { apikey: backend.serviceRoleKey, authorization: `Bearer ${backend.serviceRoleKey}`, "content-type": "application/json", prefer: "return=minimal" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: { code?: string; message?: string } | null = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}
const rows = () => withDb(async (db) => (await db.query<{ id: number; v: string }>(`select id, v from public.${table} order by id`)).rows);

describe.runIf(API)("safeupdate through the real API path", () => {
  beforeAll(async () => {
    await withDb(async (db) => {
      await db.query(`create table public.${table} (id int primary key, v text not null)`);
      await db.query(`insert into public.${table} values (1, 'a'), (2, 'b')`);
      await db.query("notify pgrst, 'reload schema'");
    });
    // PostgREST learns the new table from the notification; wait until it answers for it.
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      ready = (await rest("GET", "?select=id")).status === 200;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(ready, "PostgREST did not pick up the probe table").toBe(true);
  }, 60_000);

  afterAll(async () => {
    await withDb(async (db) => { await db.query(`drop table if exists public.${table}`); await db.query("notify pgrst, 'reload schema'"); }).catch(() => undefined);
  });

  it("positive control: an UPDATE with its own filter works through the API", async () => {
    const res = await rest("PATCH", "?id=eq.1", { v: "changed" });
    expect([200, 204]).toContain(res.status);
    expect(await rows()).toEqual([{ id: 1, v: "changed" }, { id: 2, v: "b" }]);
  });

  it("an UPDATE without any filter is refused by safeupdate and changes nothing", async () => {
    const res = await rest("PATCH", "", { v: "everything" });
    expect(res.status).toBe(400);
    expect(res.json?.code).toBe("21000");
    expect(res.json?.message ?? "").toMatch(/requires a WHERE clause/i);
    expect(await rows()).toEqual([{ id: 1, v: "changed" }, { id: 2, v: "b" }]);
  });

  it("a DELETE without any filter is refused by safeupdate and deletes nothing", async () => {
    const res = await rest("DELETE", "");
    expect(res.status).toBe(400);
    expect(res.json?.code).toBe("21000");
    expect(res.json?.message ?? "").toMatch(/requires a WHERE clause/i);
    expect(await rows()).toHaveLength(2);
  });
});

describe.runIf(!API)("safeupdate through the real API path: backend not configured", () => {
  it("is a failure in CI and the only skip-equivalent locally", () => {
    if (process.env.CI) throw new Error("The disposable API is not configured in CI: the safeupdate API-path proof did not run");
    expect(API).toBe(false);
  });
});
