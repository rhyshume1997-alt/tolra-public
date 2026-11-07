/**
 * p152 (supabase/proposals/p152_sliq_import_route.sql): the SliQ go-live import route, end to end below PostgREST.
 *
 * Synthetic SliQ-shaped CSV files -> lib/sliq-validate (must be ok) -> lib/sliq-import-build -> lib/sliq-import-route (preflight,
 * planned batches) -> import_sliq_preflight / import_sliq_batch, each call ONE transaction as the `authenticated` role with an admin's
 * JWT claims (as PostgREST runs it). Proves: preflight writes nothing; twice-run changes nothing; a killed batch and a failed batch
 * leave nothing and a retry completes once; the map and the data can't diverge (map kept / data wiped refuses loudly, map lost / data
 * kept refuses, never duplicates); counters only rise and numbering continues; balances equal the source; restore -> import again
 * gives identical results; the company comes from the session only; MFA, role and support rules hold; the definer census of p152.
 *
 * Runs only where SLIQ152_ADMIN_URL (a loopback superuser URL) and SLIQ152_TEMPLATE (a database with p152 applied, no connections)
 * are set: p152 is a proposal, not in supabase/release-plan.json, so CI's database has no p152 and this file is skipped there.
 * Not PostgREST: request size limits, the 8 s statement_timeout of the hosted API and its error mapping are not proved here.
 */
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertLoopbackUrl } from "../support/isolation";
import { validateSliqExport } from "@/lib/sliq-validate";
import { buildSliqPayload, sourceTotalsFromPayload } from "@/lib/sliq-import-build";
import { type DbRow, reconcile } from "@/lib/sliq-reconcile/reconcile";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Rpc, type SliqBatchResult, type SliqPayload, planSliqBatches, sliqPreflight, sliqRunBatches } from "@/lib/sliq-import-route";

const ADMIN_URL = process.env.SLIQ152_ADMIN_URL;
const TEMPLATE = process.env.SLIQ152_TEMPLATE;
const enabled = Boolean(ADMIN_URL && TEMPLATE);

const enc = new TextEncoder();
const MAPPING = {
  version: 1, confirmed: true, dateFormat: "DD/MM/YYYY",
  entities: {
    customers: { file: "customers.csv", columns: { key: "Account", name: "Name" } },
    suppliers: { file: "suppliers.csv", columns: { key: "Account", name: "Name" } },
    invoices: { file: "invoices.csv", columns: { ref: "Invoice No", customerKey: "Account", date: "Date", gross: "Gross", net: "Net", vat: "VAT" } },
    payments: { file: "payments.csv", columns: { key: "Receipt", invoiceRef: "Invoice No", date: "Date", amount: "Amount" } },
  },
};
const N_INV = 60;
/** Synthetic SliQ export: 12 customers, 3 suppliers, 60 invoices INV-1001..1060, payments: full, part, two-part, none. */
function syntheticFiles() {
  const cust = ["Account,Name", ...Array.from({ length: 12 }, (_, i) => `ACC${String(i + 1).padStart(3, "0")},Synthetic Customer ${i + 1} Ltd`)].join("\r\n");
  const supp = ["Account,Name", "SUP001,Synthetic Steel Ltd", "SUP002,Synthetic Tools Ltd", "SUP003,Synthetic Carriers Ltd"].join("\r\n");
  const inv: string[] = ["Invoice No,Account,Date,Net,VAT,Gross"];
  const pay: string[] = ["Receipt,Invoice No,Date,Amount"];
  let receipt = 0;
  for (let i = 0; i < N_INV; i += 1) {
    const ref = `INV-${1001 + i}`;
    const net = 100 * (i + 1) + 0.5;
    const vat = Math.round(net * 20) / 100;
    const gross = Math.round((net + vat) * 100) / 100;
    inv.push(`${ref},ACC${String((i % 12) + 1).padStart(3, "0")},${String((i % 28) + 1).padStart(2, "0")}/0${(i % 9) + 1}/2026,${net.toFixed(2)},${vat.toFixed(2)},${gross.toFixed(2)}`);
    const date = `${String((i % 28) + 1).padStart(2, "0")}/10/2026`;
    if (i % 4 === 0) pay.push(`R${++receipt},${ref},${date},${gross.toFixed(2)}`);
    else if (i % 4 === 1) pay.push(`R${++receipt},${ref},${date},${(Math.round(gross * 50) / 100).toFixed(2)}`);
    else if (i % 4 === 2) {
      const half = Math.round(gross * 50) / 100;
      // The second part on a later date: lib/sliq-reconcile counts two receipts with the same invoice, date and amount as a duplicate group.
      pay.push(`R${++receipt},${ref},${date},${half.toFixed(2)}`, `R${++receipt},${ref},${date.replace("/10/", "/11/")},${(Math.round((gross - half) * 100) / 100).toFixed(2)}`);
    }
  }
  const f = (name: string, text: string) => ({ name, bytes: enc.encode(text + "\r\n") });
  return { customers: f("customers.csv", cust), suppliers: f("suppliers.csv", supp), invoices: f("invoices.csv", inv.join("\r\n")), payments: f("payments.csv", pay.join("\r\n")) };
}

