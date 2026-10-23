/**
 * SliQ importer (PR B) against the local disposable stack: a dry run writes nothing; a rehearsal write lands in one
 * synthetic tenant through the existing importer (public.import_legacy_tenant / legacy_import_map), payments become
 * legacy payment rows (migration 032), unevidenced payments stay "Payment to confirm", a repeat run adds nothing, the other
 * tenant is untouched, a stale report refuses, and a failure part-way leaves nothing behind. Synthetic fixtures only.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dryRun, writeRun } from "../../scripts/sliq-import/cli.mjs";
import { prepareRehearsal } from "../../scripts/sliq-import/write.mjs";
import { GuardError } from "../../scripts/sliq-import/guard.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile } from "../../scripts/sliq-import/mapping.mjs";
import { analyse } from "../../scripts/sliq-import/reconcile.mjs";
import { owed } from "@/lib/receivables";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

const FIXTURE = path.resolve(__dirname, "../fixtures/sliq/basic");
const SQL_DIR = path.resolve(__dirname, "../../supabase");
const EXCLUDE = ["S1011", "S1012", "Q2004"]; // reverse charge and discount documents: excluded by number
const RES = path.resolve(__dirname, "../fixtures/sliq/basic-resolutions.json");
const synthetic = getProfile("synthetic");

let world: SyntheticWorld;
let alpha: string;
let beta: string;
let url: string;
let importerWasInstalled = false;
let rehearsalWasPrepared = false;
let rehearsalId = "";
let reportPath: string;

const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(sql, params)).rows);
const counts = async (org: string) =>
  (
    await q<{ t: string; n: string }>(
      `select 'customers' t, count(*) n from public.customers where organization_id = $1
       union all select 'quotes', count(*) from public.quotes where organization_id = $1
       union all select 'invoices', count(*) from public.invoices where organization_id = $1
       union all select 'lines', count(*) from public.invoice_line_items where organization_id = $1
       union all select 'payments', count(*) from public.invoice_payments where organization_id = $1
       union all select 'suppliers', count(*) from public.suppliers where organization_id = $1
       union all select 'stock', count(*) from public.stock where organization_id = $1
       union all select 'purchase_orders', count(*) from public.purchase_orders where organization_id = $1
       union all select 'quote_lines', count(*) from public.quote_line_items where organization_id = $1`,
      [org],
    )
  ).reduce((a, r) => ({ ...a, [r.t]: Number(r.n) }), {} as Record<string, number>);
const mapCount = async () => Number((await q<{ n: string }>("select count(*)::text n from public.legacy_import_map where source in ('customers','quotes','invoices','sliq_payments') and length(old_id) >= 16"))[0].n);

function copyFixture(edit?: (file: string, text: string) => string) {
  const dir = mkdtempSync(path.join(tmpdir(), "sliq-db-"));
  cpSync(FIXTURE, dir, { recursive: true });
  if (edit) for (const f of ["invoices.csv", "payments.csv"]) writeFileSync(path.join(dir, f), edit(f, readFileSync(path.join(dir, f), "utf8")));
  return dir;
}

async function ids(org: string) {
  const { plan } = analyse(loadFolder(FIXTURE, synthetic), { organizationId: org, excludeNumbers: EXCLUDE });
  const all = (xs: { oldId: number }[]) => xs.map((x) => String(x.oldId));
  return [...all(plan.customers), ...all(plan.suppliers), ...all(plan.stock), ...all(plan.purchaseOrders), ...all(plan.quotes), ...all(plan.invoices), ...all(plan.invoices.flatMap((i: { payments: { oldId: number }[] }) => i.payments))];
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  alpha = world.tenants.alpha.id;
  beta = world.tenants.beta.id;
  url = isolatedBackend().databaseUrl;
  await withDb(async (db) => {
    importerWasInstalled = (await db.query("select to_regclass('public.legacy_import_map') as t")).rows[0].t !== null;
    await db.query(readFileSync(path.join(SQL_DIR, "import/import_legacy_tenant.sql"), "utf8"));
  });
  // The "prepare rehearsal copy" step: this database becomes the one prepared rehearsal copy the reports are bound to.
  rehearsalWasPrepared = (await q<{ t: string | null }>("select to_regclass('public.rehearsal_identity')::text as t"))[0].t !== null;
  rehearsalId = await prepareRehearsal(url);
  // Another company with its own document counters, and an invoice number above its counter: a global reseed would move it.
  await q("insert into public.invoices (organization_id, invoice_ref, customer, status, total) values ($1, 'INV-0099', 'Other Co Customer', 'draft', 5)", [beta]);
  await q("insert into public.doc_counters (organization_id, prefix, last) values ($1, 'INV', 7), ($1, 'QUO', 3)", [beta]);
  // Another tenant already holds an invoice with a SliQ number: a collision if SliQ were imported there, and a witness
  // that the alpha import never touches beta.
  await q("insert into public.invoices (organization_id, invoice_ref, customer, status, total) values ($1, 'S1001', 'Existing Beta Customer', 'draft', 5)", [beta]);
});

afterAll(async () => {
  if (!world) return;
  await q("drop trigger if exists sliq_test_fail on public.invoice_payments");
  await q("drop function if exists public.sliq_test_fail()");
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    const all = [...(await ids(alpha)), ...(await ids(beta))];
    await db.query("delete from public.legacy_import_map where old_id = any($1::text[])", [all]);
    if (!rehearsalWasPrepared) await db.query("drop table public.rehearsal_identity");
    if (!importerWasInstalled) {
      await db.query("drop function public.import_legacy_tenant(jsonb, uuid)");
      await db.query("drop table public.legacy_import_map, public.legacy_audit_log");
    }
    await db.query("commit");
  });
  await destroySyntheticWorld(world.runId);
});

describe("SliQ import into one organisation", () => {
  it("a dry run (with the read-only collision check) writes nothing and reports collisions", async () => {
    const [aBefore, bBefore, mBefore] = [await counts(alpha), await counts(beta), await mapCount()];
    const out = mkdtempSync(path.join(tmpdir(), "sliq-out-"));
    const { report } = await dryRun({ folder: FIXTURE, outDir: out, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: RES });
    expect(report.collisions).toMatchObject({ checked: true, invoices: [], quotes: [] });
    expect(report.unresolvedReviewCount).toBe(0);
    expect(await counts(alpha)).toEqual(aBefore);
    expect(await counts(beta)).toEqual(bBefore);
    expect(await mapCount()).toBe(mBefore);
    expect(JSON.parse(readFileSync(path.join(out, "report.json"), "utf8")).organizationId).toBe(alpha);
    expect(readFileSync(path.join(out, "report.md"), "utf8")).toContain("checked against the target organisation");
    reportPath = path.join(out, "report.json");

    // The same files aimed at the tenant that already holds S1001: that number is a collision and the invoice is held.
    const b = await dryRun({ folder: FIXTURE, outDir: mkdtempSync(path.join(tmpdir(), "sliq-out-")), mapping: "synthetic", databaseUrl: url, organizationId: beta, excludeNumbers: EXCLUDE, resolutionsPath: RES });
    expect(b.report.collisions.invoices.map((x: { number: string }) => x.number)).toEqual(["S1001"]);
    expect(b.report.held.find((h: { number: string }) => h.number === "S1001").reasons.join()).toContain("already used");
    expect(await counts(beta)).toEqual(bBefore);
  });

  it("refuses to write while a flagged document is unresolved, and writes nothing", async () => {
    const before = await counts(alpha);
    const out = mkdtempSync(path.join(tmpdir(), "sliq-out-"));
    await dryRun({ folder: FIXTURE, outDir: out, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: [], resolutionsPath: RES });
    await expect(writeRun({ folder: FIXTURE, reportPath: path.join(out, "report.json"), mapping: "synthetic", databaseUrl: url, organizationId: alpha, resolutionsPath: RES, write: true })).rejects.toThrowError(/reverse charge or discounts are unresolved: Q2004, S1011, S1012/);
    expect(await counts(alpha)).toEqual(before);
  });

  it("refuses a database URL or flags that are not allowed", async () => {
    await expect(writeRun({ folder: FIXTURE, reportPath, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: RES, write: false })).rejects.toThrow(GuardError);
    await expect(writeRun({ folder: FIXTURE, reportPath, mapping: "synthetic", databaseUrl: "postgresql://postgres:x@db.abc.supabase.co:5432/postgres", organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: RES, write: true })).rejects.toThrow(/hosted Supabase/);
  });

  it("a rehearsal write lands in one tenant: documents, lines, legacy payments, Payment to confirm", async () => {
    const bBefore = await counts(beta);
    const otherCounters = () => q("select organization_id, prefix, last from public.doc_counters where organization_id <> $1 order by 1, 2", [alpha]);
    const countersBefore = await otherCounters();
    expect(countersBefore.filter((c) => c.organization_id === beta)).toEqual([{ organization_id: beta, prefix: "INV", last: 7 }, { organization_id: beta, prefix: "QUO", last: 3 }]);
    const res = await writeRun({ folder: FIXTURE, reportPath, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: RES, write: true });
    expect(res.created).toEqual({ invoices: 10, lines: 9, payments: 4, paymentToConfirm: 6, quoteLines: 1 });
    expect(await counts(alpha)).toEqual({ customers: 5, quotes: 3, invoices: 10, lines: 9, payments: 4, suppliers: 2, stock: 1, purchase_orders: 1, quote_lines: 1 });
    expect(await counts(beta)).toEqual(bBefore); // isolation
    // The importer reseeds the target company's counters only: every other company's counters are exactly as they were,
    // although beta holds INV-0099 above its counter of 7 (a global reseed would have raised it).
    expect(await otherCounters()).toEqual(countersBefore);

    type Inv = { invoice_ref: string; status: string; subtotal: string; vat: string; total: string; amount_paid: string; paid_at: string | null; payment_unverified: boolean; invoice_date: string; due_date: string | null; sum: string; lines: string };
    const invs = await q<Inv>(
      `select i.invoice_ref, i.status, i.subtotal::text, i.vat::text, i.total::text, i.amount_paid::text, i.paid_at::text, i.payment_unverified, i.invoice_date::text, i.due_date::text,
              coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id), 0)::text as sum,
              (select count(*) from public.invoice_line_items l where l.invoice_id = i.id)::text as lines
       from public.invoices i where i.organization_id = $1 order by i.invoice_ref`, [alpha]);
    const by = Object.fromEntries(invs.map((i) => [i.invoice_ref, i]));
    expect(invs.map((i) => i.invoice_ref)).toEqual(["S1001", "S1002", "S1003", "S1004", "S1005", "S1006", "S1007", "S1010", "S1013", "S1016"]);

    // Totals are the stated header figures, exactly.
    expect([by.S1002.subtotal, by.S1002.vat, by.S1002.total]).toEqual(["500.00", "100.00", "600.00"]);
    expect([by.S1010.subtotal, by.S1010.vat, by.S1010.total]).toEqual(["100.00", "20.00", "120.00"]); // lines say 90: kept as stated
    expect(by.S1001.invoice_date).toBe("2026-03-01");
    expect(by.S1001.due_date).toBe("2026-03-31");

    // Paid, part paid: payments are legacy rows and amount_paid == sum of payments.
    expect([by.S1001.status, by.S1001.amount_paid, by.S1001.sum, by.S1001.payment_unverified]).toEqual(["paid", "120.00", "120.00", false]);
    expect(by.S1001.paid_at).toContain("2026-03-05");
    expect([by.S1002.status, by.S1002.amount_paid, by.S1002.sum, by.S1002.payment_unverified]).toEqual(["partial", "200.00", "200.00", false]);
    expect(by.S1002.paid_at).toBeNull();
    expect([by.S1004.status, by.S1004.amount_paid, by.S1004.sum]).toEqual(["paid", "112.50", "112.50"]);
    for (const i of invs.filter((x) => !x.payment_unverified)) expect(Number(i.amount_paid)).toBe(Number(i.sum));

    // Not evidenced: unpaid with no records, overpaid, undated payment, and the rest: Payment to confirm, nothing invented.
    for (const n of ["S1003", "S1005", "S1006", "S1007", "S1010", "S1016"]) {
      expect([n, by[n].status, Number(by[n].amount_paid), Number(by[n].sum), by[n].payment_unverified]).toEqual([n, "sent", 0, 0, true]);
    }
    expect([by.S1013.status, by.S1013.payment_unverified]).toEqual(["draft", false]);

    // Kept out of receivables and chasers; the part-paid balance stays owed.
    const asOwed = (i: Inv) => owed({ status: i.status, total: Number(i.total), amount_paid: Number(i.amount_paid), payment_unverified: i.payment_unverified } as never);
    expect(invs.filter((i) => i.payment_unverified).map(asOwed)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(asOwed(by.S1002)).toBe(400);
    expect(asOwed(by.S1001)).toBe(0);

    // Lines: real ones where the source has them, none invented otherwise (header only), none where VAT is unresolved.
    expect(Object.fromEntries(invs.map((i) => [i.invoice_ref, Number(i.lines)]))).toEqual({ S1001: 1, S1002: 1, S1003: 1, S1004: 2, S1005: 0, S1006: 1, S1007: 0, S1010: 1, S1013: 1, S1016: 1 });
    const mixed = await q<{ vat_pct: string; unit_price: string }>("select l.vat_pct::text, l.unit_price::text from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id where i.organization_id = $1 and i.invoice_ref = 'S1004' order by l.position", [alpha]);
    expect(mixed.map((m) => [m.vat_pct, m.unit_price])).toEqual([["20.00", "50.00"], ["5.00", "50.00"]]);

    // Payments: legacy rows with the evidenced date, method (unmapped method blank) and reference.
    const pays = await q<{ invoice_ref: string; amount: string; paid_on: string; source: string; method: string | null; reference: string | null }>(
      "select i.invoice_ref, p.amount::text, p.paid_on::text, p.source, p.method, p.reference from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where p.organization_id = $1 order by i.invoice_ref, p.paid_on", [alpha]);
    expect(pays).toEqual([
      { invoice_ref: "S1001", amount: "120.00", paid_on: "2026-03-05", source: "legacy", method: "BACS", reference: "REF1" },
      { invoice_ref: "S1002", amount: "100.00", paid_on: "2026-03-10", source: "legacy", method: "cheque", reference: "CHQ 55" },
      { invoice_ref: "S1002", amount: "100.00", paid_on: "2026-03-20", source: "legacy", method: null, reference: null },
      { invoice_ref: "S1004", amount: "112.50", paid_on: "2026-03-12", source: "legacy", method: "card", reference: null },
    ]);

    // Held and excluded documents did not land; credit notes were not written or netted.
    expect(await q("select 1 from public.invoices where organization_id = $1 and invoice_ref in ('S1008','S1009','S1011','S1012','S1015','CN-001','CN-002','CN-003')", [alpha])).toEqual([]);
    expect((await q<{ quote_ref: string; total_value: string; status: string }>("select quote_ref, total_value::text, status from public.quotes where organization_id = $1 order by quote_ref", [alpha])).map((x) => [x.quote_ref, x.total_value, x.status])).toEqual([["Q2001", "240.00", "sent"], ["Q2002", "480.00", "accepted"], ["Q2005", "60.00", "draft"]]);
    const cust = await q<{ name: string; contact_name: string | null; address: string | null; notes: string | null }>("select name, contact_name, address, notes from public.customers where organization_id = $1 order by name", [alpha]);
    expect(cust).toHaveLength(5);
    expect(cust.find((c) => c.name === "Alpha Fabrications Ltd")).toMatchObject({ contact_name: "Ann Alpha", address: "1 Mill Lane, Leeds, LS1 1AA", notes: "VAT number: GB000000001" });
    // Suppliers keep their address in the notes; one stock item (the other product has no Stock figure); one purchase order header.
    const sup = await q<{ name: string; contact_name: string | null; notes: string | null }>("select name, contact_name, notes from public.suppliers where organization_id = $1 order by name", [alpha]);
    expect(sup[0]).toMatchObject({ name: "Steel Supplies Ltd", contact_name: "Sam Steel", notes: "Address: 7 Foundry Road, Sheffield\nNet 30" });
    expect(await q("select sku, material, current_stock, unit_price::text, auto_purchase from public.stock where organization_id = $1", [alpha])).toEqual([{ sku: "P001", material: "Bracket", current_stock: 40, unit_price: "10", auto_purchase: false }]);
    expect(await q("select po_ref, supplier, status, total_value::text, order_date::text, expected_delivery::text, items from public.purchase_orders where organization_id = $1", [alpha])).toEqual([
      { po_ref: "PO-0001", supplier: "Steel Supplies Ltd", status: "sent", total_value: "250.00", order_date: "2026-03-01", expected_delivery: "2026-03-15", items: [] },
    ]);
    expect(await q("select q.quote_ref, l.description, l.quantity::text, l.unit_price::text, l.vat_pct::text, q.created_at::date::text as d from public.quote_line_items l join public.quotes q on q.id = l.quote_id where l.organization_id = $1", [alpha])).toEqual([
      { quote_ref: "Q2001", description: "Fabrication", quantity: "2.000", unit_price: "100.00", vat_pct: "20.00", d: "2026-02-01" },
    ]);
    // The credit-note allocation (CN-001 against S1003) is not a payment row.
    expect(await q("select 1 from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.organization_id = $1 and i.invoice_ref = 'S1003'", [alpha])).toEqual([]);
    // Every row is in the given organisation: nothing of this import carries another organisation id.
    expect(await q("select 1 from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where p.organization_id <> i.organization_id")).toEqual([]);
  });

  it("running the write again imports nothing new", async () => {
    const before = await counts(alpha);
    const mapBefore = await mapCount();
    const res = await writeRun({ folder: FIXTURE, reportPath, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: RES, write: true });
    expect(res.created).toEqual({ invoices: 0, lines: 0, payments: 0, paymentToConfirm: 0, quoteLines: 0 });
    for (const t of ["customers", "quotes", "invoices"]) expect(res.importer.tables[t]).toMatchObject({ inserted: 0, matched_existing: 0, already_imported: expect.any(Number) });
    expect(await counts(alpha)).toEqual(before);
    expect(await mapCount()).toBe(mapBefore);
    // The amounts were not re-applied either.
    expect((await q<{ amount_paid: string }>("select amount_paid::text from public.invoices where organization_id = $1 and invoice_ref = 'S1002'", [alpha]))[0].amount_paid).toBe("200.00");
  });

  it("a stale report (a file changed since the dry run) refuses and writes nothing", async () => {
    const dir = copyFixture((f, t) => (f === "payments.csv" ? `${t}S1003,01/04/2026,300.00,BACS,LATE\n` : t));
    const before = await counts(alpha);
    await expect(writeRun({ folder: dir, reportPath, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: RES, write: true })).rejects.toThrowError(/report is stale[\s\S]*payments\.csv/);
    expect(await counts(alpha)).toEqual(before);
  });

  it("a report made for another organisation refuses", async () => {
    await expect(writeRun({ folder: FIXTURE, reportPath, mapping: "synthetic", databaseUrl: url, organizationId: beta, excludeNumbers: EXCLUDE, resolutionsPath: RES, write: true })).rejects.toThrowError(/different organisation/);
  });

  it("the provisional sliq mapping dry-runs against the database but refuses to write", async () => {
    const prov = path.resolve(__dirname, "../fixtures/sliq/provisional");
    const before = await counts(alpha);
    const out = mkdtempSync(path.join(tmpdir(), "sliq-out-"));
    const flags = { encoding: "windows-1252", dateFormat: "DD/MM/YYYY" };
    const { report } = await dryRun({ folder: prov, outDir: out, mapping: "sliq", databaseUrl: url, organizationId: alpha, excludeNumbers: ["00045"], resolutionsPath: RES, ...flags });
    expect(report.provisionalNotice).toBe("Provisional mapping, confirm against the real headers.");
    expect(report.collisions.checked).toBe(true);
    await expect(writeRun({ folder: prov, reportPath: path.join(out, "report.json"), mapping: "sliq", databaseUrl: url, organizationId: alpha, excludeNumbers: ["00045"], resolutionsPath: RES, write: true, ...flags })).rejects.toThrowError(/provisional mapping, confirm against the real headers/);
    expect(await counts(alpha)).toEqual(before);
  });

  it("the target must be the rehearsal copy the report was made for", async () => {
    const before = await counts(alpha);
    const rep = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(rep.rehearsal).toEqual({ checked: true, id: rehearsalId });
    const write = (r: object) => {
      const f = path.join(mkdtempSync(path.join(tmpdir(), "sliq-rep-")), "report.json");
      writeFileSync(f, JSON.stringify(r));
      return writeRun({ folder: FIXTURE, reportPath: f, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: RES, write: true });
    };
    // a report that names no rehearsal copy, and one that names a different one
    await expect(write({ ...rep, rehearsal: { checked: true, id: null } })).rejects.toThrowError(/no rehearsal identity/);
    await expect(write({ ...rep, rehearsal: { checked: true, id: "00000000-0000-4000-8000-000000000000" } })).rejects.toThrowError(/not the rehearsal copy the report was made for/);
    // a target that has no rehearsal identity at all (production never has the table)
    await q("alter table public.rehearsal_identity rename to rehearsal_identity_hidden");
    try {
      await expect(write(rep)).rejects.toThrowError(/target: no rehearsal identity/);
      const out = mkdtempSync(path.join(tmpdir(), "sliq-out-"));
      const { report } = await dryRun({ folder: FIXTURE, outDir: out, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: RES });
      expect(report.rehearsal).toEqual({ checked: true, id: null });
    } finally {
      await q("alter table public.rehearsal_identity_hidden rename to rehearsal_identity");
    }
    expect(await counts(alpha)).toEqual(before);
  });

  it("an unresolved credit note, or a changed resolution file, refuses and writes nothing", async () => {
    const before = await counts(alpha);
    const out = mkdtempSync(path.join(tmpdir(), "sliq-out-"));
    await dryRun({ folder: FIXTURE, outDir: out, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE });
    await expect(writeRun({ folder: FIXTURE, reportPath: path.join(out, "report.json"), mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, write: true })).rejects.toThrowError(/credit notes or allocations are unresolved/);
    const edited = JSON.parse(readFileSync(RES, "utf8"));
    edited.resolutions[1].note = "edited after the report was approved";
    const f = path.join(mkdtempSync(path.join(tmpdir(), "sliq-res-")), "res.json");
    writeFileSync(f, JSON.stringify(edited));
    await expect(writeRun({ folder: FIXTURE, reportPath, mapping: "synthetic", databaseUrl: url, organizationId: alpha, excludeNumbers: EXCLUDE, resolutionsPath: f, write: true })).rejects.toThrowError(/credit-note resolution file/);
    expect(await counts(alpha)).toEqual(before);
  });

  it("is all or nothing: a failure part-way rolls the whole import back", async () => {
    // beta already holds S1001, so that invoice is held there; the rest would land. A trigger makes one payment fail.
    const out = mkdtempSync(path.join(tmpdir(), "sliq-out-"));
    await dryRun({ folder: FIXTURE, outDir: out, mapping: "synthetic", databaseUrl: url, organizationId: beta, excludeNumbers: EXCLUDE, resolutionsPath: RES });
    const before = await counts(beta);
    const mapBefore = await mapCount();
    await q("create or replace function public.sliq_test_fail() returns trigger language plpgsql as $$ begin if new.reference = 'CHQ 55' then raise exception 'sliq test failure'; end if; return new; end $$");
    await q("create trigger sliq_test_fail before insert on public.invoice_payments for each row execute function public.sliq_test_fail()");
    try {
      await expect(writeRun({ folder: FIXTURE, reportPath: path.join(out, "report.json"), mapping: "synthetic", databaseUrl: url, organizationId: beta, excludeNumbers: EXCLUDE, resolutionsPath: RES, write: true })).rejects.toThrowError(/sliq test failure/);
    } finally {
      await q("drop trigger if exists sliq_test_fail on public.invoice_payments");
    }
    expect(await counts(beta)).toEqual(before);
    expect(await mapCount()).toBe(mapBefore);
  });
});
