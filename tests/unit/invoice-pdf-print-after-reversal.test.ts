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

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined,
  bankDetails: { ...JNR_PROFILE.bankDetails, bankName: "Synthetic Payment Bank", accountNumber: "87654321" },
  defaultInvoiceMessage: ["Please pay by electronic transfer."],
};

/** The PDF for an invoice of £120.00 (100.00 + 20.00 VAT) whose recorded payments are `amounts` (a negative one is a reversal). */
async function printedWith(amounts: number[], status: string, design?: string, paymentUnverified = false) {
  const amountPaid = netPaid(amounts.map((amount) => ({ amount })));
  const data: InvoicePdfData = {
    number: "INV-0300", date: "01/05/2026", billTo: ["Synthetic Customer Ltd"], lineItems: [{ description: "Bush", quantity: 1, unitPrice: 100, vatPct: 20 }],
    vatEnabled: true, company, design, note: "Send payment to the office.", storedTotals: { reference: "INV-0300", issued: true, subtotal: 100, vat: 20, total: 120 },
    ...invoicePdfPayments({ status, amount_paid: amountPaid, payment_unverified: paymentUnverified }),
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

describe.each(["classic", "modern", "minimal"])("%s invoice PDF lifecycle", (design) => {
  it.each([["void", [], "Void", "0.00"], ["written_off", [50], "Written off", "50.00"]] as const)(
    "prints no payment instructions or balance outstanding for %s",
    async (status, payments, label, paid) => {
      const text = await printedWith([...payments], status, design);
      expect(text).toMatch(/Balance due\s*:?\s*£0\.00/i);
      expect(text).toMatch(new RegExp(`Paid\\s*:?\\s*£${paid.replace(".", "\\.")}`, "i"));
      expect(text).toContain(label);
      expect(text).not.toMatch(/Synthetic Payment Bank|87654321|electronic transfer|Send payment|30 days/);
      expect(text).not.toContain("PAID");
    },
  );

  it("preserves an open unpaid invoice's balance and instructions", async () => {
    const text = await printedWith([], "issued", design);
    expect(text).toMatch(/Balance due\s*:?\s*£120\.00/i);
    expect(text).toContain("87654321");
    expect(text).toContain("electronic transfer");
    expect(text).toContain("Send payment");
  });
});

it("shows a closed balance of zero without guessing an unknown paid amount", async () => {
  const text = await printedWith([], "written_off", "classic", true);
  expect(figures(text)).toEqual({ paid: null, balance: "0.00", stamped: false });
  expect(text).not.toContain("87654321");
});
