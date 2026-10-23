/**
 * The printed invoice PDF after a part payment, after paying in full, and after a payment is reversed. The Paid and Balance due
 * come from the stored receipts through the same two helpers the invoice screen and the year-end builder use (netPaid for the
 * sum of the recorded payments, invoicePdfPayments for what the PDF may say), then the real InvoicePDF is rendered and its text
 * read back. What those builders hand to the PDF is pinned in invoice-pdf-after-reversal.test.ts.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { InvoicePDF, type InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { JNR_PROFILE } from "@/lib/company";
import { invoicePdfPayments } from "@/lib/invoice-pdf-data";
import { netPaid } from "@/lib/payments";
import { pdfText } from "../support/pdf-text";

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };

/** The PDF for an invoice of £120.00 (100.00 + 20.00 VAT) whose recorded payments are `amounts` (a negative one is a reversal). */
async function printedWith(amounts: number[], status: string) {
  const amountPaid = netPaid(amounts.map((amount) => ({ amount })));
  const data: InvoicePdfData = {
    number: "INV-0300", date: "01/05/2026", billTo: ["Synthetic Customer Ltd"], lineItems: [{ description: "Bush", quantity: 1, unitPrice: 100, vatPct: 20 }],
    vatEnabled: true, company, storedTotals: { reference: "INV-0300", issued: true, subtotal: 100, vat: 20, total: 120 },
    ...invoicePdfPayments({ status, amount_paid: amountPaid, payment_unverified: false }),
  };
  return pdfText(await renderToBuffer(createElement(InvoicePDF, { data }) as Parameters<typeof renderToBuffer>[0]));
}

const figures = (text: string) => ({
  paid: /Paid\s*:\s*£([\d.]+)/.exec(text)?.[1] ?? null,
  balance: /Balance due\s*:\s*£([\d.]+)/.exec(text)?.[1] ?? null,
  stamped: text.includes("PAID"),
});

describe("printed Paid and Balance due", () => {
  it("after a part payment: £50.00 paid, £70.00 due, no PAID stamp", async () => {
    expect(figures(await printedWith([50], "partial"))).toEqual({ paid: "50.00", balance: "70.00", stamped: false });
  });

  it("paid in full in two parts: £120.00 paid, nothing due, stamped PAID", async () => {
    expect(figures(await printedWith([50, 70], "paid"))).toEqual({ paid: "120.00", balance: "0.00", stamped: true });
  });

  it("paid in full and then the last payment reversed: back to £50.00 paid and £70.00 due, and the stamp is gone", async () => {
    const reversed = await printedWith([50, 70, -70], "partial");
    expect(figures(reversed)).toEqual({ paid: "50.00", balance: "70.00", stamped: false });
    // Exactly what an invoice that only ever had the £50.00 payment prints.
    expect(reversed).toBe(await printedWith([50], "partial"));
  });

  it("everything reversed: £0.00 paid, the whole £120.00 due, never stamped paid", async () => {
    const text = await printedWith([120, -120], "issued");
    expect(text).toMatch(/Invoice total\s*:?\s*£120\.00/);
    expect(figures(text)).toEqual({ paid: "0.00", balance: "120.00", stamped: false });
  });

  it("pence stay exact: £40.10 and £20.00 leave £59.90", async () => {
    expect(figures(await printedWith([40.1, 20], "partial"))).toEqual({ paid: "60.10", balance: "59.90", stamped: false });
  });
});
