/**
 * Admin > Data: the sheets of a workbook as one payload for migration 076 (lib/import-build.ts): the order, the split of a mixed sheet,
 * how a cell is written, lines grouped under their document, nothing guessed.
 */
import { describe, expect, it } from "vitest";

import { buildImport, cellValue, decimalText, estimateSize } from "@/lib/import-build";
import { type ParsedSheet, planSheet } from "@/lib/import-detect";

const sheet = (name: string, headers: string[], rows: (string | number | boolean | Date | null)[][]): ParsedSheet => ({ name, headers, rows, rowNumbers: rows.map((_, i) => i + 2) });
const FILE = { name: "import.xlsx", sha256: "a".repeat(64) };

async function build(sheets: ParsedSheet[]) {
  const plans = (await Promise.all(sheets.map((s) => planSheet(s, [])))).flat();
  return buildImport(plans, FILE);
}

describe("cells", () => {
  it("dates: a real date, an ISO text, day-first UK text; anything else is left as written for the database to refuse", () => {
    expect(cellValue(new Date("2026-10-19T00:00:00Z"), "date")).toBe("2026-10-19");
    expect(cellValue("2026-10-19", "date")).toBe("2026-10-19");
    expect(cellValue("19/10/2026", "date")).toBe("2026-10-19");
    expect(cellValue("1.2.2026", "date")).toBe("2026-02-01");
    expect(cellValue("31/02/2026", "date")).toBe("31/02/2026");
    expect(cellValue("next week", "date")).toBe("next week");
  });

  it("numbers: a plain decimal, spreadsheet float noise cut, a pound sign and thousands commas cleaned", () => {
    expect(decimalText(120)).toBe("120");
    expect(decimalText(0.1 + 0.2)).toBe("0.3");
    expect(decimalText(1234.5600000001)).toBe("1234.56");
    expect(cellValue(12.5, "money")).toBe("12.5");
    expect(cellValue("£1,234.50", "money")).toBe("1234.50");
    expect(cellValue("12 345.5", "money")).toBe("12345.5");
    expect(cellValue("abc", "money")).toBe("abc");
  });

  it("text is as it is (a number code stays its digits), booleans are true/false, empty is nothing", () => {
    expect(cellValue("INV-0001", "text")).toBe("INV-0001");
    expect(cellValue(1042, "text")).toBe("1042");
    expect(cellValue(true, "bool")).toBe("true");
    expect(cellValue("   ", "text")).toBeUndefined();
    expect(cellValue(null, "text")).toBeUndefined();
  });
});

describe("sheet order and split", () => {
  const workbook = [
    sheet("Payments", ["Invoice No", "Paid On", "Amount", "Method"], [["INV-1", "2026-10-02", 60, "BACS"]]),
    sheet("Invoices", ["Invoice No", "Customer", "Invoice Date", "Total"], [["INV-1", "Acme Ltd", "2026-10-01", 120]]),
    sheet("Quotes", ["Quote Ref", "Customer", "Total"], [["QUO-1", "Acme Ltd", 100]]),
    sheet("Customers", ["Name", "Contact", "Email"], [["Acme Ltd", "Pat", "pat@acme.test"]]),
  ];

  it("each sheet is imported in dependency order whatever its place in the file", async () => {
    const built = await build(workbook);
    expect(built.order.map((o) => o.kind)).toEqual(["customers", "quotes", "invoices", "payments"]);
    expect(Object.keys(built.payload).filter((k) => !["file_name", "file_sha256"].includes(k))).toEqual(["customers", "quotes", "invoices", "payments"]);
  });

  it("all sheets go in one payload that names the file", async () => {
    const built = await build(workbook);
    expect(built.payload.file_name).toBe("import.xlsx");
    expect(built.payload.file_sha256).toBe("a".repeat(64));
    expect(built.records).toMatchObject({ customers: 1, quotes: 1, invoices: 1, payments: 1, jobs: 0 });
  });

  it("a record keeps the file's own row number and only the fields the file gave", async () => {
    const built = await build(workbook);
    expect(built.payload.customers).toEqual([{ row: 2, name: "Acme Ltd", contact_name: "Pat", email: "pat@acme.test" }]);
    expect(built.payload.invoices).toEqual([{ row: 2, invoice_ref: "INV-1", customer: "Acme Ltd", invoice_date: "2026-10-01", total: "120" }]);
    expect(built.payload.payments).toEqual([{ row: 2, invoice_ref: "INV-1", paid_on: "2026-10-02", amount: "60", method: "BACS" }]);
  });

  it("a mixed sheet with a Kind column is split into its kinds; a row whose Kind is unknown is a problem, not a guess", async () => {
    const built = await build([sheet("All", ["Kind", "Name", "Invoice No", "Customer", "Total"], [
      ["Customer", "Acme Ltd", null, null, null],
      ["Invoice", null, "INV-1", "Acme Ltd", 100],
      ["Widget", "x", null, null, null],
    ])]);
    expect(built.records).toMatchObject({ customers: 1, invoices: 1 });
    expect(built.payload.invoices).toEqual([{ row: 3, invoice_ref: "INV-1", customer: "Acme Ltd", total: "100" }]);
    expect(built.problems).toEqual([{ sheet: "All", row: 4, field: "kind", message: expect.stringContaining('"Widget"') }]);
  });
});

