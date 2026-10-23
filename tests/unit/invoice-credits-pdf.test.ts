/**
 * Credit notes on the invoice PDF. JNR's accountant has approved the invoice layout, so by default credit notes change
 * nothing on it. With the company setting "Show credit notes in Balance due on invoice PDFs" on, the Balance due is the total
 * less payments less the credits applied, and one "Less credit notes" line joins the box beside the invoice number.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { computePdfTotals } from "@/components/pdf/BaseDocumentPDF";
import { InvoicePDF, type InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { COMPANY_PROFILES, JNR_PROFILE, parseCompanyProfile } from "@/lib/company";
import { invoicePdfCredits, invoicePdfPayments } from "@/lib/invoice-pdf-data";
import { balanceDue } from "@/lib/receivables";
import { pdfText } from "../support/pdf-text";

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
// 2 x £50 + 20% VAT = £120; £20 paid; £60 of credit notes applied.
const invoice = { status: "partial", amount_paid: 20, credited_amount: 60 };
const base: InvoicePdfData = {
  number: "INV-7200", date: "07/03/2026", billTo: ["Example Customer Ltd"], lineItems: [{ description: "Bush", quantity: 2, unitPrice: 50, vatPct: 20 }],
  vatEnabled: true, payments: 20, company, storedTotals: { reference: "INV-7200", issued: true, subtotal: 100, vat: 20, total: 120 },
};
const text = async (data: InvoicePdfData) => pdfText(await renderToBuffer(createElement(InvoicePDF, { data }) as Parameters<typeof renderToBuffer>[0]));

describe("setting off (the default)", () => {
  it("is off in a new profile and in a stored one without the key; only an explicit true turns it on", () => {
    expect(COMPANY_PROFILES.jnr.showCreditsInBalance).toBe(false);
    const stored = { documentName: "X Ltd", addressLines: ["1 Road"], vatRegistered: false };
    expect(parseCompanyProfile(stored)?.showCreditsInBalance).toBe(false);
    expect(parseCompanyProfile({ ...stored, showCreditsInBalance: "true" })?.showCreditsInBalance).toBe(false);
    expect(parseCompanyProfile({ ...stored, showCreditsInBalance: true })?.showCreditsInBalance).toBe(true);
  });

  it("a credited invoice's PDF is identical to the PDF of the same invoice with no credit, whatever the credit", async () => {
    const credits = invoicePdfCredits(invoice, { showCreditsInBalance: false });
    expect(credits).toEqual({});
    const credited = await text({ ...base, ...credits });
    const plain = await text(base);
    expect(credited).toBe(plain);
    expect(credited).not.toMatch(/Less credit notes/);
    expect(credited).toMatch(/Balance due[\s\S]*100\.00/); // 120 - 20, the credit ignored
  });
});

describe("setting on", () => {
  it("takes the credits off Balance due, keeps Paid at the payments, and adds one line between Date and Terms", async () => {
    const credits = invoicePdfCredits({ ...invoice, total: 120 }, { showCreditsInBalance: true });
    expect(credits).toEqual({ credits: 60 });
    const out = await text({ ...base, ...credits });
    expect(out).toMatch(/Invoice No\.[\s\S]*Date[\s\S]*Less credit notes[\s\S]*Terms/);
    expect(out.match(/Less credit notes/g)).toHaveLength(1);
    expect(out).toMatch(/Paid[\s\S]*20\.00/);
    expect(out).toMatch(/Balance due[\s\S]*40\.00/); // 120 - 20 - 60
    expect(out).toContain("60.00");
  });

  it("never shows more credit than the invoice still owed: a credit beyond it is customer credit, kept off the PDF", () => {
    expect(invoicePdfCredits({ credited_amount: 80, total: 120, amount_paid: 60 }, { showCreditsInBalance: true })).toEqual({ credits: 60 });
    expect(invoicePdfCredits({ credited_amount: 80, total: 120, amount_paid: 120 }, { showCreditsInBalance: true })).toEqual({});
  });

  it("with the setting on but nothing credited, the PDF is unchanged", async () => {
    expect(invoicePdfCredits({ credited_amount: 0 }, { showCreditsInBalance: true })).toEqual({});
    expect(await text({ ...base, ...invoicePdfCredits({ credited_amount: 0 }, { showCreditsInBalance: true }) })).toBe(await text(base));
  });

  it("is not applied to an invoice whose payments are unknown (it prints the Total only)", async () => {
    const unknown = await text({ ...base, payments: undefined, paymentUnknown: true, credits: 60 });
    expect(unknown).not.toMatch(/Less credit notes/);
    expect(unknown).toBe(await text({ ...base, payments: undefined, paymentUnknown: true }));
  });
});

describe("the PDF's Balance due is the balance the screen shows (refunds and applied customer credit count)", () => {
  // The screen: total - payments - credits applied + refunded, never below zero (lib/receivables balanceDue).
  const settings = { showCreditsInBalance: true };
  const pdfBalance = (row: { total: number; amount_paid: number; credited_amount: number; refunded_amount: number }) =>
    computePdfTotals({ lineItems: [{ description: "Bush", quantity: 1, unitPrice: row.total, vatExempt: true }], showVat: false, payments: row.amount_paid, ...invoicePdfCredits(row, settings) }).balance;

  it("£120 invoiced, £20 paid, £60 credited, £20 of it since refunded or moved to another invoice: £60 owed on the screen, so £60 on the PDF (not £40)", async () => {
    const row = { total: 120, amount_paid: 20, credited_amount: 60, refunded_amount: 20 };
    expect(balanceDue(row.total, row.amount_paid, row.credited_amount, row.refunded_amount)).toBe(60);
    expect(invoicePdfCredits(row, settings)).toEqual({ credits: 40 }); // 60 applied less 20 that left again
    expect(pdfBalance(row)).toBe(60);
    const out = await text({ ...base, ...invoicePdfCredits(row, settings) });
    expect(out).toMatch(/Less credit notes[\s\S]*40\.00/);
    expect(out).toMatch(/Balance due[\s\S]*60\.00/);
  });

  it("customer credit applied from another invoice counts like a credit note", () => {
    // credited_amount already holds credit moved in from another invoice (apply_customer_credit).
    const row = { total: 120, amount_paid: 0, credited_amount: 30, refunded_amount: 0 };
    expect(invoicePdfCredits(row, settings)).toEqual({ credits: 30 });
    expect(pdfBalance(row)).toBe(90);
  });

  it("a credit that has been refunded in full leaves nothing to show", () => {
    expect(invoicePdfCredits({ total: 120, amount_paid: 120, credited_amount: 30, refunded_amount: 30 }, settings)).toEqual({});
    expect(invoicePdfCredits({ total: 120, amount_paid: 0, credited_amount: 30, refunded_amount: 30 }, settings)).toEqual({});
  });

  it("agrees with the screen for every combination of payments, credits and refunds on a £120 invoice (steps of £10)", () => {
    for (const paid of [0, 20, 60, 120]) for (const credited of [0, 10, 60, 80, 120, 150]) for (const refunded of [0, 10, 20, 40]) {
      // Only states the database can reach: what has left (refunded) is at most the surplus of payments and credits over the invoice.
      if (refunded > 0 && refunded > Math.max(0, paid + credited - 120)) continue;
      const row = { total: 120, amount_paid: paid, credited_amount: credited, refunded_amount: refunded };
      expect({ row, pdf: pdfBalance(row) }).toEqual({ row, pdf: balanceDue(120, paid, credited, refunded) });
    }
  });

  it("is off with the setting off whatever the refunds", () => {
    expect(invoicePdfCredits({ total: 120, amount_paid: 20, credited_amount: 60, refunded_amount: 20 }, { showCreditsInBalance: false })).toEqual({});
  });
});

describe("the PAID stamp follows the PDF's own Balance due", () => {
  // £120 invoiced, £60 paid, £80 credited: the database calls it paid (£60 settles it, £20 is customer credit).
  const row = { status: "paid", total: 120, amount_paid: 60, credited_amount: 80, refunded_amount: 0, payment_unverified: false };
  const pdf = (showCreditsInBalance: boolean) => ({ ...base, number: "INV-7300", storedTotals: { ...base.storedTotals!, reference: "INV-7300" },
    ...invoicePdfPayments(row), ...invoicePdfCredits(row, { showCreditsInBalance }) });

  it("setting off (the default): £60 paid, £60 Balance due and no PAID stamp", async () => {
    const out = await text(pdf(false));
    expect(out).toMatch(/Balance due[\s\S]*60\.00/);
    expect(out).not.toMatch(/\bPAID\b/);
  });

  it("setting on: less £60 of credit notes, Balance due £0.00 and the PAID stamp", async () => {
    const out = await text(pdf(true));
    expect(out).toMatch(/Balance due[\s\S]*0\.00/);
    expect(out).toMatch(/\bPAID\b/);
  });

  it("a plain paid invoice still gets the stamp", async () => {
    const out = await text({ ...base, number: "INV-7301", storedTotals: { ...base.storedTotals!, reference: "INV-7301" }, ...invoicePdfPayments({ status: "paid", amount_paid: 120 }) });
    expect(out).toMatch(/\bPAID\b/);
  });
});
