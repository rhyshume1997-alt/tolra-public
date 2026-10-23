/**
 * Credit notes (migration 034, W4), the parts that run in the app: a balance that counts the credits applied, the credit note
 * PDF (the invoice layout with the title "Credit Note"), and the year-end credits.csv.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { storedTotalsProblem } from "@/components/pdf/BaseDocumentPDF";
import { CreditNotePDF, type CreditNotePdfData } from "@/components/pdf/CreditNotePDF";
import { InvoicePDF } from "@/components/pdf/InvoicePDF";
import { JNR_PROFILE } from "@/lib/company";
import { creditPreview, creditableQuantity, startingQuantity } from "@/lib/credit-draft";
import { DocumentTotalsMismatchError } from "@/lib/document-integrity";
import { balanceDue, customerCredit, isPartPaid, owed } from "@/lib/receivables";
import { creditExportRows, creditsCsv } from "@/lib/year-end-export";
import { pdfText } from "../support/pdf-text";

describe("customer credit: balance = total - payments - credits + refunds", () => {
  it("a £120 invoice with £60 paid and £80 credit is settled and leaves £20 of customer credit", () => {
    const invoice = { status: "paid", total: 120, amount_paid: 60, credited_amount: 80, refunded_amount: 0 };
    expect(balanceDue(120, 60, 80)).toBe(0);
    expect(owed(invoice)).toBe(0);
    expect(customerCredit(invoice)).toBe(20);
  });
  it("a refund or a transfer to another invoice takes it out of the credit, and a reversed payment brings the balance back", () => {
    expect(customerCredit({ status: "paid", total: 120, amount_paid: 60, credited_amount: 80, refunded_amount: 20 })).toBe(0);
    expect(customerCredit({ status: "paid", total: 120, amount_paid: 60, credited_amount: 80, refunded_amount: 5 })).toBe(15);
    expect(balanceDue(120, 0, 80, 20)).toBe(60);
  });
  it("there is none on a draft, void or unconfirmed invoice, or when nothing is over", () => {
    expect(customerCredit({ status: "draft", total: 120, amount_paid: 200 })).toBe(0);
    expect(customerCredit({ status: "void", total: 120, amount_paid: 200 })).toBe(0);
    expect(customerCredit({ status: "sent", total: 120, amount_paid: 200, payment_unverified: true })).toBe(0);
    expect(customerCredit({ status: "paid", total: 120, amount_paid: 120 })).toBe(0);
  });
});

describe("what is owed counts the credits applied", () => {
  it("balance = total - payments - credits, never below zero", () => {
    expect(balanceDue(120, 0, 60)).toBe(60);
    expect(balanceDue(120, 50, 60)).toBe(10);
    expect(balanceDue(120, 60, 60)).toBe(0);
    expect(balanceDue(120, 100, 60)).toBe(0);
    expect(balanceDue(120, 50)).toBe(70); // callers that know nothing of credits are unchanged
  });

  it("owed() and isPartPaid() follow, and a credited invoice is closed", () => {
    expect(owed({ status: "issued", total: 120, amount_paid: 0, credited_amount: 60 })).toBe(60);
    expect(owed({ status: "partial", total: 120, amount_paid: 40, credited_amount: 60 })).toBe(20);
    expect(owed({ status: "credited", total: 120, amount_paid: 0, credited_amount: 120 })).toBe(0);
    expect(owed({ status: "paid", total: 120, amount_paid: 60, credited_amount: 60 })).toBe(0);
    expect(isPartPaid({ status: "issued", total: 120, amount_paid: 40, credited_amount: 80 })).toBe(false); // nothing left: not "part paid"
    expect(isPartPaid({ status: "issued", total: 120, amount_paid: 40, credited_amount: 20 })).toBe(true);
  });
});

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
const credit: CreditNotePdfData = {
  number: "CN-0007", date: "07/03/2026", invoiceRef: "INV-7100", billTo: ["Example Customer Ltd"], reason: "Two bushes returned, out of tolerance",
  lineItems: [{ description: "Bush", quantity: 2, unitPrice: 50, vatPct: 20 }], vatEnabled: true, company,
  storedTotals: { reference: "CN-0007", issued: true, subtotal: 100, vat: 20, total: 120 },
};
const text = async (element: Parameters<typeof renderToBuffer>[0]) => pdfText(await renderToBuffer(element));

describe("CreditNotePDF", () => {
  it("is the invoice layout titled Credit Note, with the credit note number, the invoice it credits and the reason", async () => {
    const out = await text(createElement(CreditNotePDF, { data: credit }) as Parameters<typeof renderToBuffer>[0]);
    expect(out).toContain("CREDIT NOTE");
    expect(out).toMatch(/Credit Note No\.[\s\S]*CN-0007[\s\S]*Date[\s\S]*07\/03\/2026[\s\S]*Invoice No\.[\s\S]*INV-7100/);
    expect(out).toContain("Example Customer Ltd");
    expect(out).toContain("Two bushes returned, out of tolerance");
    expect(out).toMatch(/Subtotal:[\s\S]*100\.00/);
    expect(out).toMatch(/120\.00/);
    // It is not an invoice: no Paid or Balance due rows, no terms.
    expect(out).not.toMatch(/Balance due/i);
    expect(out).not.toMatch(/Terms/);
  });

  it("is checked against its stored totals like an invoice: matching lines pass, a different total is refused", () => {
    expect(storedTotalsProblem({ lineItems: credit.lineItems, showVat: true, company, storedTotals: credit.storedTotals })).toBeNull();
    expect(storedTotalsProblem({ lineItems: credit.lineItems, showVat: true, company, storedTotals: { reference: "CN-0007", issued: true, subtotal: 100, vat: 20, total: 150 } })).toBeInstanceOf(DocumentTotalsMismatchError);
  });

  it("prints the VAT the database fixed for a credit that took a rounding remainder (2 x £50.03: £10.01 then £10.00), and still refuses a different total", async () => {
    const second: CreditNotePdfData = {
      ...credit, number: "CN-0008", lineItems: [{ description: "Bush", quantity: 1, unitPrice: 50.03, vatPct: 20, vatAmount: 10 }],
      storedTotals: { reference: "CN-0008", issued: true, subtotal: 50.03, vat: 10, total: 60.03 },
    };
    expect(storedTotalsProblem({ lineItems: second.lineItems, showVat: true, company, storedTotals: second.storedTotals })).toBeNull();
    const out = await text(createElement(CreditNotePDF, { data: second }) as Parameters<typeof renderToBuffer>[0]);
    expect(out).toMatch(/60\.03/);
    // Worked out from the rate alone the line would be £10.01, so without the fixed amount the stored £60.03 would not match.
    expect(storedTotalsProblem({ lineItems: [{ ...second.lineItems[0], vatAmount: undefined }], showVat: true, company, storedTotals: second.storedTotals })).toBeInstanceOf(DocumentTotalsMismatchError);
  });

  it("leaves the invoice PDF exactly as it was", async () => {
    const before = await text(createElement(InvoicePDF, { data: { number: "INV-7100", date: "07/03/2026", billTo: ["Example Customer Ltd"], lineItems: [{ description: "Bush", quantity: 2, unitPrice: 50, vatPct: 20 }], vatEnabled: true, payments: 0, company } }) as Parameters<typeof renderToBuffer>[0]);
    expect(before).toContain("INVOICE");
    expect(before).toMatch(/Invoice No\.[\s\S]*Date[\s\S]*Terms/);
    expect(before).not.toMatch(/Credit/i);
  });
});

describe("year-end credits.csv", () => {
  const invoices = [{ id: "i1", invoice_ref: "INV-0001" }, { id: "i2", invoice_ref: "INV-0002" }];
  const note = (id: string, ref: string | null, status: string, date: string, over: Record<string, unknown> = {}) => ({
    id, credit_ref: ref, status, invoice_id: "i1", customer: "Credit Co", credit_date: date, created_at: `${date}T09:00:00+00:00`, subtotal: 50, vat: 10, total: 60, allocated_amount: 0, ...over,
  });
  const notes = [
    note("c1", "CN-0001", "issued", "2026-04-01", { allocated_amount: 40 }),
    note("c2", "CN-0002", "issued", "2026-09-30", { invoice_id: "i2", customer: "=HYPERLINK(\"http://example.test\")", total: 120, subtotal: 100, vat: 20, allocated_amount: 120 }),
    note("c3", null, "draft", "2026-05-01"), // a draft is not an issued record
    note("c4", "CN-0003", "issued", "2026-03-31"), // the day before the period
    note("c5", "CN-0004", "issued", "2026-10-01"), // the day after
  ];
  const allocations = [
    { credit_note_id: "c1", allocated_on: "2026-04-02", amount: 10 },
    { credit_note_id: "c1", allocated_on: "2026-04-20", amount: 30 },
    { credit_note_id: "c2", allocated_on: "2026-10-05", amount: 120 },
  ];

  it("lists the issued credit notes dated in the period (both ends included), against their invoice, with what has been applied", () => {
    const rows = creditExportRows(notes, invoices, allocations, "2026-04-01", "2026-09-30");
    expect(rows.map((r) => [r.credit, r.invoice, r.gross, r.applied, r.left, r.lastApplied])).toEqual([
      ["CN-0001", "INV-0001", 60, 40, 20, "2026-04-20"],
      ["CN-0002", "INV-0002", 120, 120, 0, "2026-10-05"],
    ]);
  });

  it("is a CSV with a BOM, CRLF line ends, UK dates, two-column money and neutralised text", () => {
    const csv = creditsCsv(creditExportRows(notes, invoices, allocations, "2026-04-01", "2026-09-30"));
    expect(csv.startsWith("﻿Credit note,Invoice,Date,Customer,Net,VAT,Gross,Applied,Left to apply,Last applied\r\n")).toBe(true);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("CN-0001,INV-0001,01/04/2026,Credit Co,50.00,10.00,60.00,40.00,20.00,20/04/2026");
    expect(lines[2]).not.toMatch(/,=HYPERLINK/); // a formula in a customer name can't run
    expect(creditsCsv([])).toBe("﻿Credit note,Invoice,Date,Customer,Net,VAT,Gross,Applied,Left to apply,Last applied\r\n");
  });
});

describe("the New credit note form starts at the full creditable quantity", () => {
  const lines = [
    { quantity: 12, unitPrice: 10, credited: 0, vatPct: 20, vatExempt: false },
    { quantity: 5, unitPrice: 4, credited: 2, vatPct: 20, vatExempt: false },
    { quantity: 3, unitPrice: 8, credited: 3, vatPct: 20, vatExempt: false },
    { quantity: 1, unitPrice: 100, credited: 0, vatPct: 0, vatExempt: true },
  ];

  it("is the line's quantity less what is already credited, never below 0 and without floating point dust", () => {
    expect(lines.map(startingQuantity)).toEqual(["12", "3", "0", "1"]);
    expect(creditableQuantity({ quantity: 0.3, credited: 0.1 })).toBe(0.2);
    expect(creditableQuantity({ quantity: 2, credited: 5 })).toBe(0);
  });

  it("the net, VAT and total follow what is typed at once, each line at its own VAT", () => {
    const start = lines.map(startingQuantity);
    const prices = lines.map((l) => l.unitPrice.toFixed(2));
    // 12 x 10 + 3 x 4 + 0 + 1 x 100 (exempt) = 232 net; VAT 20% on 132 = 26.40.
    expect(creditPreview(lines, start, prices, true)).toEqual({ subtotal: 232, vat: 26.4, total: 258.4 });
    // Lowered to 8 of the first line and left out the exempt line.
    expect(creditPreview(lines, ["8", "3", "0", "0"], prices, true)).toEqual({ subtotal: 92, vat: 18.4, total: 110.4 });
    // A cleared box counts as nothing; an invoice without VAT credits none.
    expect(creditPreview(lines, ["", "", "", ""], prices, true)).toEqual({ subtotal: 0, vat: 0, total: 0 });
    expect(creditPreview(lines, start, prices, false)).toEqual({ subtotal: 232, vat: 0, total: 232 });
  });
});