describe("what is left out is said, never dropped silently", () => {
  it("credit notes and delivery notes go in with their lines, after the invoices they credit or the jobs they despatch (085)", async () => {
    const built = await build([
      sheet("Delivery notes", ["DN No", "Customer", "Job No", "Delivery Date", "Signed By", "Description", "Qty"], [
        ["DLN-0001", "A", "J-1", "01/08/2026", "Pat", "Shaft", 4], ["DLN-0001", "A", "J-1", "01/08/2026", "Pat", "Bush", 2]]),
      sheet("Credit notes", ["Credit Note No", "Invoice No", "Credit Date", "Total", "VAT"], [["CRD-0166", "INV-1", "2026-08-02", 12, 2], ["CRD-0167", "INV-1", "2026-08-03", 6, 1]]),
      sheet("Invoices", ["Invoice No", "Customer", "Invoice Date", "Total"], [["INV-1", "A", "2026-08-01", 120]]),
    ]);
    expect(built.order.map((o) => o.kind)).toEqual(["invoices", "credit_notes", "delivery_notes"]);
    expect(built.records).toMatchObject({ invoices: 1, credit_notes: 2, delivery_notes: 1 });
    expect(built.payload.credit_notes).toEqual([
      { row: 2, credit_ref: "CRD-0166", invoice_ref: "INV-1", credit_date: "2026-08-02", total: "12", vat: "2" },
      { row: 3, credit_ref: "CRD-0167", invoice_ref: "INV-1", credit_date: "2026-08-03", total: "6", vat: "1" },
    ]);
    expect(built.payload.delivery_notes).toEqual([{ row: 2, dn_number: "DLN-0001", customer: "A", job_no: "J-1", delivery_date: "2026-08-01", signed_by: "Pat",
      lines: [{ description: "Shaft", quantity: "4" }, { description: "Bush", quantity: "2" }] }]);
    expect(built.notices.filter((n) => n.tone === "warning")).toEqual([]);
    // Each credit note writes at least one line (085), each delivery note its items.
    expect(estimateSize(built.payload)).toEqual({ records: 4, lines: 2, audit_rows: 2 + 2 + 2 + 3 });
  });

  it("'PO sent by', 'invoice sent by' and 'delivery note signed by' go in on their own kind; on another kind they are said, not imported", async () => {
    const built = await build([
      sheet("Purchase orders", ["PO No", "Supplier", "PO sent by"], [["PO-1", "Steel Ltd", "Sam"]]),
      sheet("Invoices", ["Invoice No", "Customer", "Total", "Invoice sent by", "Delivery note signed by"], [["INV-1", "A", 1, "Jo", "Kim"]]),
    ]);
    expect(built.payload.purchase_orders).toEqual([{ row: 2, po_ref: "PO-1", supplier: "Steel Ltd", sent_by: "Sam" }]);
    expect(built.payload.invoices).toEqual([{ row: 2, invoice_ref: "INV-1", customer: "A", total: "1", sent_by: "Jo" }]);
    const said = built.notices.map((n) => n.message);
    expect(said).toEqual(['Invoices: the column "Delivery note signed by" (Delivery note signed by) is not part of invoices, so it is not imported.']);
    expect(JSON.stringify(built.payload)).not.toContain("Kim");
  });

  it("a payments export's reversals are skipped and said", async () => {
    const built = await build([sheet("Payments", ["Invoice No", "Paid On", "Amount", "Method", "Type", "Reversed"], [
      ["INV-1", "2026-10-01", 50, "BACS", "Payment", "Yes"],
      ["INV-1", "2026-10-02", -50, "BACS", "Reversal", ""],
      ["INV-1", "2026-10-03", 70, "BACS", "Payment", "No"],
    ])]);
    expect(built.payload.payments).toEqual([{ row: 4, invoice_ref: "INV-1", paid_on: "2026-10-03", amount: "70", method: "BACS" }]);
    expect(built.notices[0].message).toContain("2 reversed payment rows");
  });
});

describe("lines and duplicates", () => {
  const lines = sheet("Invoices", ["Invoice No", "Customer", "Invoice Date", "Description", "Qty", "Unit Price"], [
    ["INV-1", "Acme", "2026-10-01", "Bracket", 2, 10],
    ["INV-1", "Acme", "2026-10-01", "Plate", 1, 5.5],
    ["INV-2", "Acme", "2026-10-01", "Spacer", 4, 1],
  ]);

  it("rows with the same document number become one document with its lines", async () => {
    const built = await build([lines]);
    expect(built.payload.invoices).toEqual([
      { row: 2, invoice_ref: "INV-1", customer: "Acme", invoice_date: "2026-10-01", lines: [{ description: "Bracket", quantity: "2", unit_price: "10" }, { description: "Plate", quantity: "1", unit_price: "5.5" }] },
      { row: 4, invoice_ref: "INV-2", customer: "Acme", invoice_date: "2026-10-01", lines: [{ description: "Spacer", quantity: "4", unit_price: "1" }] },
    ]);
  });

  it("without line columns a repeated number is NOT merged: the database reports it twice in the file", async () => {
    const built = await build([sheet("Invoices", ["Invoice No", "Customer", "Total"], [["INV-1", "A", 1], ["INV-1", "A", 1]])]);
    expect(built.payload.invoices).toHaveLength(2);
  });

  it("rows with no document number are not merged either: each stays a row for the database to refuse", async () => {
    const built = await build([sheet("Invoices", ["Invoice No", "Customer", "Total"], [[null, "A", 1], [null, "B", 2]])]);
    expect(built.payload.invoices).toEqual([{ row: 2, customer: "A", total: "1" }, { row: 3, customer: "B", total: "2" }]);
  });

  it("the size is the most the import can write", async () => {
    const built = await build([lines]);
    // Two invoices (2 audit rows each) and three lines.
    expect(estimateSize(built.payload)).toEqual({ records: 2, lines: 3, audit_rows: 7 });
  });
});
