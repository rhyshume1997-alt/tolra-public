/**
 * Go-live smoke, SMOKE 8-16: SYNTHETIC SliQ report-style exports (scripts/golive-smoke/sliq/generate.mjs), the pre-processor
 * (scripts/golive-smoke/sliq/preprocess.mjs), then the REAL Admin > Data importer, public.import_company_data (076 as 079/085 left it),
 * called as a signed-in admin of a synthetic company the way PostgREST calls it (role authenticated, the JWT claims; the same path as
 * tests/db/data-import-pr2.test.ts). The company is made with the product's own create_organization. Synthetic data only.
 *
 * Behaviour the importer does not have at this SHA is printed as a named KNOWN GAP line (never pretended), from what it actually did.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generate } from "../../../scripts/golive-smoke/sliq/generate.mjs";
import { Refused, parsePence, prepareFolder, prepareInvoices } from "../../../scripts/golive-smoke/sliq/preprocess.mjs";
import { verifyBackendIdentity, withDb } from "../../support/fixtures";
import { knownGap, stepRunner } from "./results";

type Counts = { created: number; matched_existing: number; errors: number };
type Result = { ok: boolean; committed: boolean; counts: Record<string, Counts>; error_count: number; errors: { kind: string | null; row: number | null; field: string | null; message: string }[]; warnings: { kind: string | null; field: string | null; message: string }[] };

const { step } = stepRunner({ rethrow: true });
const SHA = "c".repeat(64);
const data = generate();
const E = data.expected;
let dir = "";
let org = "";
let adminId = "";
let payload: Record<string, unknown[]> = {};

/** One statement as the company's admin, signed in as PostgREST does it, in its own transaction. */
async function asAdmin<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: adminId, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: "aal1" }), adminId]);
      const rows = (await db.query<T>(text, params)).rows;
      await db.query("commit");
      return rows;
    } catch (error) { await db.query("rollback"); throw error; }
  });
}
const importAs = async (body: Record<string, unknown>, dry: boolean) =>
  (await asAdmin<{ r: Result }>("select public.import_company_data($1::jsonb, $2, $3) as r", [JSON.stringify({ file_name: "sliq-synthetic.xlsx", file_sha256: SHA, ...body }), dry, randomUUID()]))[0].r;
const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);
const BUSINESS = ["customers", "invoices", "invoice_line_items", "invoice_payments", "credit_notes", "credit_note_lines", "invoice_credit_allocations", "import_record_keys", "doc_counters"];
const checksums = () => withDb(async (db) => {
  const out: Record<string, string> = {};
  for (const t of BUSINESS) out[t] = (await db.query<{ m: string }>(`select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by to_jsonb(r)::text), '')) as m from public.${t} r where organization_id = $1`, [org])).rows[0].m;
  return out;
});
const rowCounts = async () => Object.fromEntries((await sql<{ t: string; n: number }>(BUSINESS.map((t) => `select '${t}' as t, count(*)::int as n from public.${t} where organization_id = $1`).join(" union all "), [org])).map((r) => [r.t, r.n]));
const problems = (r: Result) => r.errors.map((e) => `${e.kind}.${e.field} row ${e.row}: ${e.message}`);

