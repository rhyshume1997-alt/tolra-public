/**
 * The small workbook the Admin > Data e2e uploads (customers, quotes, invoices with lines, payments), shared with the unit test that builds
 * its payload and the local database proof, so the three use the same data. Sheets are in the wrong order on purpose.
 */
import type { TestCell } from "./workbook";

/** The small workbook: customers + quotes + invoices (with lines) + payments, sheets in the wrong order on purpose. */
export function smallWorkbook(tag: string) {
  const customer = `DI Import Co ${tag} Ltd`;
  return {
    customer,
    inv1: `INV-DI-${tag}-1`,
    inv2: `INV-DI-${tag}-2`,
    quote: `QUO-DI-${tag}-1`,
    sheets: [
      { name: "Payments", rows: [["Invoice No", "Paid On", "Amount", "Method", "Reference"], [`INV-DI-${tag}-1`, "2026-10-02", 60, "BACS", "PAY-1"]] },
      { name: "Invoices", rows: [
        ["Invoice No", "Customer", "Invoice Date", "Description", "Qty", "Unit Price"],
        [`INV-DI-${tag}-1`, customer, "2026-10-01", "Bracket", 2, 30],
        [`INV-DI-${tag}-1`, customer, "2026-10-01", "Plate", 1, 40],
        [`INV-DI-${tag}-2`, customer, "2026-10-01", "Spacer", 4, 5],
      ] },
      { name: "Quotes", rows: [["Quote Ref", "Customer", "Quote Date", "Total"], [`QUO-DI-${tag}-1`, customer, "2026-09-20", 100]] },
      { name: "Customers", rows: [["Name", "Contact", "Email", "Account Memo"], [customer, "Pat Buyer", `pat.${tag}@example.test`, "Pays on the 28th"]] },
    ] as { name: string; rows: TestCell[][] }[],
  };
}

