/**
 * Release 156 (supabase/release/156_invoice_ref_case.release.sql, phase 156 after 154): one invoice number per company whatever its capital
 * letters. The DB proof, below PostgREST (IMPORT-DUPLICATE-CASE-FIX-PROPOSAL.md section 6, cases 1 to 19, one `it` each).
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..156. SliQ calls run as
 * PostgREST would: one transaction, role authenticated with an admin's JWT claims. Two-session cases hold one transaction open while a
 * second connection runs, and read pg_stat_activity to prove the second one waits. Companies are synthetic (slug t-<run>-...) and removed
 * afterwards by destroySyntheticWorld. Release, rollback and re-release run inside transactions that are always rolled back.
 * Proves: a case variant of an invoice number (in Tolra or in the same file) is refused by the SliQ route before anything is written
 * (preflight lists it; dry run and commit raise 22023 / invoice_ref_case_duplicate, the batch is not recorded); retries and replays are
 * unchanged; another company may use the same number; concurrent writers (SliQ, owner SQL, the generic import, issue_invoice) meet the
 * index and the loser writes nothing; next_doc_number skips a number taken in any capitals; the release refuses while variants exist and
 * changes nothing; release / rollback / re-release keep every invoice, payment and allocation; the reconciliation still runs.
 * Not proved here: PostgREST's own error mapping, hosted PostgreSQL 17, hosted lock timing.
 * Must not change: this file proves; it never edits a release, verify or rollback file to make itself pass.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { EMAIL_DOMAIN, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const slug = (label: string) => `t-${runId}-p156-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/156_invoice_ref_case.release.sql";
const ROLLBACK = "supabase/release/156_invoice_ref_case.rollback.sql";
const VERIFY = "supabase/verify/invoice_ref_case_156.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MARKER = "post-144 marker 156 invoice_ref_case";
const CUSTOMER = "Case Customer Ltd";

let pool: Pool;
type Row = Record<string, unknown>;
type Res = { data: Row | null; code?: string; hint?: string; message?: string };
const claims = (sub: string) => ({ sub, role: "authenticated", aal: "aal2", email: `${sub.slice(0, 8)}@example.test` });

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
async function asUser(db: PoolClient, sub: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(sub)), sub]);
}
/** fn(named args) inside an open transaction; JSON objects are sent as text and typed by the function's own signature. */
async function callIn(db: PoolClient, fn: string, args: Record<string, unknown>): Promise<Row> {
  const names = Object.keys(args);
  const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
  return (await db.query(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`, values)).rows[0].r as Row;
}
/** One call as PostgREST runs it: one transaction, committed on success. */
async function call(sub: string, fn: string, args: Record<string, unknown>): Promise<Res> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await asUser(db, sub);
    const data = await callIn(db, fn, args);
    await db.query("commit");
    return { data };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    const x = e as { code?: string; hint?: string; message: string };
    return { data: null, code: x.code, hint: x.hint, message: x.message };
  } finally { db.release(); }
}
async function rolledBack<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query("begin"); return await fn(db); } finally { await db.query("rollback").catch(() => undefined); db.release(); }
}
/** A release or rollback file without its own BEGIN / COMMIT, to run inside a test transaction. */
function body(file: string) {
  const s = read(file);
  expect(s.match(/^BEGIN;$/gm), file).toHaveLength(1);
  expect(s.match(/^COMMIT;$/gm), file).toHaveLength(1);
  return s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}
async function preflightRows(db?: PoolClient) {
  const rows = db ? (await db.query(read(PREFLIGHT))).rows : await q(read(PREFLIGHT));
  return rows as { check: string; value: string }[];
}
async function verifyRows(db?: PoolClient) {
  const rows = db ? (await db.query(read(VERIFY))).rows : await q(read(VERIFY));
  return rows as { check_name: string; ok: boolean }[];
}
const bodies = async (db: PoolClient) => (await db.query(`select
    (select md5(regexp_replace(prosrc, '\\s', '', 'g')) from pg_proc where oid = to_regprocedure('public.import_sliq_prepare(uuid,text,jsonb,text)')) as prepare,
    (select md5(regexp_replace(prosrc, '\\s', '', 'g')) from pg_proc where oid = to_regprocedure('public.next_doc_number(text)')) as numbering,
    (select md5(regexp_replace(prosrc, '\\s', '', 'g')) from pg_proc where oid = to_regprocedure('public.import_sliq_reconcile_rows(uuid)')) as reconcile,
    to_regclass('public.invoices_invoice_ref_ci_uniq') is not null as ci_index`)).rows[0] as { prepare: string; numbering: string; reconcile: string; ci_index: boolean };
const BEFORE_156 = { prepare: "a35a5a70fac350a7e662dd28dd324d80", numbering: "c5af802da68d4236a36db71098036acf", reconcile: "315952a95ce42c75078e94026069121b", ci_index: false };
const AFTER_156 = { prepare: "24411fb681e2be3fc2ba3bcd007e71ac", numbering: "75dffec8a6b52c01267aa22a64802da0", reconcile: "3288cdc2d98acba018c8e417bddd77bb", ci_index: true };

// ---- Synthetic companies and SliQ exports ----------------------------------------------------------------------------------------
async function makeCompany() {
  const o = randomUUID();
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic p156 ${o.slice(0, 8)}`, slug("co")]);
  return o;
}
async function makePerson(o: string, role: string) {
  const u = randomUUID();
  const e = email(role);
  await q("insert into auth.users (id, email) values ($1, $2)", [u, e]);
  await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', $3, $4, true, false)", [u, e, role, o]);
  await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, $3, true)", [o, u, role]);
  return u;
}
const hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** One SliQ export: its two files and the source key 152 checks them against. */
function exportOf(tag: string) {
  const files = [{ entity: "customers", name: `customers-${tag}.csv`, sha256: hex(`c-${tag}`) }, { entity: "invoices", name: `invoices-${tag}.csv`, sha256: hex(`i-${tag}`) }];
  return { files, sha: hex(files.map((f) => `${f.entity}:${f.sha256}`).sort().join("\n")) };
}
type Export = ReturnType<typeof exportOf>;
const inv = (ref: string, rowId = `I:${ref}`, total = "120.00") => ({ source_row_id: rowId, invoice_ref: ref, customer: CUSTOMER, invoice_date: "2026-10-01", total, status: "sent" });
const batchArgs = (x: Export, label: string, entity: string, no: number, rows: Row, dry = false) =>
  ({ p_source_sha256: x.sha, p_source_files: x.files, p_run_label: label, p_entity: entity, p_batch_no: no, p_rows: rows, p_dry_run: dry, p_allow_inv_gap: true });
