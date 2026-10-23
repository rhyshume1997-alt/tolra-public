/**
 * The e2e's small workbook (tests/support/import-workbook.ts), read and built exactly as the Admin > Data page does, pinned to the payload
 * migration 076 receives. tests/db/data-import-workbook.test.ts sends the same payload to the database; if the two ever disagree with the
 * browser test, this is where the page's data path is read without a browser or a database.
 */
import { describe, expect, it } from "vitest";

import { buildImport } from "@/lib/import-build";
import { chooseTarget, planSheet } from "@/lib/import-detect";
import { readImportFile } from "@/lib/import-file";

import { smallWorkbook } from "../support/import-workbook";
import { workbookBytes } from "../support/workbook";

const TAG = "ab12cd34";

async function uploaded() {
  const f = smallWorkbook(TAG);
  const file = await readImportFile(new File([workbookBytes(f.sheets) as unknown as BlobPart], "small.xlsx"));
  const plans = (await Promise.all(file.sheets.map((sheet) => planSheet(sheet, [])))).flat();
  return { f, file, plans };
}

describe("the small workbook as the page reads it", () => {
  it("every sheet is recognised from its headers, none is left to choose, and nothing is a problem", async () => {
    const { plans } = await uploaded();
    expect(plans.map((p) => [p.sheetName, p.kind, p.kindSource])).toEqual([["Payments", "payments", "headers"], ["Invoices", "invoices", "headers"], ["Quotes", "quotes", "headers"], ["Customers", "customers", "headers"]]);
    expect(buildImport(plans, { name: "small.xlsx", sha256: "a".repeat(64) }).problems).toEqual([]);
  });

  it("the Account Memo column is nobody's synonym; mapped to Notes by hand it is imported as the customer's notes", async () => {
    const { plans } = await uploaded();
    const customers = plans.find((p) => p.kind === "customers")!;
    expect(customers.columns.find((c) => c.header === "Account Memo")).toMatchObject({ target: null, source: "none", hasData: true });
    const mapped = chooseTarget(customers, 3, "notes");
    expect(mapped.columns[3]).toMatchObject({ target: "notes", source: "manual" });
  });

  it("the payload: dependency order, lines grouped under their invoice, plain decimals, the file's own row numbers", async () => {
    const { f, file, plans } = await uploaded();
    const built = buildImport(plans.map((p) => (p.kind === "customers" ? chooseTarget(p, 3, "notes") : p)), { name: file.name, sha256: file.sha256 });
    expect(Object.keys(built.payload)).toEqual(["file_name", "file_sha256", "customers", "quotes", "invoices", "payments"]);
    expect(built.payload.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.payload).toMatchObject({
      file_name: "small.xlsx",
      customers: [{ row: 2, name: f.customer, contact_name: "Pat Buyer", email: `pat.${TAG}@example.test`, notes: "Pays on the 28th" }],
      quotes: [{ row: 2, quote_ref: f.quote, customer: f.customer, quote_date: "2026-09-20", total_value: "100" }],
      invoices: [
        { row: 2, invoice_ref: f.inv1, customer: f.customer, invoice_date: "2026-10-01", lines: [{ description: "Bracket", quantity: "2", unit_price: "30" }, { description: "Plate", quantity: "1", unit_price: "40" }] },
        { row: 4, invoice_ref: f.inv2, customer: f.customer, invoice_date: "2026-10-01", lines: [{ description: "Spacer", quantity: "4", unit_price: "5" }] },
      ],
      payments: [{ row: 2, invoice_ref: f.inv1, paid_on: "2026-10-02", amount: "60", method: "BACS", reference: "PAY-1" }],
    });
    expect(built.records).toMatchObject({ customers: 1, quotes: 1, invoices: 2, payments: 1 });
  });
});