let admin: Client;
let work = "";
const base = `sliq152_t_${Date.now()}`;
let pool: Pool;
let payload: SliqPayload;
const org = randomUUID();
const otherOrg = randomUUID();
const uid = randomUUID();
const otherUid = randomUUID();
const officeUid = randomUUID();
const dbUrl = (name: string) => { const u = new URL(ADMIN_URL!); u.pathname = `/${name}`; return u.toString(); };
const claims = (sub: string, aal = "aal2") => ({ sub, role: "authenticated", aal, email: `${sub.slice(0, 8)}@example.test` });

async function openWork(name: string) {
  work = name;
  pool = new Pool({ connectionString: dbUrl(name), max: 4 });
}
async function closeWork() { await pool.end(); }

/** rpc(fn, namedArgs) as PostgREST would run it: one transaction, role authenticated, the caller's claims. */
function rpcAs(sub: string | null, aal = "aal2", role = "authenticated"): Rpc {
  return async (fn, args) => {
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query(`set local role ${role}`);
      if (sub) await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(sub, aal)), sub]);
      const names = Object.keys(args);
      const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
      const { rows } = await db.query(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`, values);
      await db.query("commit");
      return { data: rows[0].r, error: null };
    } catch (e) {
      await db.query("rollback").catch(() => undefined);
      const err = e as { message: string; code?: string; hint?: string };
      return { data: null, error: { message: err.message, code: err.code, hint: err.hint } };
    } finally {
      db.release();
    }
  };
}
const rpc = () => rpcAs(uid);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}

/** Everything the import can change for the company, as text: counts, money, counters, map, audit rows. */
async function state(o = org) {
  const [r] = await q(`select
    (select count(*) from customers where organization_id = $1)::int as customers,
    (select count(*) from suppliers where organization_id = $1)::int as suppliers,
    (select count(*) from invoices where organization_id = $1)::int as invoices,
    (select count(*) from invoice_payments where organization_id = $1)::int as payments,
    (select coalesce(sum(total), 0)::text from invoices where organization_id = $1) as invoiced,
    (select coalesce(sum(amount_paid), 0)::text from invoices where organization_id = $1) as paid,
    (select coalesce(sum(amount), 0)::text from invoice_payments where organization_id = $1) as payments_sum,
    (select count(*) from invoices v where organization_id = $1 and amount_paid <> coalesce((select sum(p.amount) from invoice_payments p where p.invoice_id = v.id), 0))::int as paid_mismatch,
    (select count(*) from (select lower(name) from customers where organization_id = $1 group by 1 having count(*) > 1) d)::int as dup_customers,
    (select count(*) from (select invoice_ref from invoices where organization_id = $1 group by 1 having count(*) > 1) d)::int as dup_invoices,
    (select last from doc_counters where organization_id = $1 and prefix = 'INV') as inv_counter,
    (select count(*) from import_source_rows where organization_id = $1)::int as map_rows,
    (select count(*) from import_source_batches where organization_id = $1)::int as batches`, [o]);
  return r;
}

async function wipeData(o = org) {
  // As the owner, the way a wipe runbook would: payments, invoices, customers, suppliers (their map rows go with them, ON DELETE CASCADE).
  await q(`begin; select set_config('quoteflow.data_import_undo', '${o}', true);
    delete from invoice_payments where organization_id = '${o}'; delete from invoice_line_items where organization_id = '${o}';
    delete from invoices where organization_id = '${o}'; delete from customers where organization_id = '${o}'; delete from suppliers where organization_id = '${o}'; commit;`);
}

describe.skipIf(!enabled)("p152 SliQ import route", () => {
  beforeAll(async () => {
    assertLoopbackUrl("SLIQ152_ADMIN_URL", ADMIN_URL);
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${base} template ${TEMPLATE}`);
    await openWork(base);
    for (const [o, u, role] of [[org, uid, "admin"], [otherOrg, otherUid, "admin"]] as const) {
      await q("insert into organizations (id, name, slug) values ($1, $2, $3)", [o, `Synthetic ${o.slice(0, 8)}`, `syn-${o.slice(0, 8)}`]);
      await q("insert into auth.users (id, email) values ($1, $2)", [u, `${u.slice(0, 8)}@example.test`]);
      await q("insert into user_profiles (id, email, organization_id) values ($1, $2, $3)", [u, `${u.slice(0, 8)}@example.test`, o]);
      await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, $3, true)", [o, u, role]);
    }
    await q("insert into auth.users (id, email) values ($1, $2)", [officeUid, "office@example.test"]);
    await q("insert into user_profiles (id, email, organization_id) values ($1, $2, $3)", [officeUid, "office@example.test", org]);
    await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, 'office', true)", [org, officeUid]);

    const files = syntheticFiles();
    const report = validateSliqExport({ files, mapping: MAPPING });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    payload = (await buildSliqPayload(files, MAPPING as never)).payload;
    // The "backup taken before the import": a copy of the database as it is now (the companies, nothing imported).
    await closeWork();
    await admin.query(`create database ${base}_pre template ${base}`);
    await openWork(base);
  });

  afterAll(async () => {
    if (pool) await closeWork();
    if (admin) {
      for (const { datname } of (await admin.query("select datname from pg_database where datname like $1", [`${base}%`])).rows) {
        await admin.query(`drop database if exists ${datname}`);
      }
      await admin.end();
    }
  });

  it("census: only the preflight and the batch are callable, both SECURITY DEFINER, by signed-in users only", async () => {
    const rows = await q<{ sig: string; definer: boolean; auth: boolean; anon: boolean; service: boolean }>(`
      select p.oid::regprocedure::text as sig, p.prosecdef as definer, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p where p.proname like 'import_sliq%' or p.proname like 'import_source%' order by 1`);
    expect(rows.filter((r) => r.auth).map((r) => r.sig).sort()).toEqual(["import_sliq_batch(text,jsonb,text,text,integer,jsonb,boolean)", "import_sliq_preflight(text,jsonb,jsonb)"]);
    expect(rows.filter((r) => r.definer).map((r) => r.sig).sort()).toEqual(["import_sliq_batch(text,jsonb,text,text,integer,jsonb,boolean)", "import_sliq_preflight(text,jsonb,jsonb)"]);
    expect(rows.some((r) => r.anon || r.service)).toBe(false);
    const [rls] = await q(`select bool_and(relrowsecurity) as rls from pg_class where relname in ('import_source_rows', 'import_source_batches')`);
    expect(rls.rls).toBe(true);
  });

  it("refuses: anonymous, a non-admin, an admin without the second step when the company asks for it, a source key that is not the files'", async () => {
    expect((await sliqPreflight(rpcAs(null, "aal2", "anon"), payload).catch((e) => e)).code).toBe("42501");
    expect((await sliqPreflight(rpcAs(officeUid), payload).catch((e) => e)).code).toBe("42501");
    await q("insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')", [uid]);
    await q("update organizations set require_admin_mfa = true where id = $1", [org]);
    expect((await sliqPreflight(rpcAs(uid, "aal1"), payload).catch((e) => e)).hint).toBe("mfa_required");
    await q("update organizations set require_admin_mfa = false where id = $1", [org]);
    const forged = { ...payload, source_files: payload.source_files.map((f, i) => (i === 0 ? { ...f, sha256: "0".repeat(64) } : f)) };
    expect((await sliqPreflight(rpc(), forged).catch((e) => e)).hint).toBe("source_sha_mismatch");
  });

  it("preflight: the whole file, nothing written, counts and money; bad rows refused with reasons", async () => {
    const before = await state();
    const pf = await sliqPreflight(rpc(), payload);
    expect(pf.ok).toBe(true);
    expect(pf.counts.customers.to_create).toBe(12);
    expect(pf.counts.invoices.to_create).toBe(N_INV);
    expect(pf.counts.payments.to_create).toBe(payload.payments!.length);
    expect(Number(pf.money.paid)).toBeCloseTo(payload.payments!.reduce((s, p) => s + Number(p.amount), 0), 2);
    expect(Number(pf.money.invoiced)).toBeCloseTo(payload.invoices!.reduce((s, i) => s + Number(i.total), 0), 2);
    expect(await state()).toEqual(before);

    const bad: SliqPayload = { ...payload, invoices: [...payload.invoices!], payments: [...payload.payments!,
      { source_row_id: "P:OVER", invoice_ref: "INV-1004", paid_on: "2026-10-30", amount: "99999.00" },
      { source_row_id: "P:NOINV", invoice_ref: "INV-9999", paid_on: "2026-10-30", amount: "1.00" }] };
    bad.invoices!.push({ source_row_id: "I:BADDATE", invoice_ref: "INV-1999", customer: "Synthetic Customer 1 Ltd", invoice_date: "31/02/2026", total: "1.00" });
    const pfb = await sliqPreflight(rpc(), bad);
    expect(pfb.ok).toBe(false);
    const msgs = pfb.errors.map((e) => `${e.source_row_id}: ${e.message}`).join("\n");
    expect(msgs).toMatch(/I:INV-1004: .*more than its total/);
    expect(msgs).toMatch(/P:NOINV: .*no invoice INV-9999/);
    expect(msgs).toMatch(/I:BADDATE: .*real date/);
    expect(await state()).toEqual(before);
  });

  let first: Awaited<ReturnType<typeof state>>;
  let firstResults: SliqBatchResult[] = [];

  it("imports in planned batches; balances equal the source; counters rise to the highest number; numbering continues", async () => {
    const plan = planSliqBatches(payload, 60);
    expect(plan.orphanPayments).toEqual([]);
    expect(plan.batches.length).toBeGreaterThan(3);
    const run = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    firstResults = run.results;
    expect(run.results.every((r) => r.ok && r.committed && !r.already_imported)).toBe(true);
    first = await state();
    expect(first).toMatchObject({ customers: 12, suppliers: 3, invoices: N_INV, payments: payload.payments!.length, paid_mismatch: 0, dup_customers: 0, dup_invoices: 0, inv_counter: 1000 + N_INV });
    expect(Number(first.payments_sum)).toBeCloseTo(payload.payments!.reduce((s, p) => s + Number(p.amount), 0), 2);
    expect(first.paid).toBe(first.payments_sum);
    expect(Number(first.invoiced)).toBeCloseTo(payload.invoices!.reduce((s, i) => s + Number(i.total), 0), 2);
    expect(first.map_rows).toBe(12 + 3 + N_INV + payload.payments!.length);
    // The batch audit row names the original files and their SHA-256.
    const audit = await q<{ m: { source_files: { sha256: string }[] } }>(`select metadata as m from security_audit.audit_log where organization_id = $1 and action = 'IMPORT_SOURCE_BATCH'`, [org]);
    expect(audit.length).toBe(plan.batches.length);
    expect(audit[0].m.source_files.map((f) => f.sha256).sort()).toEqual(payload.source_files.map((f) => f.sha256).sort());
    // 076's own audit for the records is there too, one per batch that wrote.
    const [c] = await q<{ n: number }>(`select count(*)::int as n from security_audit.audit_log where organization_id = $1 and action = 'IMPORT_COMMITTED'`, [org]);
    expect(c.n).toBe(plan.batches.length);
    // The independent reconciliation (lib/sliq-reconcile + supabase/verify/sliq_reconcile.sql) passes against what was imported.
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/verify/sliq_reconcile.sql"), "utf8").replace("00000000-0000-0000-0000-000000000000", org);
    const db = await pool.connect();
    let dbRows: DbRow[] = [];
    try {
      const res = (await db.query(sql)) as unknown as { rows: DbRow[] }[];
      dbRows = (Array.isArray(res) ? res : [res]).flatMap((r) => r.rows ?? []).filter((r) => r && "metric" in r);
    } finally { db.release(); }
    const rec = reconcile(sourceTotalsFromPayload(payload), dbRows, { countersBefore: {} });
    expect(rec.rows.filter((r) => r.status !== "PASS")).toEqual([]);
    expect(rec.pass).toBe(true);
    // Numbering continues after the highest imported number (the app's own next_doc_number).
    const next = await rpc()("next_doc_number", { p_prefix: "INV" });
    expect(next.data).toBe(`INV-${1001 + N_INV}`);
    first = await state();
  });

  it("twice-run: every batch answers already imported with the same counts; nothing changes", async () => {
    const run = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    expect(run.results.every((r) => r.already_imported && r.replayed)).toBe(true);
    expect(run.results.map((r) => [r.entity, r.batch_no, r.created, r.rows])).toEqual(firstResults.map((r) => [r.entity, r.batch_no, r.created, r.rows]));
    expect(await state()).toEqual(first);
    // A new run label over the same file: every row is already in the map; nothing is written, each batch says so.
    const again = await sliqRunBatches(rpc(), payload, "live-check", undefined, 0, 60);
    expect(again.results.every((r) => r.ok && r.created === 0 && r.already_imported)).toBe(true);
    expect({ ...(await state()), batches: 0 }).toEqual({ ...first, batches: 0 });
  });

  it("the same batch key with different rows is refused (batch_reused)", async () => {
    const b = planSliqBatches(payload, 60).batches[0];
    const r = await rpc()("import_sliq_batch", { p_source_sha256: payload.source_sha256, p_source_files: payload.source_files, p_run_label: "live", p_entity: b.entity, p_batch_no: b.batchNo,
      p_rows: { customers: b.rows.customers!.slice(1) }, p_dry_run: false });
    expect(r.error?.hint).toBe("batch_reused");
  });

  it("map lost, data kept: refused (map_diverged), never a duplicate; a map row can't be removed while its record exists", async () => {
    const del = await q("select 1").then(async () => {
      try { await q(`delete from import_source_rows where organization_id = $1 and entity = 'customer'`, [org]); return null; } catch (e) { return (e as { hint?: string }).hint; }
    });
    expect(del).toBe("import_map_locked");
    const upd = await q(`update import_source_rows set source_row_id = 'x' where organization_id = $1 and entity = 'customer'`, [org]).then(() => null, (e) => e.hint);
    expect(upd).toBe("import_map_locked");
    // The owner removes the map behind the guard's back (TRUNCATE): the data stays.
    await q("alter table import_source_rows disable trigger import_source_rows_guard");
    await q("delete from import_source_rows where organization_id = $1", [org]);
    await q("alter table import_source_rows enable trigger import_source_rows_guard");
    const before = await state();
    const run = await sliqRunBatches(rpc(), payload, "after-map-loss", undefined, 0, 60);
    expect(run.failedAt).toBe(0);
    expect(run.last?.errors?.[0]?.code).toBe("map_diverged");
    const pf = await sliqPreflight(rpc(), payload);
    expect(pf.ok).toBe(false);
    expect(new Set(pf.errors.map((e) => e.code))).toEqual(new Set(["map_diverged"]));
    expect(pf.counts.invoices.problems).toBe(N_INV);
    expect(await state()).toEqual(before);
    expect((await state()).dup_customers).toBe(0);
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
    const run = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(run.results.every((r) => r.already_imported)).toBe(true);
    expect(await state()).toEqual(before);
  });

  it("map kept, data wiped: the map goes with the data; the old run refuses loudly (records_removed); a new run imports once", async () => {
    const counterBefore = (await state()).inv_counter; // 1061: next_doc_number took INV-1061 on this copy above
    await wipeData();
    const wiped = await state();
    expect(wiped.inv_counter).toBe(counterBefore);
    expect(wiped).toMatchObject({ customers: 0, invoices: 0, payments: 0, map_rows: 0 });
    const old = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(old.failedAt).toBe(0);
    expect((old.error as { hint?: string }).hint).toBe("records_removed");
    expect(await state()).toEqual(wiped);
    const fresh = await sliqRunBatches(rpc(), payload, "live-2", undefined, 0, 60);
    expect(fresh.failedAt).toBeNull();
    // The counter never goes back: it stays at 1061, above the highest imported number.
    expect(await state()).toMatchObject({ customers: 12, invoices: N_INV, payments: payload.payments!.length, paid_mismatch: 0, dup_customers: 0, inv_counter: counterBefore });
    expect(counterBefore).toBe(1001 + N_INV);
  });

  it("counters only rise: a counter above the imported numbers stays; an invoice keyed by hand under an imported number is refused", async () => {
    await wipeData();
    await q("update doc_counters set last = 5000 where organization_id = $1 and prefix = 'INV'", [org]);
    const run = await sliqRunBatches(rpc(), payload, "live-3", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    expect((await state()).inv_counter).toBe(5000);
    await wipeData();
    await q(`insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat) values ($1, 'INV-1010', 'Someone Else', 'draft', 1, 1, 0)`, [org]);
    const pf = await sliqPreflight(rpc(), payload);
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e) => e.source_row_id === "I:INV-1010")).toBe(true);
  });

  it("a batch that fails half way leaves nothing; a retry after the fault completes once", async () => {
    await wipeData();
    await q("delete from invoices where organization_id = $1", [org]);
    const before = await state();
    await q(`create or replace function public._t152_boom() returns trigger language plpgsql as $$ begin
      if (select invoice_ref from invoices where id = new.invoice_id) = 'INV-1045' then raise exception 'synthetic fault mid-batch'; end if; return new; end $$`);
    await q("create trigger t152_boom before insert on invoice_payments for each row execute function public._t152_boom()");
    const run = await sliqRunBatches(rpc(), payload, "live-4", undefined, 0, 60);
    expect(run.failedAt).not.toBeNull();
    expect(run.last?.ok).toBe(false);
    expect(run.last?.errors?.[0]?.message).toMatch(/synthetic fault/);
    const failedBatch = planSliqBatches(payload, 60).batches[run.failedAt!];
    const refs = (failedBatch.rows.invoices ?? []).map((i) => i.invoice_ref);
    expect((await q(`select count(*)::int as n from invoices where organization_id = $1 and invoice_ref = any($2)`, [org, refs]))[0].n).toBe(0);
    expect((await q(`select count(*)::int as n from import_source_batches where organization_id = $1 and run_label = 'live-4' and entity = $2 and batch_no = $3`, [org, failedBatch.entity, failedBatch.batchNo]))[0].n).toBe(0);
    await q("drop trigger t152_boom on invoice_payments");
    const retry = await sliqRunBatches(rpc(), payload, "live-4", undefined, run.failedAt!, 60);
    expect(retry.failedAt).toBeNull();
    const s = await state();
    expect(s).toMatchObject({ invoices: N_INV, payments: payload.payments!.length, paid_mismatch: 0, dup_invoices: 0 });
    expect(before.invoices).toBe(0);
  });

  it("a killed connection mid-batch leaves nothing; the retry completes once", async () => {
    await wipeData();
    await q(`create or replace function public._t152_slow() returns trigger language plpgsql as $$ begin
      if (select invoice_ref from invoices where id = new.invoice_id) = 'INV-1045' then perform pg_sleep(30); end if; return new; end $$`);
    await q("create trigger t152_slow before insert on invoice_payments for each row execute function public._t152_slow()");
    const pending = sliqRunBatches(rpc(), payload, "live-5", undefined, 0, 60);
    let killed = 0;
    for (let i = 0; i < 100 && !killed; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      killed = (await q<{ n: number }>(`select count(pg_terminate_backend(pid))::int as n from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep' and pid <> pg_backend_pid()`))[0].n;
    }
    expect(killed).toBe(1);
    const run = await pending;
    expect(run.failedAt).not.toBeNull();
    await q("drop trigger t152_slow on invoice_payments");
    const failedBatch = planSliqBatches(payload, 60).batches[run.failedAt!];
    const refs = (failedBatch.rows.invoices ?? []).map((i) => i.invoice_ref);
    expect((await q(`select count(*)::int as n from invoices where organization_id = $1 and invoice_ref = any($2)`, [org, refs]))[0].n).toBe(0);
    const retry = await sliqRunBatches(rpc(), payload, "live-5", undefined, run.failedAt!, 60);
    expect(retry.failedAt).toBeNull();
    expect(await state()).toMatchObject({ invoices: N_INV, payments: payload.payments!.length, paid_mismatch: 0, dup_invoices: 0, dup_customers: 0 });
  });

  it("the company comes from the session only: the other company's admin imports into its own company; it can't read this one's map", async () => {
    const otherBefore = await state(otherOrg);
    const mineBefore = await state();
    const run = await sliqRunBatches(rpcAs(otherUid), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    expect(await state()).toEqual(mineBefore);
    expect((await state(otherOrg)).invoices).toBe(Number(otherBefore.invoices) + N_INV);
    const seen = await rpcAs(otherUid)("import_sliq_preflight", { p_source_sha256: payload.source_sha256, p_source_files: payload.source_files, p_payload: { customers: payload.customers } });
    expect((seen.data as { counts: { customers: { already_imported: number } } }).counts.customers.already_imported).toBe(12);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(otherUid)), otherUid]);
      const { rows } = await db.query("select count(*)::int as n from import_source_rows where organization_id = $1", [org]);
      expect(rows[0].n).toBe(0);
      await db.query("rollback");
    } finally { db.release(); }
  });
});