const batch = (sub: string, x: Export, label: string, no: number, invoices: Row[], dry = false) => call(sub, "import_sliq_batch", batchArgs(x, label, "invoices", no, { invoices }, dry));
const preflight = (sub: string, x: Export, invoices: Row[]) =>
  call(sub, "import_sliq_preflight", { p_source_sha256: x.sha, p_source_files: x.files, p_payload: { invoices }, p_allow_inv_gap: true });

type Co = { o: string; u: string; x: Export };
/** A company with an admin and the one customer every invoice names (imported through the SliQ route itself). */
async function company(tag: string): Promise<Co> {
  const o = await makeCompany();
  const u = await makePerson(o, "admin");
  const x = exportOf(`${tag}-${runId}`);
  const r = await call(u, "import_sliq_batch", batchArgs(x, "base", "customers", 1, { customers: [{ source_row_id: "C:ACC1", name: CUSTOMER, external_ref: "ACC1" }] }));
  expect(r.data?.committed, JSON.stringify(r)).toBe(true);
  return { o, u, x };
}
async function committed(c: Co, label: string, no: number, invoices: Row[]) {
  const r = await batch(c.u, c.x, label, no, invoices);
  expect(r.data?.committed, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r.data!;
}
const refs = async (o: string) => (await q<{ r: string }>("select invoice_ref as r from invoices where organization_id = $1 order by invoice_ref", [o])).map((x) => x.r);
/** Everything an import can change for the company: invoices, payments, allocations, the map, batches, counters, keys, the audit tail. */
async function state(o: string) {
  const [r] = await q(`select
    (select count(*) from invoices where organization_id = $1)::int as invoices,
    (select md5(coalesce(string_agg(md5(to_jsonb(v)::text), '' order by v.id), '')) from invoices v where v.organization_id = $1) as invoices_fp,
    (select md5(coalesce(string_agg(md5(to_jsonb(p)::text), '' order by p.id), '')) from invoice_payments p where p.organization_id = $1) as payments_fp,
    (select md5(coalesce(string_agg(md5(to_jsonb(a)::text), '' order by a.id), '')) from invoice_credit_allocations a where a.organization_id = $1) as allocations_fp,
    (select count(*) from import_source_rows where organization_id = $1)::int as map_rows,
    (select count(*) from import_source_batches where organization_id = $1)::int as batches,
    (select coalesce(jsonb_object_agg(prefix, last), '{}'::jsonb) from doc_counters where organization_id = $1) as counters,
    (select count(*) from import_record_keys where organization_id = $1)::int as record_keys,
    (select count(*) from security_audit.audit_log where organization_id = $1)::int as audit_rows`, [o]);
  return r;
}
/** Database-wide money rows: every invoice, payment and credit allocation, as one checksum each. */
async function money(db: PoolClient) {
  return (await db.query(`select
    (select md5(coalesce(string_agg(md5(to_jsonb(v)::text), '' order by v.id), '')) from invoices v) as invoices,
    (select md5(coalesce(string_agg(md5(to_jsonb(p)::text), '' order by p.id), '')) from invoice_payments p) as payments,
    (select md5(coalesce(string_agg(md5(to_jsonb(a)::text), '' order by a.id), '')) from invoice_credit_allocations a) as allocations,
    (select count(*) from invoices)::int as n`)).rows[0];
}
const caseErrors = (r: Res) => ((r.data?.errors ?? []) as { code: string; source_row_id: string; message: string }[]).filter((e) => e.code === "invoice_ref_case_duplicate");

/** Polls pg_stat_activity until `pid` waits on a lock (proves the second writer is blocked, not finished). */
async function waitsOnLock(pid: number) {
  for (let i = 0; i < 100; i += 1) {
    const [r] = await q<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [pid]);
    if (r?.w === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
/** A connection with an open transaction, as `sub` (or as the owner), and its backend pid. */
async function openTx(sub: string | null) {
  const db = await pool.connect();
  const pid = (await db.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;
  await db.query("begin");
  if (sub) await asUser(db, sub);
  return { db, pid };
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: { code?: string; hint?: string; message: string }) => ({ ok: false as const, e }));
/** A draft invoice (2 x 50 + 20% VAT) of the company, by its admin; returns the id. */
async function draftInvoice(c: Co) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await asUser(db, c.u);
    const id = (await db.query<{ id: string }>(`select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb) as id`,
      [JSON.stringify({ customer: CUSTOMER, subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" }),
       JSON.stringify([{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }])])).rows[0].id;
    await db.query("commit");
    return id;
  } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
}

describe("release 156: one invoice number per company whatever its capital letters", () => {
  let A: Co;
  let B: Co;

  beforeAll(async () => {
    await verifyBackendIdentity();
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 8 });
    A = await company("a");
    B = await company("b");
    await committed(A, "seed", 1, [inv("INV-1001")]);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await destroySyntheticWorld(runId);
  });

  it("1. Tolra has INV-1001; the file has inv-1001 under a new row id: the preflight lists it, the dry run and the commit refuse it, nothing changes", async () => {
    expect((await verifyRows()).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    const before = await state(A.o);
    const pf = await preflight(A.u, A.x, [inv("inv-1001", "I:NEW-1")]);
    expect(pf.data?.ok).toBe(false);
    expect(caseErrors(pf)).toEqual([expect.objectContaining({ source_row_id: "I:NEW-1",
      message: "Tolra already has invoice INV-1001; inv-1001 differs only in capital letters. Nothing in this batch was written." })]);
    for (const dry of [false, true]) {
      const r = await batch(A.u, A.x, "case", 1, [inv("inv-1001", "I:NEW-1")], dry);
      expect(r, `dry run ${dry}`).toMatchObject({ data: null, code: "22023", hint: "invoice_ref_case_duplicate" });
      expect(r.message).toMatch(/^Tolra already has invoice INV-1001; inv-1001 differs only in capital letters/);
    }
    expect(await state(A.o)).toEqual(before);
    expect(await refs(A.o)).toEqual(["INV-1001"]);
  });

  it("2. INV-2001 and inv-2001 both new in one payload (the validator bypassed): both rows refused; nothing written", async () => {
    const before = await state(A.o);
    const rows = [inv("INV-2001"), inv("inv-2001")];
    const pf = await preflight(A.u, A.x, rows);
    expect(pf.data?.ok).toBe(false);
    expect(caseErrors(pf).map((e) => e.source_row_id).sort()).toEqual(["I:INV-2001", "I:inv-2001"]);
    expect(caseErrors(pf)[0].message).toBe("This file has invoice numbers INV-2001, inv-2001, which differ only in capital letters. Nothing in this batch was written.");
    expect(await batch(A.u, A.x, "pair", 1, rows)).toMatchObject({ code: "22023", hint: "invoice_ref_case_duplicate" });
    expect(await state(A.o)).toEqual(before);
  });

  it("3. mixed case Inv-1001 is refused; the exact INV-1001 under a new row id is still map_diverged (unchanged)", async () => {
    expect(await batch(A.u, A.x, "mixed", 1, [inv("Inv-1001", "I:MIXED")])).toMatchObject({ code: "22023", hint: "invoice_ref_case_duplicate" });
    const pf = await preflight(A.u, A.x, [inv("INV-1001", "I:EXACT")]);
    expect(caseErrors(pf)).toEqual([]);
    expect((pf.data?.errors as { code: string; source_row_id: string }[]).filter((e) => e.code === "map_diverged").map((e) => e.source_row_id)).toEqual(["I:EXACT"]);
    const r = await batch(A.u, A.x, "exact", 1, [inv("INV-1001", "I:EXACT")]);
    expect(r.data).toMatchObject({ ok: false, committed: false });
    expect((r.data?.errors as { code: string }[]).map((e) => e.code)).toContain("map_diverged");
  });

  it("4. display text: a new inv-7001 with no variant anywhere is imported and stored exactly as typed", async () => {
    await committed(A, "lower", 1, [inv("inv-7001")]);
    expect(await refs(A.o)).toContain("inv-7001");
    expect(await refs(A.o)).not.toContain("INV-7001");
  });

  it("5. an identical replay of a committed batch still answers already imported / replayed, with no new error", async () => {
    const first = await committed(A, "replay", 1, [inv("INV-1101")]);
    const before = await state(A.o);
    const again = await batch(A.u, A.x, "replay", 1, [inv("INV-1101")]);
    expect(again.data).toMatchObject({ ok: true, committed: true, already_imported: true, replayed: true, created: first.created });
    expect(caseErrors(again)).toEqual([]);
    expect(await state(A.o)).toEqual(before);
  });

  it("6. a refused batch retried with the corrected rows under the same run label and batch number commits (no batch_reused)", async () => {
    expect(await batch(A.u, A.x, "retry", 1, [inv("inv-1001", "I:R1"), inv("INV-1201")])).toMatchObject({ code: "22023", hint: "invoice_ref_case_duplicate" });
    expect(await q("select 1 from import_source_batches where organization_id = $1 and run_label = 'retry'", [A.o])).toHaveLength(0);
    const fixed = await committed(A, "retry", 1, [inv("INV-1202", "I:R1"), inv("INV-1201")]);
    expect(fixed).toMatchObject({ ok: true, created: 2, already_imported: false });
    expect(await refs(A.o)).toEqual(expect.arrayContaining(["INV-1201", "INV-1202"]));
  });

  it("7. the same key with different rows is still batch_reused; a different export reusing an imported row id is still other_source_file", async () => {
    expect(await batch(A.u, A.x, "retry", 1, [inv("INV-1203")])).toMatchObject({ code: "22023", hint: "batch_reused" });
    const other = exportOf(`other-${runId}`);
    const before = await state(A.o);
    const r = await batch(A.u, other, "other", 1, [inv("INV-1001")]);
    expect(r.data).toMatchObject({ ok: false, committed: false });
    expect((r.data?.errors as { code: string; source_row_id: string }[]).filter((e) => e.code === "other_source_file").map((e) => e.source_row_id)).toEqual(["I:INV-1001"]);
    expect(await state(A.o)).toEqual(before);
  });

  it("8. across batches: batch 1 creates INV-3001; batch 2 carrying inv-3001 is refused; batch 1 is intact", async () => {
    await committed(A, "across", 1, [inv("INV-3001"), inv("INV-3002")]);
    const before = await state(A.o);
    expect(await batch(A.u, A.x, "across", 2, [inv("inv-3001"), inv("INV-3003")])).toMatchObject({ code: "22023", hint: "invoice_ref_case_duplicate" });
    expect(await state(A.o)).toEqual(before);
    expect(await q("select 1 from import_source_rows where organization_id = $1 and run_label = 'across' and batch_no = 1 and entity = 'invoice'", [A.o])).toHaveLength(2);
    expect(await q("select 1 from import_source_batches where organization_id = $1 and run_label = 'across'", [A.o])).toHaveLength(1);
  });

  it("9. company isolation: B imports INV-1001 and inv-5001 while A has INV-1001; A then imports INV-5001 while B has inv-5001 (neither reads the other)", async () => {
    await committed(B, "own", 1, [inv("INV-1001"), inv("inv-5001")]);
    expect(await refs(B.o)).toEqual(["INV-1001", "inv-5001"]);
    expect(caseErrors(await preflight(A.u, A.x, [inv("INV-5001")]))).toEqual([]);
    await committed(A, "own", 1, [inv("INV-5001")]);
    expect(await refs(A.o)).toContain("INV-5001");
    // The index is per company: the owner can still put the same number in B under another capitalisation only if B has no variant.
    expect(caseErrors(await preflight(B.u, B.x, [inv("INV-5001", "I:B-UPPER")])).map((e) => e.source_row_id)).toEqual(["I:B-UPPER"]);
  });

  it("10. two SliQ batches at once for one company (INV-4001 / inv-4001): the advisory lock serialises them; the second is refused", async () => {
    const first = await openTx(A.u);
    try {
      expect((await callIn(first.db, "import_sliq_batch", batchArgs(A.x, "race", "invoices", 1, { invoices: [inv("INV-4001")] }))).committed).toBe(true);
      const second = await openTx(A.u);
      try {
        const pending = settle(callIn(second.db, "import_sliq_batch", batchArgs(A.x, "race", "invoices", 2, { invoices: [inv("inv-4001")] })));
        expect(await waitsOnLock(second.pid)).toBe(true);
        await first.db.query("commit");
        const r = await pending;
        expect(r.ok).toBe(false);
        expect(!r.ok && r.e).toMatchObject({ code: "22023", hint: "invoice_ref_case_duplicate" });
      } finally { await second.db.query("rollback").catch(() => undefined); second.db.release(); }
    } finally { await first.db.query("rollback").catch(() => undefined); first.db.release(); }
    expect((await refs(A.o)).filter((r) => r.toLowerCase() === "inv-4001")).toEqual(["INV-4001"]);
  });

  it("11. a SliQ batch holding INV-4101 open against an owner insert and a generic import of the variant: each waits, then 23505; nothing of it is written", async () => {
    // Owner SQL: waits on the index for the open batch, then 23505.
    {
      const first = await openTx(A.u);
      try {
        expect((await callIn(first.db, "import_sliq_batch", batchArgs(A.x, "race-owner", "invoices", 1, { invoices: [inv("INV-4101")] }))).committed).toBe(true);
        const owner = await openTx(null);
        try {
          const pending = settle(owner.db.query("insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat) values ($1, 'inv-4101', 'Someone Else', 'draft', 1, 1, 0)", [A.o]));
          expect(await waitsOnLock(owner.pid)).toBe(true);
          await first.db.query("commit");
          const r = await pending;
          expect(!r.ok && r.e.code).toBe("23505");
        } finally { await owner.db.query("rollback").catch(() => undefined); owner.db.release(); }
      } finally { await first.db.query("rollback").catch(() => undefined); first.db.release(); }
    }
    // The generic workbook import (085): waits on the import lock, then the index refuses its write; 085 reports the refusal, nothing kept.
    {
      const first = await openTx(A.u);
      try {
        expect((await callIn(first.db, "import_sliq_batch", batchArgs(A.x, "race-generic", "invoices", 1, { invoices: [inv("INV-4102")] }))).committed).toBe(true);
        const generic = await openTx(A.u);
        try {
          const pending = settle(callIn(generic.db, "import_company_data", { p_payload: { file_name: "invoices.csv", file_sha256: hex("generic-4102"),
            invoices: [{ invoice_ref: "inv-4102", customer: CUSTOMER, invoice_date: "2026-10-01", total: 12 }] }, p_dry_run: false, p_client_op_id: randomUUID() }));
          expect(await waitsOnLock(generic.pid)).toBe(true);
          await first.db.query("commit");
          const r = await pending;
          expect(r.ok && r.v).toMatchObject({ ok: false });
          expect(JSON.stringify(r.ok && r.v)).toMatch(/23505|invoices_invoice_ref_ci_uniq/);
          await generic.db.query("commit");
        } finally { await generic.db.query("rollback").catch(() => undefined); generic.db.release(); }
      } finally { await first.db.query("rollback").catch(() => undefined); first.db.release(); }
    }
    const mine = (await refs(A.o)).filter((r) => ["inv-4101", "inv-4102"].includes(r.toLowerCase()));
    expect(mine).toEqual(["INV-4101", "INV-4102"]);
  });

  it("12. a SliQ batch against issue_invoice reaching the same number: one wins, the other fails cleanly (and a retry skips the number)", async () => {
    const C = await company("c");
    await q("insert into doc_counters (organization_id, prefix, last) values ($1, 'INV', 4199)", [C.o]);
    // (a) The batch holds inv-4200 open; issue_invoice takes INV-4200, waits on the index, then 23505; its retry gets INV-4201.
    const draft1 = await draftInvoice(C);
    {
      const first = await openTx(C.u);
      try {
        expect((await callIn(first.db, "import_sliq_batch", batchArgs(C.x, "race-issue", "invoices", 1, { invoices: [inv("inv-4200")] }))).committed).toBe(true);
        const issuer = await openTx(C.u);
        try {
          const pending = settle(issuer.db.query("select public.issue_invoice($1)", [draft1]));
          expect(await waitsOnLock(issuer.pid)).toBe(true);
          await first.db.query("commit");
          const r = await pending;
          expect(!r.ok && r.e.code).toBe("23505");
        } finally { await issuer.db.query("rollback").catch(() => undefined); issuer.db.release(); }
      } finally { await first.db.query("rollback").catch(() => undefined); first.db.release(); }
    }
    expect((await q<{ r: string | null }>("select invoice_ref as r from invoices where id = $1", [draft1]))[0].r).toBeNull();
    expect((await call(C.u, "issue_invoice", { p_invoice: draft1 })).code).toBeUndefined();
    expect((await q<{ r: string }>("select invoice_ref as r from invoices where id = $1", [draft1]))[0].r).toBe("INV-4201");
    // (b) issue_invoice holds INV-4202 open; the batch's inv-4202 waits on the index, then 076's write is refused (23505): nothing written.
    const draft2 = await draftInvoice(C);
    const before = await state(C.o);
    {
      const issuer = await openTx(C.u);
      try {
        await issuer.db.query("select public.issue_invoice($1)", [draft2]);
        const second = await openTx(C.u);
        try {
          const pending = settle(callIn(second.db, "import_sliq_batch", batchArgs(C.x, "race-issue", "invoices", 2, { invoices: [inv("inv-4202")] })));
          expect(await waitsOnLock(second.pid)).toBe(true);
          await issuer.db.query("commit");
          const r = await pending;
          expect(r.ok && r.v).toMatchObject({ ok: false, committed: false, created: 0 });
          expect(JSON.stringify(r.ok && r.v)).toMatch(/23505/);
          await second.db.query("commit");
        } finally { await second.db.query("rollback").catch(() => undefined); second.db.release(); }
      } finally { await issuer.db.query("rollback").catch(() => undefined); issuer.db.release(); }
    }
    const after = await state(C.o);
    expect([after.map_rows, after.batches]).toEqual([before.map_rows, before.batches]);
    expect((await refs(C.o)).filter((r) => r.toLowerCase() === "inv-4202")).toEqual(["INV-4202"]);
  });

  it("13. inv-1500 exists and the INV counter is 1499: issue_invoice skips it and gives INV-1501 (option A)", async () => {
    const D = await company("d");
    await committed(D, "low", 1, [inv("inv-1500")]);
    await q("insert into doc_counters (organization_id, prefix, last) values ($1, 'INV', 1499) on conflict (organization_id, prefix) do update set last = 1499", [D.o]);
    const draft = await draftInvoice(D);
    expect((await call(D.u, "issue_invoice", { p_invoice: draft })).code).toBeUndefined();
    expect((await q<{ r: string }>("select invoice_ref as r from invoices where id = $1", [draft]))[0].r).toBe("INV-1501");
    expect(await refs(D.o)).toEqual(["INV-1501", "inv-1500"]);
  });

  it("14. the generic workbook import of inv-1001 next to INV-1001: its dry run and its commit are refused by the index with the generic database refusal (no named code: known limit, answer 3), nothing written", async () => {
    const payload = { file_name: "invoices.csv", file_sha256: hex("generic-1001"), invoices: [{ invoice_ref: "inv-1001", customer: CUSTOMER, invoice_date: "2026-10-01", total: 12 }] };
    // 085 runs a dry run by writing and rolling back, so the index refuses the preview too; neither names invoice_ref_case_duplicate.
    const before = await state(A.o);
    const dry = await call(A.u, "import_company_data", { p_payload: payload, p_dry_run: true, p_client_op_id: randomUUID() });
    expect(dry.data).toMatchObject({ ok: false, dry_run: true, errors: [expect.objectContaining({ code: "23505" })] });
    expect(JSON.stringify(dry.data)).toMatch(/invoices_invoice_ref_ci_uniq/);
    expect(JSON.stringify(dry.data)).not.toMatch(/invoice_ref_case_duplicate/);
    const commit = await call(A.u, "import_company_data", { p_payload: payload, p_dry_run: false, p_client_op_id: randomUUID() });
    expect(commit.data).toMatchObject({ ok: false, committed: false, errors: [expect.objectContaining({ code: "23505" })] });
    expect(JSON.stringify(commit.data)).toMatch(/invoices_invoice_ref_ci_uniq/);
    const after = await state(A.o);
    expect([after.invoices, after.invoices_fp, after.payments_fp, after.counters]).toEqual([before.invoices, before.invoices_fp, before.payments_fp, before.counters]);
    expect((await refs(A.o)).filter((r) => r.toLowerCase() === "inv-1001")).toEqual(["INV-1001"]);
  });

  it("15. an owner insert of a case variant is refused by the index (23505); the same number in another company is allowed", async () => {
    const insert = (o: string, ref: string) => rolledBack((db) => db.query("insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat) values ($1, $2, 'Someone Else', 'draft', 1, 1, 0)", [o, ref])
      .then(() => "ok", (e: { code?: string }) => e.code));
    expect(await insert(A.o, "inv-1001")).toBe("23505");
    expect(await insert(A.o, "INV-1001")).toBe("23505");
    expect(await insert(B.o, "inv-3001")).toBe("ok");
  });

  it("16. with a variant pair present, 156 refuses with the listed group and changes nothing; preflight row 59 shows the count", async () => {
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      expect(await bodies(db)).toEqual(BEFORE_156);
      await db.query("insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat) values ($1, 'inv-1001', 'Someone Else', 'draft', 1, 1, 0)", [A.o]);
      const pre = await preflightRows(db);
      expect(pre.find((r) => r.check.startsWith("156 needs:"))?.value).toBe("1 / 152 / 078 / 152");
      expect(pre.find((r) => r.check === MARKER)?.value).toBe("not applied");
      const fp = await money(db);
      await db.query("savepoint s");
      const e = await db.query(body(RELEASE)).then(() => null, (x: { message: string; hint?: string }) => x);
      expect(e?.hint).toBe("invoice_ref_case_duplicates");
      expect(e?.message).toContain(`156: 1 group(s) of invoice numbers differ only in capital letters (first 20, company id: numbers): ${A.o}: INV-1001, inv-1001. Nothing was changed.`);
      await db.query("rollback to savepoint s");
      expect(await bodies(db)).toEqual(BEFORE_156);
      expect(await money(db)).toEqual(fp);
    });
  });

  it("17. release twice = once; rollback twice = once; release, rollback, re-release on a populated database: verify all true each time", async () => {
    await rolledBack(async (db) => {
      expect(Number((await db.query("select count(*) as n from invoices")).rows[0].n)).toBeGreaterThan(10);
      expect(await bodies(db)).toEqual(AFTER_156);
      await db.query(body(RELEASE));
      expect(await bodies(db)).toEqual(AFTER_156);
      expect((await verifyRows(db)).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      await db.query(body(ROLLBACK));
      await db.query(body(ROLLBACK));
      expect(await bodies(db)).toEqual(BEFORE_156);
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("not applied");
      expect((await db.query(read("supabase/verify/sliq_import_route_152.sql"))).rows.filter((r: { ok: boolean }) => r.ok !== true)).toEqual([]);
      await db.query(body(RELEASE));
      expect(await bodies(db)).toEqual(AFTER_156);
      const v = await verifyRows(db);
      expect(v).toHaveLength(8);
      expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("applied");
      expect((await preflightRows(db)).find((r) => r.check.startsWith("156 needs:"))?.value).toBe("0 / 156 / 156 / 156");
    });
  });

  it("18. invoice, payment and credit allocation checksums are equal across release, rollback and re-release", async () => {
    await rolledBack(async (db) => {
      const start = await money(db);
      expect(start.n).toBeGreaterThan(10);
      await db.query(body(RELEASE));
      expect(await money(db)).toEqual(start);
      await db.query(body(ROLLBACK));
      expect(await money(db)).toEqual(start);
      await db.query(body(RELEASE));
      expect(await money(db)).toEqual(start);
    });
  });

  it("19. the reconciliation is unchanged in shape and still runs; its duplicate-number count ignores capital letters", async () => {
    const rows = async (db: PoolClient) => {
      await db.query("savepoint r");
      await asUser(db, A.u);
      const out = ((await callIn(db, "import_sliq_reconcile", {})).rows as { metric: string; key: string; value: string }[]).map((r) => `${r.metric}|${r.key}|${r.value}`).sort();
      await db.query("rollback to savepoint r");
      return out;
    };
    await rolledBack(async (db) => {
      const with156 = await rows(db);
      expect(with156).toContain("dup_invoice_ref|groups|0");
      expect(with156.some((r) => r.startsWith("count|invoices|"))).toBe(true);
      await db.query(body(ROLLBACK));
      expect(await rows(db)).toEqual(with156);
      await db.query(body(RELEASE));
      // Only with the index out of the way can a variant pair exist: then 156's count sees it (152's exact grouping did not).
      await db.query("drop index public.invoices_invoice_ref_ci_uniq");
      await db.query("insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat) values ($1, 'inv-1001', 'Someone Else', 'draft', 1, 1, 0)", [A.o]);
      const dup = await rows(db);
      expect(dup).toContain("dup_invoice_ref|groups|1");
      expect(dup).toContain("dup_invoice_ref_detail|inv-1001|2");
    });
  });
});
