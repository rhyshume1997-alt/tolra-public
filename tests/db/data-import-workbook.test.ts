/**
 * Admin > Data: the payload the page builds from the e2e's small workbook (tests/support/import-workbook.ts, read with read-excel-file and
 * built by lib/import-build.ts, exactly as the page does) goes through migration 076's import_company_data: a clean dry run, one commit with
 * the figures the e2e reads back, a second upload that matches everything, and the rows the e2e expects to be problems. This is the page's data
 * path against the real database without the browser, so a difference between the two shows up here first.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type BuiltImport, buildImport } from "@/lib/import-build";
import { type SheetPlan, chooseKind, chooseTarget, planSheet } from "@/lib/import-detect";
import { readImportFile } from "@/lib/import-file";

import { smallWorkbook } from "../support/import-workbook";
import { type TestCell, workbookBytes } from "../support/workbook";
import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, withDb } from "../support/fixtures";

import { q } from "./time-support";

let world: SyntheticWorld;
const admin = () => world.tenants.alpha.users.admin;
const org = () => world.tenants.alpha.id;
beforeAll(async () => { world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

type Problem = { kind: string | null; row: number | null; field: string | null; message: string };
type Result = { ok: boolean; counts: Record<string, { created?: number; matched_existing?: number; errors?: number }>; errors: Problem[]; error_count: number; warnings: Problem[]; doc_counters: Record<string, number> | null };
const IMPORT = "select public.import_company_data($1::jsonb, $2, $3) as r";
const run = (built: BuiltImport, dry: boolean, key: string = randomUUID()) => q<{ r: Result }>(admin(), IMPORT, [JSON.stringify(built.payload), dry, key]).then((rows) => rows[0].r);
const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);

/** What the page does with an upload: read the file, plan each sheet, apply the admin's choices, build the payload. */
async function page(name: string, sheets: { name: string; rows: TestCell[][] }[], choose: (plan: SheetPlan) => SheetPlan = (p) => p) {
  const file = await readImportFile(new File([workbookBytes(sheets) as unknown as BlobPart], name));
  const plans = (await Promise.all(file.sheets.map((sheet) => planSheet(sheet, [])))).flat().map(choose);
  return buildImport(plans, { name: file.name, sha256: file.sha256 });
}
const memoToNotes = (plan: SheetPlan) => (plan.kind === "customers" ? chooseTarget(plan, 3, "notes") : plan);

describe("the small workbook, as the page builds it", () => {
  it("dry run: clean, with the counts the e2e expects; nothing is written", async () => {
    const f = smallWorkbook(world.runId);
    const built = await page("small.xlsx", f.sheets, memoToNotes);
    expect(built.problems).toEqual([]);
    const dry = await run(built, true);
    expect(dry.errors).toEqual([]);
    expect(dry.ok).toBe(true);
    expect(dry.error_count).toBe(0);
    expect(Object.fromEntries(["customers", "quotes", "invoices", "payments"].map((k) => [k, dry.counts[k].created]))).toEqual({ customers: 1, quotes: 1, invoices: 2, payments: 1 });
    expect(await sql("select 1 from public.invoices where organization_id = $1 and invoice_ref = $2", [org(), f.inv1])).toHaveLength(0);
  });

  it("commit: the invoice with its lines, payment and state; the customer's contact and notes; then a second upload matches everything", async () => {
    const f = smallWorkbook(world.runId);
    const built = await page("small.xlsx", f.sheets, memoToNotes);
    const committed = await run(built, false);
    expect(committed.ok).toBe(true);
    const [invoice] = await sql<{ id: string; customer: string; total: string; amount_paid: string; status: string }>("select id, customer, total, amount_paid, status from public.invoices where organization_id = $1 and invoice_ref = $2", [org(), f.inv1]);
    expect(invoice).toMatchObject({ customer: f.customer, status: "partial" });
    expect([Number(invoice.total), Number(invoice.amount_paid)]).toEqual([120, 60]);
    expect(await sql("select 1 from public.invoice_line_items where invoice_id = $1", [invoice.id])).toHaveLength(2);
    expect((await sql<{ amount: string }>("select amount from public.invoice_payments where invoice_id = $1", [invoice.id])).map((p) => Number(p.amount))).toEqual([60]);
    expect(await sql<{ contact_name: string; notes: string }>("select contact_name, notes from public.customers where organization_id = $1 and name = $2", [org(), f.customer])).toEqual([{ contact_name: "Pat Buyer", notes: "Pays on the 28th" }]);

    const again = await run(await page("small.xlsx", f.sheets, memoToNotes), true);
    expect(again.ok).toBe(true);
    for (const [kind, matched] of [["customers", 1], ["quotes", 1], ["invoices", 2], ["payments", 1]] as const) expect(again.counts[kind]).toMatchObject({ created: 0, matched_existing: matched, errors: 0 });
  });
});

describe("the rows the e2e expects to be problems", () => {
  it("a sheet without an invoice number column: every row is a problem (in no set order)", async () => {
    const customer = `NoKey Co ${world.runId} Ltd`;
    const built = await page("nokey.xlsx", [{ name: "Invoices", rows: [["Customer", "Invoice Date", "Total"], [customer, "2026-10-01", 50], [customer, "2026-10-01", 50]] }], (plan) => chooseKind(plan, "invoices", []));
    const dry = await run(built, true);
    expect(dry.ok).toBe(false);
    expect(dry.errors.map((e) => `${e.kind} ${e.row} ${e.field}: ${e.message}`).sort()).toEqual(["invoices 2 invoice_ref: Invoice number is required.", "invoices 3 invoice_ref: Invoice number is required."]);
    expect(await sql("select 1 from public.invoices where organization_id = $1 and customer = $2", [org(), customer])).toHaveLength(0);
  });

  it("the same document number twice in the file", async () => {
    const ref = `INV-DI-${world.runId}-DUP`;
    const dry = await run(await page("dup.xlsx", [{ name: "Invoices", rows: [["Invoice No", "Customer", "Invoice Date", "Total"], [ref, "Dup Co Ltd", "2026-10-01", 10], [ref, "Dup Co Ltd", "2026-10-01", 10]] }]), true);
    expect(dry.errors.map((e) => e.message)).toEqual(["This number is in the file twice (also row 2)."]);
  });

  it("a payment for an invoice already in Tolra", async () => {
    const ref = `INV-DI-${world.runId}-EXIST`;
    await sql(`insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, invoice_date, due_date, vat_enabled)
       values ($1, $2, 'DI Existing Co Ltd', 100, 20, 120, 'issued', 0, '2026-10-01', '2099-12-31', true)`, [org(), ref]);
    const dry = await run(await page("payment.xlsx", [{ name: "Payments", rows: [["Invoice No", "Paid On", "Amount", "Method"], [ref, "2026-10-05", 20, "BACS"]] }]), true);
    expect(dry.errors.map((e) => e.message)).toEqual([`Invoice ${ref} is already in Tolra: record this payment on it with Record payment.`]);
    expect(dry.counts.payments.created).toBe(0);
  });

  it("a name that matches two customers", async () => {
    const tag = world.runId;
    await sql("insert into public.customers (organization_id, name) values ($1, $2), ($1, $3)", [org(), `Twin ${tag} Ltd`, `Twin ${tag} Limited`]);
    const dry = await run(await page("twin.xlsx", [{ name: "Customers", rows: [["Name", "Email"], [`Twin ${tag} Ltd`, "twin@example.test"]] }]), true);
    expect(dry.errors.map((e) => e.message)).toEqual(["Matches 2 customers already in Tolra with the same name: give its account reference, or merge them first."]);
  });
});
