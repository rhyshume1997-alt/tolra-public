import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile, MappingError } from "../../scripts/sliq-import/mapping.mjs";
import { analyse } from "../../scripts/sliq-import/reconcile.mjs";
import { loadSource } from "../../scripts/sliq-reconcile/source.mjs";
import { loadSnapshot } from "../../scripts/sliq-reconcile/snapshot.mjs";
import { reconcile } from "../../scripts/sliq-reconcile/engine.mjs";

const fixture = path.resolve(__dirname, "../fixtures/sliq/fake-export");
const temp: string[] = [];
function copy() { const dir = mkdtempSync(path.join(tmpdir(), "fake-export-")); temp.push(dir); cpSync(fixture, dir, { recursive: true }); return dir; }
afterEach(() => { for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const hashes = () => Object.fromEntries(readdirSync(fixture).map(name => [name, createHash("sha256").update(readFileSync(path.join(fixture, name))).digest("hex")]));

describe("fictional complete SliQ export", () => {
  it("reads the ten mapped files with BOM, padded headers, commas and blank rows, without rewriting source", () => {
    const before = hashes(), loaded = loadFolder(fixture, getProfile("synthetic"));
    const { report, plan } = analyse(loaded);
    expect(loaded.errors).toEqual([]);
    expect(report.counts).toEqual({ customers: 2, suppliers: 1, products: 1, quotes: 1, invoices: 1, creditNotes: 1, invoiceLines: 1, payments: 1, allocations: 1, purchaseOrders: 1 });
    expect(plan.invoices[0]).toMatchObject({ number: "FAKE-I1001", gross: 72000, customerAccount: "FAKE-C01" });
    expect(plan.invoices[0].lines[0]).toMatchObject({ description: "Fictional bracket, drilled", quantityMilli: 2000, unitPence: 30000 });
    expect(report.purchaseOrders).toMatchObject({ read: 1, written: 1 });
    expect(report.creditNotes[0]).toMatchObject({ number: "FAKE-CN4001", linkedInvoice: "FAKE-I1001", statedGross: 6000, allocated: 6000 });
    expect(hashes()).toEqual(before);
  });
  it("the independent reconciliation engine retains exact debtor pennies and reports a mismatched snapshot", async () => {
    const before = hashes();
    const source = await loadSource(fixture, { mapping: "synthetic" });
    // Deliberately different, independently maintained fake target: a mismatch must block, never be rounded away.
    const { snapshot } = await loadSnapshot(path.resolve(__dirname, "../fixtures/sliq-reconcile/clean/tolra"));
    const { stats, rows } = reconcile(source, snapshot);
    expect(stats.source).toMatchObject({ customers: 2, invoices: 1, creditNotes: 1, quotes: 1, purchaseOrders: 1 });
    expect(stats.receivables.source).toBe(54000); // 72000 less payment 12000 less linked credit 6000.
    expect(stats.receivables.target).not.toBe(stats.receivables.source);
    expect(rows.some(row => row.severity === "BLOCKER")).toBe(true);
    expect(hashes()).toEqual(before);
  });
  it.each(["90071992547409.92", "9".repeat(400)])("oversized money %s blocks writing instead of losing pennies", amount => {
    const dir = copy(), file = path.join(dir, "invoices.csv");
    writeFileSync(file, readFileSync(file, "utf8").replace("720.00", amount));
    const loaded = loadFolder(dir, getProfile("synthetic"));
    expect(loaded.errors.some((error: { message: string }) => /too large/i.test(error.message))).toBe(true);
    expect(analyse(loaded).report.writable).toBe(false);
  });
  it("an extra banner row is refused for mapping review, never guessed to be a header", () => {
    const dir = copy(), file = path.join(dir, "customers.csv");
    writeFileSync(file, "FICTIONAL SliQ report heading\n" + readFileSync(file, "utf8"));
    expect(() => loadFolder(dir, getProfile("synthetic"))).toThrow(MappingError);
  });
  it("a credit linked to a missing invoice is explicitly reported as unlinked", () => {
    const dir = copy(), file = path.join(dir, "credit-notes.csv");
    writeFileSync(file, readFileSync(file, "utf8").replace("FAKE-I1001", "FAKE-MISSING"));
    const { report } = analyse(loadFolder(dir, getProfile("synthetic")));
    expect(report.creditNotes[0]).toMatchObject({ linkedInvoice: null, link: expect.stringContaining("not found") });
  });
});
