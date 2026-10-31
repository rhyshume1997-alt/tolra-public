/**
 * Migration 116: the Overview's nightly money-owed snapshots.
 *
 *   - capture_overview_owed() writes one row per company for TODAY (London), with the app's own owed rule (lib/receivables owed()):
 *     drafts, paid, void, cancelled, credited and written-off invoices and unconfirmed imports are not owed; late = due before today.
 *     Run again the same day it replaces that day's row (still one row). It takes no date, so no past day can be made up.
 *   - Only the service role may run it: not an admin, not office, not anon (privilege and a real call).
 *   - Two companies: each company's admin reads only their own company's rows; office and workshop read nothing; nobody signed in can
 *     insert, change or delete a row.
 *   - supabase/verify/overview_owed_snapshots_116.sql answers TRUE on every row; the rollback removes both objects (inside a transaction
 *     that is rolled back).
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 093, 101 and 103 suites do.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

const londonDay = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `116 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-116-${label}-${counter}`]);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $2, $3, $4, true, false)`, [p.id, p.email, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

/** One API request as the person (role authenticated, their claims), in its own transaction. */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

/** One call as the server's service role (no person), in its own transaction. */
async function asService<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

/** One call as anon (nobody signed in). */
async function asAnon<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role anon");
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { code?: string; message: string };
  }
};
const rows = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);

const W = { A: "", B: "", aAdmin: person("a-admin"), aOffice: person("a-office"), aWorkshop: person("a-workshop"), bAdmin: person("b-admin") };

async function invoice(db: Client, org: string, ref: string, fields: { status: string; total: number; due?: string | null; paid?: number; credited?: number; refunded?: number; unverified?: boolean }) {
  await db.query(
    `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified)
     values ($1, $2, 'Owed Co', $3, 0, $3, $4, $5, $6, $7, $8, $9)`,
    [org, ref, fields.total, fields.status, fields.paid ?? 0, fields.credited ?? 0, fields.refunded ?? 0, fields.due ?? null, fields.unverified ?? false]);
}

const snapshotOf = (org: string) => rows<{ snapshot_date: string; owed: number; late: number }>(
  "select to_char(snapshot_date, 'YYYY-MM-DD') as snapshot_date, owed_amount::float as owed, late_amount::float as late from public.overview_owed_snapshots where organization_id = $1 order by snapshot_date", [org]);

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.B = await makeOrg(db, "b");
    await member(db, W.A, W.aAdmin, "admin");
    await member(db, W.A, W.aOffice, "office");
    await member(db, W.A, W.aWorkshop, "workshop");
    await member(db, W.B, W.bAdmin, "admin");
    // Company A: 1,000 late (due yesterday), 400 of 500 still owed and not yet due, 50 owed on a part-credited, part-refunded one
    // with no due date. Not owed: a draft, a paid one, a void one, a credited one, a written-off one, an unconfirmed import.
    await invoice(db, W.A, `INV-116-A1-${run}`, { status: "sent", total: 1000, due: londonDay(-1) });
    await invoice(db, W.A, `INV-116-A2-${run}`, { status: "partial", total: 500, paid: 100, due: londonDay(5) });
    await invoice(db, W.A, `INV-116-A3-${run}`, { status: "sent", total: 300, credited: 300, refunded: 50 });
    await invoice(db, W.A, `INV-116-A4-${run}`, { status: "draft", total: 900, due: londonDay(-9) });
    await invoice(db, W.A, `INV-116-A5-${run}`, { status: "paid", total: 800, paid: 800, due: londonDay(-9) });
    await invoice(db, W.A, `INV-116-A6-${run}`, { status: "void", total: 700, due: londonDay(-9) });
    await invoice(db, W.A, `INV-116-A7-${run}`, { status: "credited", total: 600, due: londonDay(-9) });
    await invoice(db, W.A, `INV-116-A8-${run}`, { status: "written_off", total: 500, due: londonDay(-9) });
    await invoice(db, W.A, `INV-116-A9-${run}`, { status: "sent", total: 400, due: londonDay(-9), unverified: true });
    // Company B: 250 owed, due today (due today is not late).
    await invoice(db, W.B, `INV-116-B1-${run}`, { status: "sent", total: 250, due: londonDay(0) });
  });
});

afterAll(async () => {
  await withDb((db) => db.query("delete from public.overview_owed_snapshots where organization_id = any($1::uuid[])", [[W.A, W.B]]));
  await destroySyntheticWorld(run);
});