beforeAll(async () => {
  await verifyBackendIdentity();
  dir = mkdtempSync(path.join(tmpdir(), "golive-sliq-"));
  for (const [name, text] of Object.entries(data.files)) writeFileSync(path.join(dir, name), text);
  // A synthetic company of its own, made by the product's create_organization (as the service role does), with one admin.
  const run = randomUUID().slice(0, 8);
  adminId = randomUUID();
  const email = `admin.sliq.${run}@example.test`;
  await sql("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [adminId, email]);
  org = (await sql<{ id: string }>("select public.create_organization($1, $2, $3, $4::jsonb) as id", [`Golive SliQ Synthetic ${run}`, `t-golive-sliq-${run}`, email,
    JSON.stringify({ documentName: `Golive SliQ Synthetic ${run}`, addressLines: ["1 Test Road", "Testtown"], email, vatRegistered: true, vatNumber: "GB 000 0000 00", defaultVatRate: 20 })]))[0].id;
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("go-live smoke: SliQ synthetic exports through the pre-processor and the real importer", () => {
  it("SMOKE 8 sliq-preprocess", () => step(8, "sliq-preprocess", [], async () => {
    const { payload: p, report } = prepareFolder(dir);
    payload = p as Record<string, unknown[]>;
    expect([p.customers.length, p.invoices.length, p.payments.length, p.credit_notes.length]).toEqual([E.customers, E.invoices, E.payments, 1]);
    expect(report.heldOut.map((c: { credit_ref: string }) => c.credit_ref)).toEqual([E.orphanCredit]);
    expect(report.invoiceChecks.notTwentyPct).toEqual(E.notTwentyPct);
    expect(report.invoiceChecks.reconciliation.every((r: { equal: boolean }) => r.equal)).toBe(true);
    expect(report.paymentChecks.reconciliation.every((r: { equal: boolean }) => r.equal)).toBe(true);
    expect(() => prepareInvoices(data.files["quotes-report.csv"])).toThrow(/Quotes report .* refused as invoices/);
    expect(p.invoices.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(String(i.invoice_date)))).toBe(true);
    return `header found by name on row ${report.invoiceChecks.headerRow}; ${report.invoiceChecks.skipped.group} group and ${report.invoiceChecks.skipped.blank} blank rows and the totals row skipped, totals reconcile to the penny; ${E.invoices} Inv + 1 linked Crd + 1 held out (${E.orphanCredit}); ${E.payments} payments; Quotes report refused as invoices; VAT not 20% listed: ${report.invoiceChecks.notTwentyPct.join(", ")}`;
  }));

  it("SMOKE 9 sliq-invalid-date-refused-whole", () => step(9, "sliq-invalid-date-refused-whole", [8], async () => {
    const bad = data.files["invoices-report.csv"].replace(/^(Inv,SINV-1002,)\d{2}\/\d{2}\/2026/m, "$131/02/2026");
    expect(bad).not.toBe(data.files["invoices-report.csv"]);
    let refused: Refused | null = null;
    try { prepareInvoices(bad); } catch (e) { refused = e as Refused; }
    expect(refused?.message).toMatch(/whole file is refused/);
    // The importer's own rule too: one impossible date in the file and nothing at all is written.
    const before = await checksums();
    const r = await importAs({ ...payload, invoices: payload.invoices.map((i, n) => (n === 1 ? { ...(i as object), invoice_date: "2026-02-31" } : i)) }, false);
    expect(r.ok).toBe(false);
    expect(r.committed).toBe(false);
    expect(problems(r).join(" ")).toMatch(/date/i);
    expect(await checksums()).toEqual(before);
    return `pre-processor: 31/02/2026 refuses the whole file (1 row named); importer given 2026-02-31 in one of ${E.invoices} invoices: ok false, committed false ("${problems(r)[0]?.slice(0, 90)}"), nothing written`;
  }));

  it("SMOKE 10 sliq-dry-run-writes-nothing", () => step(10, "sliq-dry-run-writes-nothing", [8], async () => {
    const before = await checksums();
    const r = await importAs(payload, true);
    expect(problems(r)).toEqual([]);
    expect(r).toMatchObject({ ok: true, committed: false });
    expect([r.counts.invoices.created, r.counts.payments.created, r.counts.credit_notes.created, r.counts.customers.created]).toEqual([E.invoices, E.payments, 1, E.customers]);
    expect(await checksums()).toEqual(before);
    return `dry run: ok, ${r.counts.customers.created} customers / ${r.counts.invoices.created} invoices / ${r.counts.payments.created} payments / ${r.counts.credit_notes.created} credit note would be created; every business table of the company byte-identical after`;
  }));

  it("SMOKE 11 sliq-import-once", () => step(11, "sliq-import-once", [10], async () => {
    const r = await importAs(payload, false);
    expect(problems(r)).toEqual([]);
    expect(r).toMatchObject({ ok: true, committed: true });
    const n = await rowCounts();
    expect([n.customers, n.invoices, n.invoice_payments, n.credit_notes]).toEqual([E.customers, E.invoices, E.payments, 1]);
    const odd = (await sql<{ vat: string; subtotal: string }>("select vat::text, subtotal::text from public.invoices where organization_id = $1 and invoice_ref = $2", [org, E.notTwentyPct[0]]))[0];
    const stated = (payload.invoices as { invoice_ref: string; vat: string }[]).find((i) => i.invoice_ref === E.notTwentyPct[0])!;
    if (odd.vat === stated.vat) knownGap("sliq-header-vat-not-checked", `${E.notTwentyPct[0]}'s VAT ${odd.vat} on net ${odd.subtotal} is 1p off 20% and the importer stored it as stated without a warning; only the pre-processor lists it (a person signs it off)`);
    const withSourceRef = (await sql<{ n: number }>("select count(*)::int n from public.invoices where organization_id = $1 and source_ref is not null", [org]))[0].n;
    if (withSourceRef === 0) knownGap("sliq-source-ref", `no importer path writes invoices.source_ref (140) at this SHA: 0 of ${E.invoices} imported invoices carry SliQ's own number there; the SliQ Num is the Tolra number (unique here, so nothing is lost)`);
    const counters = await sql<{ prefix: string; last: number }>("select prefix, last from public.doc_counters where organization_id = $1 and prefix = 'INV'", [org]);
    return `committed once: ${n.customers} customers, ${n.invoices} invoices, ${n.invoice_payments} payments, ${n.credit_notes} credit note; INV counter ${counters[0]?.last ?? "none"} (SINV numbers are not INV-<digits>, so it stays)`;
  }));

  it("SMOKE 12 sliq-repeat-no-duplicate", () => step(12, "sliq-repeat-no-duplicate", [11], async () => {
    const before = await rowCounts();
    const r = await importAs(payload, false);
    expect(problems(r)).toEqual([]);
    expect(r.ok).toBe(true);
    for (const kind of ["customers", "invoices", "payments", "credit_notes"]) expect(r.counts[kind]?.created ?? 0, kind).toBe(0);
    expect(await rowCounts()).toEqual(before);
    return `the same file again: created 0, matched ${r.counts.customers.matched_existing} customers / ${r.counts.invoices.matched_existing} invoices / ${r.counts.payments.matched_existing} payments / ${r.counts.credit_notes.matched_existing} credit note; row counts unchanged`;
  }));

  it("SMOKE 13 sliq-payments-reconcile", () => step(13, "sliq-payments-reconcile", [11], async () => {
    const rows = await sql<{ invoice_ref: string; customer: string; total: string; amount_paid: string; credited_amount: string; refunded_amount: string; paid: string | null; status: string }>(
      `select i.invoice_ref, i.customer, i.total::text, i.amount_paid::text, i.credited_amount::text, i.refunded_amount::text, i.status,
              (select sum(p.amount)::text from public.invoice_payments p where p.invoice_id = i.id) as paid
       from public.invoices i where i.organization_id = $1 order by i.invoice_ref`, [org]);
    expect(rows).toHaveLength(E.invoices);
    let outstanding = 0;
    const byCustomer: Record<string, number> = {};
    for (const r of rows) {
      expect(parsePence(r.amount_paid), `${r.invoice_ref} amount_paid = its payment rows`).toBe(parsePence(r.paid ?? "0"));
      const balance = parsePence(r.total)! - parsePence(r.amount_paid)! - parsePence(r.credited_amount)! + parsePence(r.refunded_amount)!;
      expect(balance, `${r.invoice_ref} balance`).toBe(E.balances[r.invoice_ref]);
      outstanding += Math.max(balance, 0);
      byCustomer[r.customer] = (byCustomer[r.customer] ?? 0) + balance;
    }
    expect(outstanding).toBe(E.outstanding);
    expect(byCustomer).toEqual(E.byCustomer);
    const twin = await sql<{ n: number }>("select count(*)::int n from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.organization_id = $1 and i.invoice_ref = $2", [org, E.twinInvoice]);
    expect(twin).toEqual([{ n: 2 }]);
    // A later payment on an invoice already imported (the cutover-delta trap, mapping doc section 4).
    const late = await importAs({ payments: [{ invoice_ref: E.creditedInvoice, paid_on: "2026-10-12", amount: "1.00", method: "BACS" }] }, true);
    if (!late.ok) knownGap("sliq-late-payment", `a payment for an invoice already in Tolra is refused by the importer ("${problems(late)[0]?.slice(0, 120)}"): payments after the import go in by hand with Record payment (or one fresh full export at cutover)`);
    const unpaid = rows.filter((r) => E.balances[r.invoice_ref] > 0).length;
    return `every invoice's amount_paid = its payment rows; balances (total - paid - credited) equal the synthetic Unpaid Invoices report for all ${rows.length} invoices (${unpaid} owed, £${(E.outstanding / 100).toFixed(2)}) and the Aged Debtors total per customer, to the penny; the two equal same-day payments both kept`;
  }));

  it("SMOKE 14 sliq-credit-notes-positive-linked", () => step(14, "sliq-credit-notes-positive-linked", [11], async () => {
    const cn = await sql<{ credit_ref: string; total: string; vat: string; invoice_ref: string; allocated: string | null; status: string; credited: string }>(
      `select c.credit_ref, c.total::text, c.vat::text, c.status, i.invoice_ref, i.credited_amount::text as credited,
              (select sum(a.amount)::text from public.invoice_credit_allocations a where a.credit_note_id = c.id and a.invoice_id = c.invoice_id) as allocated
       from public.credit_notes c join public.invoices i on i.id = c.invoice_id where c.organization_id = $1`, [org]);
    expect(cn).toHaveLength(1);
    expect(cn[0]).toMatchObject({ credit_ref: E.linkedCredit, invoice_ref: E.creditedInvoice, status: "issued" });
    expect([parsePence(cn[0].total), parsePence(cn[0].allocated ?? "0"), parsePence(cn[0].credited)]).toEqual([E.creditTotal, E.creditTotal, E.creditTotal]);
    expect(parsePence(cn[0].total)! > 0 && parsePence(cn[0].vat)! >= 0).toBe(true);
    expect(await sql("select 1 from public.credit_notes where organization_id = $1 and credit_ref = $2", [org, E.orphanCredit])).toEqual([]);
    return `${E.linkedCredit} (negative in the SliQ report) stored positive £${(E.creditTotal / 100).toFixed(2)}, issued, applied in full to ${E.creditedInvoice} (allocation = credited_amount); ${E.orphanCredit} (no link) held out, not in Tolra`;
  }));

  it("SMOKE 15 sliq-orphan-credit-refused", () => step(15, "sliq-orphan-credit-refused", [11], async () => {
    const before = await checksums();
    const orphan = { credit_ref: E.orphanCredit, customer: "Echo Fictional Fabrications", credit_date: "2026-08-05", subtotal: "20.00", vat: "4.00", total: "24.00" };
    const unknownInvoice = await importAs({ credit_notes: [{ ...orphan, invoice_ref: "SINV-0000" }] }, false);
    const noInvoice = await importAs({ credit_notes: [orphan] }, false);
    for (const r of [unknownInvoice, noInvoice]) {
      expect(r.ok).toBe(false);
      expect(r.committed).toBe(false);
    }
    expect(await checksums()).toEqual(before);
    return `a credit note for an invoice that is not in Tolra ("${problems(unknownInvoice)[0]?.slice(0, 80)}") and one with no invoice ("${problems(noInvoice)[0]?.slice(0, 80)}") both refused; nothing written`;
  }));

  it("SMOKE 16 sliq-emails-split", () => step(16, "sliq-emails-split", [11], async () => {
    const rows = await sql<{ name: string; email: string | null; notes: string | null }>("select name, email, notes from public.customers where organization_id = $1 order by name", [org]);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by["Brook Example Engineering"]).toMatchObject({ email: "ap@brook.example.test" });
    expect(by["Brook Example Engineering"].notes).toContain("Other e-mails: orders@brook.example.test");
    expect(by["Cobalt Made-Up Machining"]).toMatchObject({ email: "buyer@cobalt.example.test" });
    expect(by["Cobalt Made-Up Machining"].notes).toContain("Other e-mails: buyer2@cobalt.example.test");
    expect(by["Delta Pretend Products"].email ?? null).toBeNull();
    expect(by["Delta Pretend Products"].notes).toContain("E-mail as in SliQ: accounts @delta.example.test");
    expect(rows.every((r) => !r.email || !/[\s,;]/.test(r.email))).toBe(true);
    // Opening WIP (141): none of the report files feeds it; does the importer take it at all?
    let wip = "";
    try { await importAs({ opening_wip: [{ source_job_ref: "J-1", description: "x", quantity: 1, value: "1.00" }] } as Record<string, unknown>, true); wip = "accepted"; } catch (e) { wip = (e as Error).message; }
    if (wip !== "accepted") knownGap("sliq-opening-wip", `the importer has no opening WIP section ("${wip.slice(0, 80)}"); public.opening_wip (141) is written only by an owner-connection importer not in this tree, and no SliQ report feeds it`);
    return `stored e-mails are single addresses: "a; b" and "a b" cells split (first kept, the rest in the notes), a cell with none valid kept as text in the notes ("E-mail as in SliQ: ...") and listed; ${rows.length} customers`;
  }));
});
