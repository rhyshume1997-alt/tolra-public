/**
 * Release 152, the proofs that need WHOLE-DATABASE copies, so they are not part of CI (CI's Supabase stack has one database):
 *   - restore of a backup taken BEFORE the import, then the import again (identical counts, balances, counters, numbering, the same
 *     source keys with the same names and numbers, the same original file hashes in the audit rows, reconcile PASS, re-run no change);
 *   - restore of a backup taken AFTER the import, then the import again (nothing added, the same record ids);
 *   - the rollback on an installed clone: (a) empty map, everything removed; (b) with map rows, refused, all intact; (c) a second
 *     rollback refused; (d) reinstall verifies.
 * Run by hand on a LOCAL Postgres only (it refuses any other host): the template must have 145..152 applied and no connections.
 *   SLIQ152_ADMIN_URL=postgres://postgres@127.0.0.1:55591/postgres SLIQ152_TEMPLATE=sliq152tpl npx vitest run --config vitest.local.config.ts
 * Without those two variables it FAILS (it is never silently skipped).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sourceTotalsFromValidated, validateAndBuild } from "@/lib/sliq-import-build";
import { type Rpc, type SliqPayload, sliqRunBatches } from "@/lib/sliq-import-route";
import { type DbRow, reconcile } from "@/lib/sliq-reconcile/reconcile";
import type { ValidationReport } from "@/lib/sliq-validate";
import { assertLoopbackUrl } from "../support/isolation";
import { MAPPING, N_INV, syntheticFiles } from "../support/sliq-152";

const ADMIN_URL = assertLoopbackUrl("SLIQ152_ADMIN_URL", process.env.SLIQ152_ADMIN_URL);
const TEMPLATE = process.env.SLIQ152_TEMPLATE ?? "";
if (!/^[a-z0-9_]+$/.test(TEMPLATE)) throw new Error("SLIQ152_TEMPLATE must name a local database with 145..152 applied");
const dbUrl = (name: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; return u.toString(); };
const base = `sliq152_c_${Date.now()}`;
const org = randomUUID();
const uid = randomUUID();
const claims = (sub: string) => ({ sub, role: "authenticated", aal: "aal2", email: `${sub.slice(0, 8)}@example.test` });

let admin: Client;
let pool: Pool;
let work = "";
let payload: SliqPayload;
let report: ValidationReport;
let first: Record<string, unknown>;
let firstIdentity: { k: string; id: string }[] = [];
let countersBefore: Record<string, number> = {};

async function openWork(name: string) { work = name; pool = new Pool({ connectionString: dbUrl(name), max: 4 }); }
async function closeWork() { await pool.end(); }
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
const rpc = (): Rpc => async (fn, args) => {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(uid)), uid]);
    const names = Object.keys(args);
    const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
    const { rows } = await db.query(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`, values);
    await db.query("commit");
    return { data: rows[0].r, error: null };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    const err = e as { message: string; code?: string; hint?: string };
    return { data: null, error: { message: err.message, code: err.code, hint: err.hint } };
  } finally { db.release(); }
};
async function state() {
  const [r] = await q(`select
    (select count(*) from customers where organization_id = $1)::int as customers,
    (select count(*) from suppliers where organization_id = $1)::int as suppliers,
    (select count(*) from invoices where organization_id = $1)::int as invoices,
    (select count(*) from invoice_payments where organization_id = $1)::int as payments,
    (select coalesce(sum(total), 0)::text from invoices where organization_id = $1) as invoiced,
    (select coalesce(sum(amount_paid), 0)::text from invoices where organization_id = $1) as paid,
    (select coalesce(sum(amount), 0)::text from invoice_payments where organization_id = $1) as payments_sum,
    (select count(*) from credit_notes where organization_id = $1)::int as credit_notes,
    (select count(*) from invoices v where organization_id = $1 and amount_paid <> coalesce((select sum(p.amount) from invoice_payments p where p.invoice_id = v.id), 0))::int as paid_mismatch,
    (select count(*) from (select lower(name) from customers where organization_id = $1 group by 1 having count(*) > 1) d)::int as dup_customers,
    (select count(*) from (select invoice_ref from invoices where organization_id = $1 group by 1 having count(*) > 1) d)::int as dup_invoices,
    (select last from doc_counters where organization_id = $1 and prefix = 'INV') as inv_counter,
    (select count(*) from import_source_rows where organization_id = $1)::int as map_rows,
    (select count(*) from import_source_batches where organization_id = $1)::int as batches`, [org]);
  return r;
}
async function identity() {
  return q<{ k: string; id: string }>(`select m.entity || '|' || m.source_row_id || '|' || coalesce(c.name, s.name, v.invoice_ref || '|' || v.customer, y.amount::text, n.credit_ref) as k,
      coalesce(m.customer_id, m.supplier_id, m.invoice_id, m.payment_id, m.credit_note_id)::text as id
    from import_source_rows m left join customers c on c.id = m.customer_id left join suppliers s on s.id = m.supplier_id
    left join invoices v on v.id = m.invoice_id left join invoice_payments y on y.id = m.payment_id left join credit_notes n on n.id = m.credit_note_id
    where m.organization_id = $1 order by 1`, [org]);
}
async function auditHashes() {
  const rows = await q<{ m: { source_sha256: string; source_files: { name: string; sha256: string }[] } }>(`select metadata as m from security_audit.audit_log where organization_id = $1 and action = 'IMPORT_SOURCE_BATCH'`, [org]);
  return [...new Set(rows.map((r) => `${r.m.source_sha256}|${r.m.source_files.map((f) => `${f.name}:${f.sha256}`).sort().join(",")}`))];
}
async function reconcileNow() {
  const rows = ((await rpc()("import_sliq_reconcile", {})).data as { rows: DbRow[] }).rows;
  return reconcile(sourceTotalsFromValidated(report, payload), rows, { countersBefore });
}

describe("release 152 on whole-database copies: restore, then import again", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${base} template ${TEMPLATE}`);
    await openWork(base);
    await q("insert into organizations (id, name, slug, status) values ($1, 'Synthetic SliQ clones', $2, 'active')", [org, `t-${base}`]);
    await q("insert into auth.users (id, email) values ($1, $2)", [uid, `${uid.slice(0, 8)}@example.test`]);
    await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', 'admin', $3, true, false)", [uid, `${uid.slice(0, 8)}@example.test`, org]);
    await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, 'admin', true)", [org, uid]);
    await q("insert into doc_counters (organization_id, prefix, last) values ($1, 'DLN', 12), ($1, 'QUO', 3)", [org]);
    const built = await validateAndBuild(syntheticFiles(), MAPPING);
    expect(built.report.ok).toBe(true);
    report = built.report;
    payload = built.payload!;
    countersBefore = { DLN: 12, QUO: 3 };
    // The "backup taken before the import": a copy of the whole database as it is now.
    await closeWork();
    await admin.query(`create database ${base}_pre template ${base}`);
    await openWork(base);
    const run = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    first = await state();
    firstIdentity = await identity();
    expect((await reconcileNow()).pass).toBe(true);
    expect(String((await rpc()("next_doc_number", { p_prefix: "INV" })).data)).toBe(`INV-${1001 + N_INV}`);
  });

  afterAll(async () => {
    if (pool) await closeWork().catch(() => undefined);
    if (admin) {
      for (const { datname } of (await admin.query("select datname from pg_database where datname like $1", [`${base}%`])).rows) await admin.query(`drop database if exists ${datname}`);
      await admin.end();
    }
  });

  it("restore of a backup taken BEFORE the import, then the import again: identical counts, balances, counters, numbering", async () => {
    // The whole database restored from the copy taken before the import (beforeAll): data, map, batches and counters as they were.
    await closeWork();
    await admin.query(`create database ${base}_r template ${base}_pre`);
    await openWork(`${base}_r`);
    expect(await state()).toMatchObject({ customers: 0, invoices: 0, payments: 0, map_rows: 0, batches: 0 });
    const run = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    const s = await state();
    expect({ ...s, batches: 0 }).toMatchObject({ customers: first.customers, suppliers: first.suppliers, invoices: first.invoices, payments: first.payments,
      invoiced: first.invoiced, paid: first.paid, payments_sum: first.payments_sum, paid_mismatch: 0, dup_customers: 0, dup_invoices: 0, inv_counter: 1000 + N_INV });
    const next = await rpc()("next_doc_number", { p_prefix: "INV" });
    expect(next.data).toBe(`INV-${1001 + N_INV}`);
    // Stable identifiers: every customer, supplier, invoice, payment and credit note is under the same source key with the same name or
    // number as the first import (record ids are new: the restore removed them); the audit rows carry the same original file hashes.
    expect((await identity()).map((r) => r.k)).toEqual(firstIdentity.map((r) => r.k));
    expect(await auditHashes()).toEqual([`${payload.source_sha256}|${payload.source_files.map((f) => `${f.name}:${f.sha256}`).sort().join(",")}`]);
    expect((await reconcileNow()).pass).toBe(true);
    // And again on the restored copy: already imported, no change.
    const before = await state();
    const again = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(again.results.every((r) => r.already_imported)).toBe(true);
    expect(await state()).toEqual(before);
  });

  it("restore of a backup taken AFTER the import, then the import again: nothing added", async () => {
    await closeWork();
    const after = `${base}_after`;
    await admin.query(`create database ${after} template ${work}`);
    await openWork(after);
    const before = await state();
    const ids = await identity();
    const run = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(run.results.every((r) => r.already_imported)).toBe(true);
    expect(await state()).toEqual(before);
    // Same records, same ids, same keys after the restore and the re-run.
    expect(await identity()).toEqual(ids);
  });
});

describe("release 152 rollback on an installed clone", () => {
  const rb = `sliq152_rb_${Date.now()}`;
  let a: Client;
  const run = async (db: string, file: string) => {
    const c = new Client({ connectionString: dbUrl(db) });
    await c.connect();
    try { await c.query(readFileSync(path.resolve(__dirname, "../..", file), "utf8")); return "ok"; } catch (e) { return (e as Error).message; } finally { await c.end(); }
  };
  const one = async <T,>(db: string, sql: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: dbUrl(db) });
    await c.connect();
    try { return (await c.query(sql, params)).rows as T[]; } finally { await c.end(); }
  };
  const objects = (db: string) => one<{ t: number; f: number }>(db, `select (select count(*) from pg_class where relname in ('import_source_rows', 'import_source_batches'))::int as t,
    (select count(*) from pg_proc where proname like 'import_sliq%' or proname like 'import_source%')::int as f`).then((r) => r[0]);
  const verify = async (db: string) => (await one<{ ok: boolean }>(db, readFileSync(path.resolve(__dirname, "../../supabase/verify/sliq_import_route_152.sql"), "utf8"))).map((r) => r.ok);

  beforeAll(async () => {
    a = new Client({ connectionString: ADMIN_URL });
    await a.connect();
    await a.query(`create database ${rb}_empty template ${TEMPLATE}`);
    await a.query(`create database ${rb}_data template ${TEMPLATE}`);
  });
  afterAll(async () => {
    if (!a) return;
    for (const { datname } of (await a.query("select datname from pg_database where datname like $1", [`${rb}%`])).rows) await a.query(`drop database if exists ${datname}`);
    await a.end();
  });

  it("(a) empty map: everything 152 made is removed; (c) a second rollback refuses; (d) reinstalling works and verifies", async () => {
    expect(await objects(`${rb}_empty`)).toEqual({ t: 2, f: 12 });
    expect(await run(`${rb}_empty`, "supabase/release/152_sliq_import_route.rollback.sql")).toBe("ok");
    expect(await objects(`${rb}_empty`)).toEqual({ t: 0, f: 0 });
    expect(await run(`${rb}_empty`, "supabase/release/152_sliq_import_route.rollback.sql")).toBe("152 rollback: release 152 is not installed");
    expect(await run(`${rb}_empty`, "supabase/release/152_sliq_import_route.release.sql")).toBe("ok");
    expect(await verify(`${rb}_empty`)).toEqual([true, true, true, true, true, true, true, true]);
    expect(await objects(`${rb}_empty`)).toEqual({ t: 2, f: 12 });
  });

  it("(b) with map rows: refuses with the operator's instruction, and leaves every object and row as it was", async () => {
    const o = (await one<{ id: string }>(`${rb}_data`, "insert into organizations (name, slug) values ('RB', 'rb-152') returning id"))[0].id;
    const cust = (await one<{ id: string }>(`${rb}_data`, "insert into customers (organization_id, name) values ($1, 'Mapped Ltd') returning id", [o]))[0].id;
    // A committed batch and its map row, written as the batch would (the guard trigger checks the record's company).
    await one(`${rb}_data`, `insert into import_source_batches (organization_id, source_sha256, run_label, entity, batch_no, request_sha256, import_batch_id, rows_in, rows_created, rows_already, result)
      values ($1, repeat('a', 64), 'live', 'customers', 1, repeat('b', 64), null, 1, 0, 1, '{}')`, [o]);
    await one(`${rb}_data`, `insert into import_source_rows (organization_id, entity, source_row_id, source_sha256, run_label, batch_entity, batch_no, customer_id)
      values ($1, 'customer', 'C:M1', repeat('a', 64), 'live', 'customers', 1, $2)`, [o, cust]);
    const before = await objects(`${rb}_data`);
    const message = await run(`${rb}_data`, "supabase/release/152_sliq_import_route.rollback.sql");
    expect(message).toBe("152 rollback: SliQ import map rows exist; dropping them would separate the map from the data. Nothing was changed. Keep 152, or restore the backup taken before the SliQ import and run this rollback again; never delete map rows by hand.");
    expect(await objects(`${rb}_data`)).toEqual(before);
    expect((await one<{ n: number }>(`${rb}_data`, "select count(*)::int as n from import_source_rows"))[0].n).toBe(1);
    expect((await one<{ n: number }>(`${rb}_data`, "select count(*)::int as n from customers where id = $1", [cust]))[0].n).toBe(1);
    expect(await verify(`${rb}_data`)).toEqual([true, true, true, true, true, true, true, true]);
  });
});