describe("116: the capture", () => {
  it("writes today (London) for every company with the app's owed rule; late is due before today", async () => {
    const written = await asService((db) => db.query<{ n: number }>("select public.capture_overview_owed() as n"));
    const companies = Number((await rows<{ n: string }>("select count(*)::text as n from public.organizations"))[0].n);
    expect(written.rows[0].n).toBe(companies);
    expect(await snapshotOf(W.A)).toEqual([{ snapshot_date: londonDay(0), owed: 1450, late: 1000 }]);
    expect(await snapshotOf(W.B)).toEqual([{ snapshot_date: londonDay(0), owed: 250, late: 0 }]);
  });

  it("run again the same day it replaces that day's figures: still one row, the later balance", async () => {
    // The late invoice is paid in full (as the database owner, so no API guard applies): nothing is owed on it any more.
    await withDb((db) => db.query("update public.invoices set amount_paid = 1000 where invoice_ref = $1", [`INV-116-A1-${run}`]));
    await asService((db) => db.query("select public.capture_overview_owed()"));
    expect(await snapshotOf(W.A)).toEqual([{ snapshot_date: londonDay(0), owed: 450, late: 0 }]);
  });

  it("takes no date, so no past day can be made up from today's balances", async () => {
    const [fn] = await rows<{ args: number }>("select pronargs::int as args from pg_proc where oid = to_regprocedure('public.capture_overview_owed()')");
    expect(fn).toEqual({ args: 0 });
  });

  it("only the service role may run it: not an admin, office, workshop or anon", async () => {
    const [grants] = await rows<{ anon: boolean; authed: boolean; service: boolean; pub: boolean }>(
      "select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authed, " +
      "has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service, " +
      "exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub",
      ["public.capture_overview_owed()"]);
    expect(grants).toEqual({ anon: false, authed: false, service: true, pub: false });
    for (const p of [W.aAdmin, W.aOffice, W.aWorkshop, W.bAdmin]) {
      expect(await errorOf(as(p, (db) => db.query("select public.capture_overview_owed()")))).toMatchObject({ code: "42501" });
    }
    expect(await errorOf(asAnon((db) => db.query("select public.capture_overview_owed()")))).toMatchObject({ code: "42501" });
  });
});

describe("116: who reads, and nobody writes", () => {
  it("each company's admin reads only their own company's rows", async () => {
    const aRows = await as(W.aAdmin, async (db) => (await db.query<{ organization_id: string }>("select organization_id from public.overview_owed_snapshots")).rows);
    expect(aRows.length).toBeGreaterThan(0);
    expect(new Set(aRows.map((r) => r.organization_id))).toEqual(new Set([W.A]));
    const bRows = await as(W.bAdmin, async (db) => (await db.query<{ organization_id: string }>("select organization_id from public.overview_owed_snapshots")).rows);
    expect(new Set(bRows.map((r) => r.organization_id))).toEqual(new Set([W.B]));
  });

  it("office and workshop read nothing (the Overview is admin only); anon may not read at all", async () => {
    for (const p of [W.aOffice, W.aWorkshop]) {
      expect(await as(p, async (db) => (await db.query("select 1 from public.overview_owed_snapshots")).rows.length)).toBe(0);
    }
    expect(await errorOf(asAnon((db) => db.query("select 1 from public.overview_owed_snapshots")))).toMatchObject({ code: "42501" });
  });

  it("nobody signed in can insert, change or delete a row, not even their own company's admin", async () => {
    const before = await snapshotOf(W.A);
    for (const p of [W.aAdmin, W.aOffice]) {
      expect(await errorOf(as(p, (db) => db.query("insert into public.overview_owed_snapshots (organization_id, snapshot_date, owed_amount, late_amount) values ($1, $2, 1, 0)", [W.A, londonDay(-30)])))).toMatchObject({ code: "42501" });
      expect(await errorOf(as(p, (db) => db.query("update public.overview_owed_snapshots set owed_amount = 0 where organization_id = $1", [W.A])))).toMatchObject({ code: "42501" });
      expect(await errorOf(as(p, (db) => db.query("delete from public.overview_owed_snapshots where organization_id = $1", [W.A])))).toMatchObject({ code: "42501" });
    }
    expect(await snapshotOf(W.A)).toEqual(before);
  });
});

describe("116: verify and rollback", () => {
  it("the verify script answers TRUE on every row", async () => {
    const result = await rows<{ check_name: string; ok: boolean }>(read("supabase/verify/overview_owed_snapshots_116.sql"));
    expect(result).toHaveLength(6);
    expect(result.filter((r) => !r.ok).map((r) => r.check_name)).toEqual([]);
  });

  it("the rollback removes the table and the function (inside a transaction that is rolled back), and the release applies again", async () => {
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query(unwrapped(read("supabase/release/116_overview_owed_snapshots.rollback.sql")));
        const gone = await db.query<{ t: string | null; f: string | null }>("select to_regclass('public.overview_owed_snapshots')::text as t, to_regprocedure('public.capture_overview_owed()')::text as f");
        expect(gone.rows[0]).toEqual({ t: null, f: null });
        await db.query(unwrapped(read("supabase/release/116_overview_owed_snapshots.release.sql")));
        const back = await db.query<{ t: string | null }>("select to_regclass('public.overview_owed_snapshots')::text as t");
        expect(back.rows[0].t).toBe("overview_owed_snapshots");
      } finally {
        await db.query("rollback");
      }
    });
    expect((await rows<{ t: string | null }>("select to_regclass('public.overview_owed_snapshots')::text as t"))[0].t).toBe("overview_owed_snapshots");
  });
});
