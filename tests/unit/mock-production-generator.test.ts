import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { generateMockProduction } from "../../scripts/mock-production/generate.mjs";
import { dryRun } from "../../scripts/sliq-import/cli.mjs";
// Any attempted database connection makes the offline rehearsal fail immediately.
vi.mock("pg", () => ({ default: { Client: class { constructor() { throw new Error("No database connection allowed in the fake dry run"); } } } }));
const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(path.join(tmpdir(), "tolra-fake-")); roots.push(root); return root; };
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("generates two companies with 300 linked customers/jobs/POs/invoices each and independently reconciles both real importer dry runs", async () => {
  const root = fresh(), data = path.join(root, "data");
  const network = vi.fn(() => { throw new Error("No network allowed in a fake dry run"); });
  vi.stubGlobal("fetch", network);
  const expected = generateMockProduction(data);
  const firstIds: number[][] = [];
  for (const [index, company] of expected.companies.entries()) {
    const { report, plan } = await dryRun({ folder: path.join(data, company.folder), outDir: path.join(root, `report-${index}`), mapping: "synthetic", organizationId: index ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111" });
    expect(company.counts).toEqual({ customers: 300, suppliers: 300, jobs: 300, purchaseOrders: 300, invoices: 300, payments: 200 });
    expect(report.counts).toMatchObject({ customers: 300, suppliers: 300, invoices: 300, purchaseOrders: 300, payments: 200 });
    expect(report.writePlan).toMatchObject({ customers: 300, invoices: 300, purchaseOrders: 300, payments: 200, invoicesPaymentToConfirm: 0 });
    expect(report.jobsImport.counts).toMatchObject({ jobsWritten: 300, purchaseOrdersLinked: 300 });
    expect(report.customerMatching.ambiguities).toEqual([]);
    expect(report.documentAmounts.mismatches).toEqual([]);
    expect(report.held).toEqual([]);
    expect(plan.invoices.reduce((sum: number, invoice: { net: number }) => sum + invoice.net, 0)).toBe(company.totals.netPence);
    expect(plan.invoices.reduce((sum: number, invoice: { vat: number }) => sum + invoice.vat, 0)).toBe(company.totals.vatPence);
    expect(plan.invoices.flatMap((invoice: { payments: { amountPence: number }[] }) => invoice.payments).reduce((sum: number, payment: { amountPence: number }) => sum + payment.amountPence, 0)).toBe(company.totals.paymentsPence);
    expect(plan.purchaseOrders.reduce((sum: number, po: { total: number }) => sum + po.total, 0)).toBe(company.totals.purchaseOrdersPence);
    expect(report.balances.summary).toMatchObject({ paid: 100, PARTIAL: 100, unpaid: 100 });
    expect(report.balances.owedAfterImport).toBe(company.totals.outstandingPence);
    expect(plan.invoices.reduce((sum: number, invoice: { gross: number }) => sum + invoice.gross, 0)).toBe(company.totals.grossPence);
    // Independent closed-form totals, not the generator's accumulation.
    expect(company.totals.netPence).toBe(300 * (10000 + index * 500) + 5 * 300 * 301 / 2);
    expect(company.totals.vatPence * 5).toBe(company.totals.netPence);
    expect(company.totals.paymentsPence + company.totals.outstandingPence).toBe(company.totals.grossPence);
    firstIds.push(plan.invoices.map((i: { oldId: number }) => i.oldId));
    const repeated = await dryRun({ folder: path.join(data, company.folder), outDir: path.join(root, `repeat-${index}`), mapping: "synthetic", organizationId: index ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111" });
    expect(repeated.plan).toEqual(plan);
  }
  expect(firstIds[0]).toHaveLength(300);
  expect(firstIds.flat().every(Number.isSafeInteger)).toBe(true);
  expect(new Set(firstIds.flat()).size).toBe(600);
  expect(network).not.toHaveBeenCalled();
});

it("is deterministic, labels all customers as fake, and never overwrites an existing export", () => {
  const root = fresh(), a = path.join(root, "a"), b = path.join(root, "b");
  expect(generateMockProduction(a, 3)).toEqual(generateMockProduction(b, 3));
  for (const company of ["alpha", "beta"]) for (const file of readdirSync(path.join(a, company))) expect(readFileSync(path.join(a, company, file))).toEqual(readFileSync(path.join(b, company, file)));
  expect(readFileSync(path.join(a, "alpha/customers.csv"), "utf8")).toContain("@example.test");
  const before = readFileSync(path.join(a, "expected-reconciliation.json"));
  expect(() => generateMockProduction(a, 3)).toThrow();
  expect(readFileSync(path.join(a, "expected-reconciliation.json"))).toEqual(before);
});

it.each([0, 2, 3.5, 2001, NaN, Infinity])("refuses unsafe size %s before creating files", count => {
  const root = fresh();
  expect(() => generateMockProduction(path.join(root, "data"), count)).toThrow(/whole number/);
  expect(readdirSync(root)).toEqual([]);
});

it.each(["--write", "--database-url", "--input"])("CLI refuses %s and creates nothing", flag => {
  const root = fresh();
  const result = spawnSync(process.execPath, ["scripts/mock-production/generate.mjs", "--out", path.join(root, "data"), flag, "fake"], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(readdirSync(root)).toEqual([]);
});
