/**
 * C07: the two import paths of the cutover, under the real pg-safeupdate library, with synthetic data only. Required: no runIf, no
 * skip, no stand-in library. Run by scripts/c07/run-safeupdate.sh, which preloads safeupdate into every new session of the stack's
 * postgres role (the role scripts/sliq-import connects as); this file fails at once if that preload is not active.
 *
 *   * The data import (Admin > Data; lib/data-import.ts calls import_company_data, import_stage_part / import_validate /
 *     import_commit_part and import_undo as the signed-in admin): migrations 076 / 079 / 085. A small import is ONE transaction:
 *     the work runs in a sub-block that a dry run or any problem ends with a sentinel, so all of it rolls back
 *     (076_data_import.sql:1647-1657, under the per-company advisory lock of 1638); a dry run then records only its import_batches row (076:1659-1666). Credit notes and delivery
 *     notes go only this way (085).
 *   * The SliQ legacy CLI (scripts/sliq-import/cli.mjs --write): one direct connection as the database URL's role (the owner,
 *     postgres here), ONE transaction with an advisory lock (scripts/sliq-import/write.mjs:159-262: begin at 161, commit at 255,
 *     rollback at 258) around public.import_legacy_tenant (supabase/import/import_legacy_tenant.sql) and the line / payment writes.
 *     It writes no credit note or delivery note (write.mjs:147 sends delivery_notes: []; resolutions.mjs: credit notes are never
 *     written) and has no undo: its rollback is the transaction.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dryRun, writeRun } from "../../scripts/sliq-import/cli.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile } from "../../scripts/sliq-import/mapping.mjs";
import { analyse } from "../../scripts/sliq-import/reconcile.mjs";
import { prepareRehearsal } from "../../scripts/sliq-import/write.mjs";
import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

import { type Who, q, refusal } from "./time-support";

let world: SyntheticWorld;
const admin = () => world.tenants.alpha.users.admin;
const org = () => world.tenants.alpha.id;
const cliAdmin = () => world.tenants.beta.users.admin;
const cliOrg = () => world.tenants.beta.id;

const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);

/** The company's business records (as tests/db/data-import-pr2.test.ts checks them), row by row. */
const BUSINESS = ["customers", "suppliers", "stock", "quotes", "quote_line_items", "sales_orders", "jobs", "purchase_orders", "invoices", "invoice_line_items",
  "invoice_payments", "credit_notes", "credit_note_lines", "invoice_credit_allocations", "delivery_notes", "delivery_note_items", "import_record_keys"];
const business = (o: string) => withDb(async (db) => {
  const out: Record<string, string[]> = {};
  for (const t of BUSINESS) {
    out[t] = (await db.query<{ r: string }>(`select to_jsonb(x)::text as r from public.${t} x where organization_id = $1 order by 1`, [o])).rows.map((r) => r.r);
  }
  return out;
});
/** Every audit row of the company: id, table, row, action (the log is append only). */
const audit = (o: string) => sql<{ id: string; entity_table: string; entity_id: string | null; action: string }>(
  "select id::text, entity_table, entity_id, action from security_audit.audit_log where organization_id = $1 order by id", [o]);
const batches = (o: string) => sql<{ id: string; status: string }>("select id::text, status from public.import_batches where organization_id = $1 order by id", [o]);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

describe("C07: pg-safeupdate is active in the importer's own sessions", () => {
  it("a NEW session of the database URL's role has safeupdate on without LOAD, and refuses a bare UPDATE and DELETE (also in PL/pgSQL)", async () => {
    const db = new Client({ connectionString: isolatedBackend().databaseUrl });
    await db.connect();
    try {
      expect((await db.query("select current_setting('safeupdate.enabled', true) as v")).rows[0].v).toBe("on");
      await db.query("create temporary table c07_active (n int)");
      await expect(db.query("update c07_active set n = 1")).rejects.toThrow("UPDATE requires a WHERE clause");
      await expect(db.query("delete from c07_active")).rejects.toThrow("DELETE requires a WHERE clause");
      await expect(db.query("do $$ begin update c07_active set n = 1; end $$")).rejects.toThrow("UPDATE requires a WHERE clause");
      await db.query("update c07_active set n = 1 where true");
    } finally {
      await db.end();
    }
  });
});

