/** Extra regression cases against main's importer. Synthetic files only; no write mode or database calls. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDateFormat } from "../../scripts/sliq-import/detect.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile, MappingError } from "../../scripts/sliq-import/mapping.mjs";
import { ParseError, parseCsv, parseDate, parseMoneyPence, penceToPounds } from "../../scripts/sliq-import/parse.mjs";
import { analyse } from "../../scripts/sliq-import/reconcile.mjs";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const profile = getProfile("synthetic");
const CUSTOMER_HEADER = "Account,Name";
const INVOICE_HEADER = "Invoice No,Date,Account,Net,VAT,Gross,Status";
function fixture(customers = `${CUSTOMER_HEADER}\nC01,Test Fabrications Ltd\n`, invoices = `${INVOICE_HEADER}\nI01,13/03/2026,C01,0.29,0.06,0.35,Issued\n`) {
  const folder = mkdtempSync(path.join(tmpdir(), "sliq-extra-")); folders.push(folder);
  writeFileSync(path.join(folder, "customers.csv"), customers);
  writeFileSync(path.join(folder, "invoices.csv"), invoices);
  return folder;
}

describe("blank rows and absent headers", () => {
  it("ignores BOM, CRLF and wholly blank rows before, between and after records", () => {
    const loaded = loadFolder(fixture(`\uFEFF\r\n , \r\n${CUSTOMER_HEADER}\r\nC01,Test Fabrications Ltd\r\n,\r\n \t, \r\nC02,Other Shop\r\n\r\n`), profile);
    expect(loaded.records.customers.map((r: { key: string }) => r.key)).toEqual(["C01", "C02"]);
    expect(loaded.inputs.find((i: { kind: string }) => i.kind === "customers").rows).toBe(2);
    expect(loaded.errors).toEqual([]);
  });
  it("keeps a blank line inside a quoted field as part of that record", () => {
    expect(parseCsv('Account,Name\r\nC01,"First line\r\n\r\nLast line"\r\n,\r\n').rows).toEqual([["C01", "First line\r\n\r\nLast line"]]);
  });
  it("does not discard a partly empty customer row: missing name is an error", () => {
    const loaded = loadFolder(fixture(`${CUSTOMER_HEADER}\nC01,\n`), profile);
    expect(loaded.records.customers).toHaveLength(1);
    expect(loaded.errors).toEqual([expect.objectContaining({ file: "customers.csv", column: "Name", row: 2 })]);
    expect(analyse(loaded).report.writable).toBe(false);
  });
  it.each(["", "\uFEFF\r\n , \r\n", ",,\n\n"])("refuses a file with no header: %j", (text) => {
    expect(() => loadFolder(fixture(text), profile)).toThrowError(/customers.csv cannot be read as CSV:.*no header row/);
  });
  it("refuses data in place of the header rather than importing the second row", () => {
    const folder = fixture("C01,Test Fabrications Ltd\nC02,Other Shop\n");
    expect(() => loadFolder(folder, profile)).toThrow(MappingError);
    expect(() => loadFolder(folder, profile)).toThrowError(/column "Name".*not in the file/);
  });
  it("refuses an invoice export whose header was removed", () => {
    expect(() => loadFolder(fixture(undefined, "I01,13/03/2026,C01,1.00,0.20,1.20,Issued\n"), profile)).toThrowError(/Invoice No[\s\S]*Date[\s\S]*Gross/);
  });
  it("accepts header-only files as empty rather than inventing a row", () => {
    const loaded = loadFolder(fixture(`${CUSTOMER_HEADER}\n`, `${INVOICE_HEADER}\n`), profile);
    expect(loaded.records.customers).toEqual([]); expect(loaded.records.invoices).toEqual([]);
    expect(loaded.errors).toEqual([]);
  });
});

describe("unusual date formats", () => {
  it.each([
    [" 29.02.2024 ", "DD.MM.YYYY", "2024-02-29"],
    ["29-02-2024", "DD-MM-YYYY", "2024-02-29"],
    ["1/2/2026", "DD/MM/YYYY", "2026-02-01"],
    ["1/2/2026", "MM/DD/YYYY", "2026-01-02"],
    ["2000-02-29", "YYYY-MM-DD", "2000-02-29"],
  ])("reads %s only using the chosen format %s", (text, format, expected) => {
    expect(parseDate(text, format)).toBe(expected);
  });
  it.each(["29/02/1900", "29/02/2100", "31/04/2026", "00/03/2026", "13/00/2026", "13/13/2026", "13/03/26", "13 March 2026", "46100"])("refuses an invalid or unsupported date %s", (text) => {
    expect(() => parseDate(text, "DD/MM/YYYY")).toThrow(ParseError);
  });
  it("reports invalid dates at the invoice column and prevents a writable report", () => {
    const loaded = loadFolder(fixture(undefined, `${INVOICE_HEADER}\nI01,29/02/2100,C01,1.00,0.20,1.20,Issued\n`), profile);
    expect(loaded.errors).toEqual([expect.objectContaining({ file: "invoices.csv", row: 2, column: "Date", value: "29/02/2100", message: expect.stringContaining("not a real calendar date") })]);
    expect(analyse(loaded).report.writable).toBe(false);
  });
  it("does not propose one format for mixed dot and dash dates", () => {
    expect(detectDateFormat(["13.03.2026", "14-03-2026"])).toMatchObject({ format: null, conflict: expect.stringContaining("mixed") });
  });
});

describe("pence precision", () => {
  it.each(["0.005", "1.005", "-1.005", "(1.005)", "£1.005", "1.000"])("rejects %s instead of rounding or trimming sub-pence precision", (raw) => {
    expect(() => parseMoneyPence(raw)).toThrowError(/more than two decimal places.*not rounded/);
  });
  it("keeps decimal values exact as integer pence, including credits", () => {
    const amounts = ["0.29", "0.01", "-0.10", "(0.05)"].map(parseMoneyPence);
    expect(amounts).toEqual([29, 1, -10, -5]);
    expect(penceToPounds(amounts.reduce<number>((sum, value) => sum + (value ?? 0), 0))).toBe("0.15");
    const loaded = loadFolder(fixture(), profile);
    expect(loaded.records.invoices[0]).toMatchObject({ net: 29, vat: 6, gross: 35 });
  });
  it("records a sub-penny source error, leaving the invoice out of the write plan", () => {
    const loaded = loadFolder(fixture(undefined, `${INVOICE_HEADER}\nI01,13/03/2026,C01,1.005,0.20,1.21,Issued\n`), profile);
    expect(loaded.errors).toEqual([expect.objectContaining({ column: "Net", value: "1.005", message: expect.stringContaining("not rounded") })]);
    const result = analyse(loaded);
    expect(result.report.writable).toBe(false); expect(result.plan.invoices).toEqual([]);
  });
});

describe("duplicate customers", () => {
  it("lists case and space variants of an account key with every source row", () => {
    const loaded = loadFolder(fixture(`${CUSTOMER_HEADER}\nC01,First Shop\n c01 ,Second Shop\nC01,Third Shop\n`), profile);
    expect(loaded.records.customers).toHaveLength(3);
    const { report } = analyse(loaded);
    expect(report.duplicates.customerKeys).toEqual([expect.objectContaining({ key: "c01", records: [
      expect.objectContaining({ name: "First Shop", row: 2 }), expect.objectContaining({ name: "Second Shop", row: 3 }), expect.objectContaining({ name: "Third Shop", row: 4 }),
    ] })]);
  });
  it("lists names that differ by punctuation, accents, ampersands and Ltd/Limited", () => {
    const { report } = analyse(loadFolder(fixture(`${CUSTOMER_HEADER}\nC01,Café & Steel Ltd\nC02,Cafe and Steel Limited\n`), profile));
    expect(report.duplicates.customers).toEqual([expect.objectContaining({ normalisedName: "cafe and steel ltd", records: [expect.objectContaining({ key: "C01" }), expect.objectContaining({ key: "C02" })] })]);
    expect(report.duplicates.customerKeys).toEqual([]);
  });
  it("does not flag different accounts and distinct names as duplicates", () => {
    const { report } = analyse(loadFolder(fixture(`${CUSTOMER_HEADER}\nC01,Steel One\nC02,Steel Two\n`), profile));
    expect(report.duplicates.customers).toEqual([]); expect(report.duplicates.customerKeys).toEqual([]);
  });
});
