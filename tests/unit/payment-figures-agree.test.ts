import { describe, expect, it } from "vitest";

import { computePdfTotals } from "@/components/pdf/BaseDocumentPDF";
import { knownPaid, netPaid } from "@/lib/payments";
import { balanceDue, owed } from "@/lib/receivables";
import { invoicePaidFigures } from "@/lib/year-end-export";

/**
 * One part-paid invoice, read four ways: the invoice screen (balanceDue on the stored total and amount paid), the PDF
 * (Paid and Balance due rows), receivables / aging (owed) and the year-end export (paid and balance due). They must give
 * the same paid and outstanding figures, here for £120.00 with payments of £40.10 and £20.00 (so £60.10 paid, £59.90 owed).
 */
describe("paid and outstanding agree everywhere for the same part-paid invoice", () => {
  const payments = [{ amount: 40.1 }, { amount: 20 }];
  const amountPaid = netPaid(payments); // invoices.amount_paid is exactly this sum
  const invoice = { invoice_ref: "INV-0001", status: "partial", total: 120, amount_paid: amountPaid, payment_unverified: false };

  it("screen, PDF, receivables and year-end export all say £60.10 paid and £59.90 outstanding", () => {
    expect(amountPaid).toBe(60.1);
    const screen = { paid: amountPaid, outstanding: balanceDue(invoice.total, amountPaid) };
    const pdf = computePdfTotals({ lineItems: [{ description: "Bush", quantity: 1, unitPrice: 100, vatPct: 20 }], showVat: true, carriage: 0, payments: amountPaid });
    const receivables = owed(invoice);
    const yearEnd = invoicePaidFigures(invoice);

    expect(screen).toEqual({ paid: 60.1, outstanding: 59.9 });
    expect(pdf.total).toBe(120);
    expect({ paid: pdf.payments, outstanding: pdf.balance }).toEqual(screen);
    expect(receivables).toBe(screen.outstanding);
    expect({ paid: yearEnd.paid, outstanding: yearEnd.balance }).toEqual(screen);
    expect(knownPaid(invoice)).toBe(screen.paid);
  });

  it("and after the rest is paid: paid in full, nothing outstanding, everywhere", () => {
    const settled = { ...invoice, status: "paid", amount_paid: netPaid([...payments, { amount: 59.9 }]) };
    expect(settled.amount_paid).toBe(120);
    expect(balanceDue(settled.total, settled.amount_paid)).toBe(0);
    expect(owed(settled)).toBe(0);
    expect(invoicePaidFigures(settled)).toMatchObject({ paid: 120, balance: 0 });
    expect(computePdfTotals({ lineItems: [{ description: "Bush", quantity: 1, unitPrice: 100, vatPct: 20 }], showVat: true, carriage: 0, payments: 120 })).toMatchObject({ payments: 120, balance: 0 });
  });
});