type Counts = { created?: number; matched_existing?: number; errors?: number };
type Result = { ok: boolean; committed?: boolean; dry_run?: boolean; replayed?: boolean; error_count?: number; errors?: { message: string }[];
  counts?: Record<string, Counts>; parts?: number; parts_committed?: number; status?: string; refused_count?: number };
const call = (who: Who, text: string, params: unknown[]) => q<{ r: Result }>(who, text, params).then((rows) => rows[0].r);
const importData = (p: unknown, dry: boolean, op: string = randomUUID()) =>
  call(admin(), "select public.import_company_data($1::jsonb, $2, $3) as r", [JSON.stringify(p), dry, op]);
const created = (r: Result) => Object.fromEntries(Object.entries(r.counts ?? {}).map(([k, c]) => [k, c.created ?? 0]));

describe("C07: the data import (076 / 079 / 085) as the signed-in admin, under safeupdate", () => {
  const SHA = "c".repeat(64);
  const file = (t: string) => {
    const customer = `C07 Customer ${t}`;
    return {
      file_name: `c07-${t}.csv`, file_sha256: SHA,
      customers: [{ name: customer }],
      invoices: [{ invoice_ref: `INV-C07${t}-1`, customer, invoice_date: "2026-08-01", total: 50, vat: 0 },
        { invoice_ref: `INV-C07${t}-2`, customer, invoice_date: "2026-08-02", total: 80, vat: 0 }],
      credit_notes: [{ credit_ref: `CRD-C07${t}`, invoice_ref: `INV-C07${t}-1`, credit_date: "2026-08-03", total: 10, vat: 0 }],
      delivery_notes: [{ dn_number: `DLN-C07${t}`, customer, invoice_ref: `INV-C07${t}-1`, delivery_date: "2026-08-01", lines: [{ description: "Synthetic part", quantity: 2 }] }],
    };
  };
  const refs = async (t: string) => ({
    invoices: (await sql<{ n: number }>("select count(*)::int as n from public.invoices where organization_id = $1 and invoice_ref like $2", [org(), `INV-C07${t}-%`]))[0].n,
    credit_notes: (await sql<{ n: number }>("select count(*)::int as n from public.credit_notes where organization_id = $1 and credit_ref = $2", [org(), `CRD-C07${t}`]))[0].n,
    delivery_notes: (await sql<{ n: number }>("select count(*)::int as n from public.delivery_notes where organization_id = $1 and dn_number = $2", [org(), `DLN-C07${t}`]))[0].n,
  });
  const t = randomUUID().slice(0, 6);

  it("dry run: answers the counts and writes no business row; the only audit row is its own import_batches dry-run record", async () => {
    const [before, auditBefore, batchesBefore] = [await business(org()), await audit(org()), await batches(org())];
    const dry = await importData(file(t), true);
    expect(dry.errors ?? []).toEqual([]);
    expect(dry).toMatchObject({ ok: true, dry_run: true, committed: false });
    expect(created(dry)).toMatchObject({ customers: 1, invoices: 2, credit_notes: 1, delivery_notes: 1, delivery_note_items: 1 });
    expect(await business(org())).toEqual(before);
    const added = (await audit(org())).filter((a) => !auditBefore.some((b) => b.id === a.id));
    expect(added.map((a) => a.entity_table)).toEqual(["import_batches"]);
    expect((await audit(org())).filter((a) => auditBefore.some((b) => b.id === a.id))).toEqual(auditBefore);
    const newBatches = (await batches(org())).filter((b) => !batchesBefore.some((x) => x.id === b.id));
    expect(newBatches.map((b) => b.status)).toEqual(["dry_run"]);
    expect(await refs(t)).toEqual({ invoices: 0, credit_notes: 0, delivery_notes: 0 });
  });

  it("invalid file (credit note over its invoice's total): refused whole, nothing written, audit log and batches unchanged", async () => {
    const [before, auditBefore, batchesBefore] = [await business(org()), await audit(org()), await batches(org())];
    const bad = file(t);
    bad.credit_notes = [{ ...bad.credit_notes[0], total: 500 }];
    const r = await importData(bad, false);
    expect(r.ok).toBe(false);
    expect(r.committed).not.toBe(true);
    expect(r.error_count).toBeGreaterThan(0);
    expect(await business(org())).toEqual(before);
    expect(await audit(org())).toEqual(auditBefore);
    expect(await batches(org())).toEqual(batchesBefore);
  });

  it("failure midway (the delivery note INSERT fails after customers, invoices and the credit note were written): all of it rolls back; the retry with the SAME key then commits once", async () => {
    const [before, auditBefore, batchesBefore] = [await business(org()), await audit(org()), await batches(org())];
    const fn = `c07_fail_${t}`;
    await withDb(async (db) => {
      await db.query(`create function public.${fn}() returns trigger language plpgsql as $$ begin if new.dn_number = 'DLN-C07${t}' then raise exception 'C07 injected delivery failure'; end if; return new; end $$`);
      await db.query(`create trigger ${fn} before insert on public.delivery_notes for each row execute function public.${fn}()`);
    });
    const op = randomUUID();
    let failed: Result;
    try {
      failed = await importData(file(t), false, op);
    } finally {
      await withDb(async (db) => {
        await db.query(`drop trigger if exists ${fn} on public.delivery_notes`);
        await db.query(`drop function if exists public.${fn}()`);
      });
    }
    // 076:1655-1656: an unexpected database error is caught and answered as one problem; nothing is left half done.
    expect(failed.ok).toBe(false);
    expect(failed.committed).not.toBe(true);
    expect(JSON.stringify(failed.errors)).toContain("C07 injected delivery failure");
    expect(await business(org())).toEqual(before);
    expect(await audit(org())).toEqual(auditBefore);
    expect(await batches(org())).toEqual(batchesBefore);
    expect(await refs(t)).toEqual({ invoices: 0, credit_notes: 0, delivery_notes: 0 });

    const retry = await importData(file(t), false, op);
    expect(retry.errors ?? []).toEqual([]);
    expect(retry).toMatchObject({ ok: true, committed: true });
    expect(retry.replayed).not.toBe(true);
    expect(await refs(t)).toEqual({ invoices: 2, credit_notes: 1, delivery_notes: 1 });
    expect(await sql("select l.description, l.quantity::text from public.delivery_note_items l join public.delivery_notes d on d.id = l.delivery_note_id where d.organization_id = $1 and d.dn_number = $2",
      [org(), `DLN-C07${t}`])).toEqual([{ description: "Synthetic part", quantity: "2.000" }]);
    expect(await sql("select i.invoice_ref, i.credited_amount::text, c.allocated_amount::text from public.credit_notes c join public.invoices i on i.id = c.invoice_id where c.organization_id = $1 and c.credit_ref = $2",
      [org(), `CRD-C07${t}`])).toEqual([{ invoice_ref: `INV-C07${t}-1`, credited_amount: "10.00", allocated_amount: "10.00" }]);
    // 140: the app import never sets the SliQ reference.
    expect(await sql("select count(*)::int as n from public.invoices where organization_id = $1 and invoice_ref like $2 and source_ref is not null", [org(), `INV-C07${t}-%`])).toEqual([{ n: 0 }]);

    // The same key again answers the first result and writes nothing; the same file under a new key matches everything.
    const after = await business(org());
    expect(await importData(file(t), false, op)).toMatchObject({ ok: true, replayed: true });
    expect(await business(org())).toEqual(after);
    const again = await importData(file(t), false);
    expect(again).toMatchObject({ ok: true });
    expect(Object.values(created(again)).every((n) => n === 0)).toBe(true);
    expect(again.counts?.credit_notes).toMatchObject({ created: 0, matched_existing: 1 });
    expect(again.counts?.delivery_notes).toMatchObject({ created: 0, matched_existing: 1 });
    expect(await business(org())).toEqual(after);
    expect(await refs(t)).toEqual({ invoices: 2, credit_notes: 1, delivery_notes: 1 });
  });

  it("large import with credit and delivery notes: committed part by part, undone back to exactly the records before (none lost), then imported again once (none duplicated)", async () => {
    const u = randomUUID().slice(0, 6);
    const f = file(u);
    const parts = [{ customers: f.customers, invoices: f.invoices }, { credit_notes: f.credit_notes }, { delivery_notes: f.delivery_notes }];
    const stageValidateCommit = async () => {
      const id = randomUUID();
      for (const [i, p] of parts.entries()) {
        expect(await call(admin(), "select public.import_stage_part($1, $2, $3::jsonb) as r", [id, i + 1, JSON.stringify({ file_name: f.file_name, file_sha256: SHA, ...p })]))
          .toMatchObject({ status: "staging" });
      }
      const v = await call(admin(), "select public.import_validate($1, $2, $3) as r", [id, 10, randomUUID()]);
      expect(v.errors ?? []).toEqual([]);
      expect(v.ok).toBe(true);
      let last = v;
      for (let i = 0; i < 50 && last.parts_committed !== last.parts; i++) {
        last = await call(admin(), "select public.import_commit_part($1, $2) as r", [id, randomUUID()]);
        expect(last.ok, JSON.stringify(last)).toBe(true);
      }
      expect(last.parts_committed).toBe(v.parts);
      return id;
    };
    // Records of the company from before this import (the small import above) must all survive the undo.
    const before = await business(org());
    expect(before.invoices.length).toBeGreaterThan(0);
    const id = await stageValidateCommit();
    expect(await refs(u)).toEqual({ invoices: 2, credit_notes: 1, delivery_notes: 1 });

    let undone: Result = { ok: true };
    for (let i = 0; i < 50 && undone.status !== "undone"; i++) undone = await call(admin(), "select public.import_undo($1, $2) as r", [id, randomUUID()]);
    expect(undone).toMatchObject({ status: "undone" });
    expect(undone.refused_count ?? 0).toBe(0);
    expect(await business(org()), "after undo: exactly the business records of before, none lost").toEqual(before);
    expect(await refs(u)).toEqual({ invoices: 0, credit_notes: 0, delivery_notes: 0 });

    await stageValidateCommit();
    expect(await refs(u), "imported again after the undo: each record once").toEqual({ invoices: 2, credit_notes: 1, delivery_notes: 1 });
  });
});

