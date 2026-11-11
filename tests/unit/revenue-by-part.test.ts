/**
 * BOUNDARY: Revenue stage 1, invoiced revenue by part number (lib/reports/revenue/by-part). Input: in-memory rows. Output: assertions.
 * Must not change: the table always adds up to the invoiced figure; a part number only ever comes from a linked order line; nothing is
 * grouped by description.
 */
import { describe, expect, it } from "vitest";

import { CARRIAGE, CREDIT_NOTES_ROW, invoicedByPart, UNCATEGORISED, type InvoiceLineRow, type PartInvoice } from "@/lib/reports/revenue/by-part";
import { invoicedRevenue } from "@/lib/reports/revenue/invoiced";

const range = { from: "2026-01-01", to: "2026-03-31" };
const orderLines = [{ id: "ol-1", part_number: " PN-100 " }, { id: "ol-2", part_number: "PN-200" }, { id: "ol-blank", part_number: "   " }];
const invoice = (id: string, net: number, carriage = 0, over: Partial<PartInvoice> = {}): PartInvoice => ({ id, customer: "Acme", status: "sent", subtotal: net - carriage, carriage, vat: net * 0.2, total: net * 1.2, invoice_date: "2026-01-10", ...over });
const line = (invoice_id: string, quantity: number, unit_price: number, sales_order_line_id: string | null = null, line_kind: string | null = sales_order_line_id ? "order" : "manual"): InvoiceLineRow => ({ invoice_id, quantity, unit_price, sales_order_line_id, line_kind });
const rowOf = (rows: ReturnType<typeof invoicedByPart>["rows"], part: string) => rows.find((r) => r.part === part);

describe("invoiced by part number", () => {
  it("puts a linked line with a part number under that part (trimmed); manual, unlinked and blank-part lines under Uncategorised", () => {
    const lines = [line("i1", 2, 50, "ol-1"), line("i1", 1, 30, "ol-2"), line("i1", 1, 20), line("i1", 1, 10, "ol-blank"), line("i1", 1, 5, "ol-missing")];
    const result = invoicedByPart([invoice("i1", 165)], lines, orderLines, [], range);
    expect(rowOf(result.rows, "PN-100")?.partNet).toBe(100);
    expect(rowOf(result.rows, "PN-200")?.partNet).toBe(30);
    expect(rowOf(result.rows, UNCATEGORISED)?.partNet).toBe(35);
    expect(result.mismatchedInvoices).toBe(0);
    expect(result.partNetTotal).toBe(165);
  });

  it("never groups by description: two manual lines with the same description stay Uncategorised", () => {
    const result = invoicedByPart([invoice("i1", 30)], [{ ...line("i1", 1, 10), ...{ description: "Bush" } } as InvoiceLineRow, line("i1", 2, 10)], orderLines, [], range);
    expect(result.rows.map((r) => r.part)).toEqual([UNCATEGORISED]);
  });

  it("shows carriage as its own row", () => {
    const result = invoicedByPart([invoice("i1", 110, 10)], [line("i1", 1, 100, "ol-2")], orderLines, [], range);
    expect(rowOf(result.rows, CARRIAGE)).toMatchObject({ partNet: 10, partKind: "carriage" });
    expect(result.partNetTotal).toBe(110);
  });

  it("shows issued credit notes as one row, on their own date, not a draft", () => {
    const credits = [
      { customer: "Acme", status: "issued", vat: 4, total: 24, credit_date: "2026-02-01" },
      { customer: "Acme", status: "issued", vat: 2, total: 12, credit_date: "2026-03-01" },
      { customer: "Acme", status: "draft", vat: 50, total: 300, credit_date: "2026-03-01" },
    ];
    const result = invoicedByPart([invoice("i1", 100)], [line("i1", 1, 100, "ol-1")], orderLines, credits, range);
    expect(rowOf(result.rows, CREDIT_NOTES_ROW)).toMatchObject({ partNet: -30, partKind: "credit" });
    expect(result.partNetTotal).toBe(70);
  });

  it("an invoice whose lines do not add up is counted and its whole net goes to Uncategorised", () => {
    const lines = [line("i1", 1, 50, "ol-1"), line("i2", 1, 100, "ol-1")];
    const result = invoicedByPart([invoice("i1", 100), invoice("i2", 100)], lines, orderLines, [], range);
    expect(result.mismatchedInvoices).toBe(1);
    expect(rowOf(result.rows, "PN-100")?.partNet).toBe(100); // only the invoice that adds up
    expect(rowOf(result.rows, UNCATEGORISED)?.partNet).toBe(100);
    expect(result.partNetTotal).toBe(200);
  });

  it("an issued invoice with no lines at all does not add up, and carriage on a mismatched invoice is not split out", () => {
    const result = invoicedByPart([invoice("i1", 100), invoice("i2", 100, 10)], [line("i2", 1, 50, "ol-1")], orderLines, [], range);
    expect(result.mismatchedInvoices).toBe(2);
    expect(result.rows.map((r) => r.part)).toEqual([UNCATEGORISED]);
    expect(result.partNetTotal).toBe(200);
  });

  it("uses the invoice rule for the net: total less VAT, so VAT-exempt lines and carriage VAT cannot upset it", () => {
    // Total 130 incl VAT 20 on a 100 line, carriage 10 not taxed: net 110.
    const exempt = { ...invoice("i1", 110, 10), subtotal: 100, vat: 20, total: 130 };
    const result = invoicedByPart([exempt], [line("i1", 4, 25, "ol-1")], orderLines, [], range);
    expect(result.mismatchedInvoices).toBe(0);
    expect(result.partNetTotal).toBe(110);
  });

  it("rounds a line once, in pence (quantity x price), like the invoice", () => {
    const result = invoicedByPart([invoice("i1", 0.15)], [line("i1", 3, 0.05, "ol-1")], orderLines, [], range);
    expect(result.mismatchedInvoices).toBe(0);
    expect(rowOf(result.rows, "PN-100")?.partNet).toBe(0.15);
  });

  it("an invoice with no figures is counted and the total and shares are null", () => {
    const result = invoicedByPart([invoice("i1", 100), { id: "i2", customer: "Acme", status: "sent", invoice_date: "2026-01-11" }], [line("i1", 1, 100, "ol-1")], orderLines, [], range);
    expect(result.unknownInvoices).toBe(1);
    expect(result.partNetTotal).toBeNull();
    expect(result.rows.every((r) => r.partShare === null)).toBe(true);
  });

  it("leaves out draft/void invoices, other days and other customers, and its total equals the invoiced card", () => {
    const invoices = [invoice("i1", 100), invoice("i2", 50, 0, { customer: "Beta" }), invoice("i3", 999, 0, { status: "draft" }), invoice("i4", 999, 0, { invoice_date: "2025-12-31" })];
    const lines = [line("i1", 1, 100, "ol-1"), line("i2", 1, 50, "ol-2")];
    expect(invoicedByPart(invoices, lines, orderLines, [], range).partNetTotal).toBe(invoicedRevenue(invoices, [], range).invoicedTotal);
    expect(invoicedByPart(invoices, lines, orderLines, [], range, "Beta").rows.map((r) => r.part)).toEqual(["PN-200"]);
  });

  it("shares add to 100", () => {
    const result = invoicedByPart([invoice("i1", 3)], [line("i1", 1, 1, "ol-1"), line("i1", 1, 1, "ol-2"), line("i1", 1, 1)], orderLines, [], range);
    expect(result.rows.reduce((sum, r) => sum + (r.partShare ?? 0), 0)).toBe(100);
  });
});