describe("C07: the SliQ legacy CLI (scripts/sliq-import) as the owner role, under safeupdate", () => {
  const FIXTURE = path.resolve(__dirname, "../fixtures/sliq/basic");
  const SQL_DIR = path.resolve(__dirname, "../../supabase");
  const EXCLUDE = ["S1011", "S1012", "Q2004"];
  const RES = path.resolve(__dirname, "../fixtures/sliq/basic-resolutions.json");
  const synthetic = getProfile("synthetic");
  let url = "";
  let reportPath = "";
  let importerWasInstalled = false;
  let rehearsalWasPrepared = false;
  const base = () => ({ folder: FIXTURE, mapping: "synthetic", databaseUrl: url, organizationId: cliOrg(), excludeNumbers: EXCLUDE, resolutionsPath: RES });
  const write = () => writeRun({ ...base(), reportPath, write: true });
  const ids = () => {
    const { plan } = analyse(loadFolder(FIXTURE, synthetic), { organizationId: cliOrg(), excludeNumbers: EXCLUDE });
    const all = (xs: { oldId: number }[]) => xs.map((x) => String(x.oldId));
    return [...all(plan.customers), ...all(plan.suppliers), ...all(plan.stock), ...all(plan.purchaseOrders), ...all(plan.quotes), ...all(plan.invoices),
      ...all(plan.invoices.flatMap((i: { payments: { oldId: number }[] }) => i.payments))];
  };
  const mapRows = async () => (await sql<{ r: string }>("select to_jsonb(m)::text as r from public.legacy_import_map m where old_id = any($1::text[]) order by 1", [ids()])).map((x) => x.r);
  const state = async () => ({ business: await business(cliOrg()), map: await mapRows() });

  beforeAll(async () => {
    url = isolatedBackend().databaseUrl;
    await withDb(async (db) => {
      importerWasInstalled = (await db.query("select to_regclass('public.legacy_import_map') as t")).rows[0].t !== null;
      await db.query(readFileSync(path.join(SQL_DIR, "import/import_legacy_tenant.sql"), "utf8"));
      rehearsalWasPrepared = (await db.query("select to_regclass('public.rehearsal_identity') as t")).rows[0].t !== null;
    });
    await prepareRehearsal(url);
  });
  afterAll(async () => {
    if (!world) return;
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query("delete from public.legacy_import_map where old_id = any($1::text[])", [ids()]);
      if (!rehearsalWasPrepared) await db.query("drop table public.rehearsal_identity");
      if (!importerWasInstalled) {
        await db.query("drop function public.import_legacy_tenant(jsonb, uuid)");
        await db.query("drop table public.legacy_import_map, public.legacy_audit_log");
      }
      await db.query("commit");
    });
  });

  it("dry run: the report is made and nothing is written (business rows, legacy map and audit log identical)", async () => {
    const [before, auditBefore] = [await state(), await audit(cliOrg())];
    const out = mkdtempSync(path.join(tmpdir(), "c07-sliq-"));
    const { report } = await dryRun({ ...base(), outDir: out });
    expect(report.collisions).toMatchObject({ checked: true, invoices: [], quotes: [] });
    expect(report.unresolvedReviewCount).toBe(0);
    reportPath = path.join(out, "report.json");
    expect(await state()).toEqual(before);
    expect(await audit(cliOrg())).toEqual(auditBefore);
  });

  it("failure midway (a payment INSERT fails after the importer wrote customers, quotes and invoices): the whole transaction rolls back; the retry writes it once; a repeat adds nothing", async () => {
    const [before, auditBefore] = [await state(), await audit(cliOrg())];
    const fn = `c07_cli_fail_${randomUUID().slice(0, 6)}`;
    await sql(`create function public.${fn}() returns trigger language plpgsql as $$ begin if new.reference = 'CHQ 55' then raise exception 'C07 injected payment failure'; end if; return new; end $$`);
    await sql(`create trigger ${fn} before insert on public.invoice_payments for each row execute function public.${fn}()`);
    try {
      await expect(write()).rejects.toThrowError(/C07 injected payment failure/);
    } finally {
      await sql(`drop trigger if exists ${fn} on public.invoice_payments`);
      await sql(`drop function if exists public.${fn}()`);
    }
    expect(await state()).toEqual(before);
    expect(await audit(cliOrg())).toEqual(auditBefore);

    const res = await write();
    expect(res.created).toEqual({ invoices: 10, lines: 9, payments: 4, paymentToConfirm: 6, quoteLines: 1 });
    const once = await state();
    expect(once.business.invoices.length - before.business.invoices.length).toBe(10);
    expect(await sql("select invoice_ref, count(*)::int as n from public.invoices where organization_id = $1 group by 1 having count(*) > 1", [cliOrg()])).toEqual([]);

    const again = await write();
    expect(again.created).toEqual({ invoices: 0, lines: 0, payments: 0, paymentToConfirm: 0, quoteLines: 0 });
    expect(await state()).toEqual(once);
  });

  it("source_ref (140): the owner role may set it under safeupdate; the signed-in admin can neither set it on a new invoice nor change it", async () => {
    const set = await withDb((db) => db.query("update public.invoices set source_ref = 'S1013' where organization_id = $1 and invoice_ref = 'S1013'", [cliOrg()]));
    expect(set.rowCount).toBe(1);
    expect(await refusal(cliAdmin(), "update public.invoices set source_ref = 'S1013-X' where organization_id = $1 and invoice_ref = 'S1013'", [cliOrg()]))
      .toMatchObject({ code: "42501", hint: "source_ref_import_only" });
    expect(await refusal(cliAdmin(), "insert into public.invoices (organization_id, customer, status, source_ref) values ($1, 'C07 source ref', 'draft', 'S9999')", [cliOrg()]))
      .toMatchObject({ code: "42501", hint: "source_ref_import_only" });
    expect(await sql("select source_ref from public.invoices where organization_id = $1 and invoice_ref = 'S1013'", [cliOrg()])).toEqual([{ source_ref: "S1013" }]);
  });
});
