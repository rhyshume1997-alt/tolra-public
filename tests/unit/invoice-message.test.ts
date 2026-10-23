/**
 * The default invoice message: baked into code, built from the company's invoice terms, used when the company's own invoice
 * message is empty (printed on the invoice PDF and prefilled in Settings > Company details). An edited message always wins.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { InvoicePDF, type InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { EMPTY_BANK_DETAILS } from "@/lib/bank-details";
import { defaultInvoiceMessage, invoiceMessage, JNR_PROFILE, parseCompanyProfile, parseTermsDays } from "@/lib/company";
import { toForm } from "@/lib/company-form";
import { pdfText } from "../support/pdf-text";

const line1 = (days: number) => `Payment is due within ${days} days of the invoice date.`;
const REST = ["Please quote the invoice number as your payment reference.", "Thank you for your business."];
const stored = { documentName: "Alpha Ltd", addressLines: ["Unit 1"], vatRegistered: false };

describe("parseTermsDays", () => {
  it("reads a whole number of days from free text", () => {
    expect(parseTermsDays("30 days")).toBe(30);
    expect(parseTermsDays("14")).toBe(14);
    expect(parseTermsDays("Net 60")).toBe(60);
    expect(parseTermsDays("60 days from invoice")).toBe(60);
  });

  it("falls back to 30 when there is no number (or only 0)", () => {
    for (const terms of ["On receipt", "Due on receipt", "End of month", "", "   ", "0 days", null, undefined]) expect(parseTermsDays(terms)).toBe(30);
  });
});

describe("the default invoice message", () => {
  it("is the agreed wording, one sentence per line, with the company's days", () => {
    expect(defaultInvoiceMessage("30 days")).toEqual([line1(30), ...REST]);
    expect(defaultInvoiceMessage("14")).toEqual([line1(14), ...REST]);
    expect(defaultInvoiceMessage("Net 60")).toEqual([line1(60), ...REST]);
    expect(defaultInvoiceMessage("End of month")).toEqual([line1(30), ...REST]);
    expect(defaultInvoiceMessage("1 day")[0]).toBe("Payment is due within 1 day of the invoice date.");
    expect(defaultInvoiceMessage("30 days").join(" ")).toBe("Payment is due within 30 days of the invoice date. Please quote the invoice number as your payment reference. Thank you for your business.");
  });

  it("never mentions bank details", () => {
    expect(defaultInvoiceMessage("30 days").join(" ")).not.toMatch(/bank|sort code|account|iban|bic/i);
  });

  it("is used when the company's invoice message is empty (JNR and any other company), using its own terms", () => {
    expect(invoiceMessage(JNR_PROFILE)).toEqual([line1(30), ...REST]);
    const marpet = parseCompanyProfile({ ...stored, defaultInvoiceTerms: "Net 14" })!;
    expect(invoiceMessage(marpet)).toEqual([line1(14), ...REST]);
    expect(invoiceMessage(parseCompanyProfile({ ...stored, defaultInvoiceTerms: "On receipt" })!)).toEqual([line1(30), ...REST]);
    // An invoice's own terms win over the company's for the default wording.
    expect(invoiceMessage(marpet, "60 days")).toEqual([line1(60), ...REST]);
  });

  it("an edited (non-empty) message always wins, unchanged", () => {
    const edited = parseCompanyProfile({ ...stored, defaultInvoiceTerms: "14 days", defaultInvoiceMessage: ["Pay us.", "", "Cheers"] })!;
    expect(invoiceMessage(edited)).toEqual(["Pay us.", "Cheers"]);
    expect(invoiceMessage(edited, "60 days")).toEqual(["Pay us.", "Cheers"]);
  });
});

describe("Settings > Company details prefill", () => {
  it("starts filled with the default, built from the current terms, when the stored message is empty", () => {
    expect(toForm(parseCompanyProfile({ ...stored, defaultInvoiceTerms: "14 days" })!).defaultInvoiceMessage).toBe([line1(14), ...REST].join("\n"));
    expect(toForm(JNR_PROFILE).defaultInvoiceMessage).toBe([line1(30), ...REST].join("\n"));
  });

  it("shows a stored message as it is", () => {
    expect(toForm(parseCompanyProfile({ ...stored, defaultInvoiceMessage: ["Mine", "Two"] })!).defaultInvoiceMessage).toBe("Mine\nTwo");
  });
});

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
const FULL_BANK = { accountName: "J N R Engineering Ltd", bankName: "Example Bank", sortCode: "12-34-56", accountNumber: "12345678", iban: "GB00EXAM12345612345678", bic: "EXAMGB2L" };
const invoiceData = (over: Partial<InvoicePdfData> = {}, bank = EMPTY_BANK_DETAILS): InvoicePdfData => ({
  number: "INV-7300", date: "07/03/2026", billTo: ["Example Customer Ltd"], lineItems: [{ description: "Bush", quantity: 2, unitPrice: 50, vatPct: 20 }],
  vatEnabled: true, payments: 0, company: { ...company, bankDetails: bank },
  storedTotals: { reference: "INV-7300", issued: true, subtotal: 100, vat: 20, total: 120 }, ...over,
});
const pdf = (data: InvoicePdfData) => renderToBuffer(createElement(InvoicePDF, { data }) as Parameters<typeof renderToBuffer>[0]);
const pageCount = (buffer: Buffer) => buffer.toString("latin1").match(/\/Type \/Page\b(?!s)/g)?.length;

describe("invoice PDF", () => {
  it("prints the default message when the company's is empty, and no bank details without any", async () => {
    const text = pdfText(await pdf(invoiceData()));
    for (const piece of [line1(30), ...REST]) expect(text).toContain(piece);
    expect(text).not.toContain("Payment details");
  });

  it("uses the invoice's own terms for the days", async () => {
    expect(pdfText(await pdf(invoiceData({ terms: "14 days" })))).toContain(line1(14));
  });

  it("prints an edited message instead of the default", async () => {
    const text = pdfText(await pdf(invoiceData({ company: { ...company, defaultInvoiceMessage: ["Pay by the end of the month."] } })));
    expect(text).toContain("Pay by the end of the month.");
    expect(text).not.toContain("Payment is due within");
  });

  it("still fits on one page with all six bank fields and a second VAT rate", async () => {
    const data = invoiceData({}, FULL_BANK);
    data.lineItems = [...data.lineItems, { description: "Pin", quantity: 1, unitPrice: 10, vatPct: 5 }];
    data.storedTotals = { reference: "INV-7300", issued: true, subtotal: 110, vat: 20.5, total: 130.5 };
    const buffer = await pdf(data);
    expect(pageCount(buffer)).toBe(1);
    const text = pdfText(buffer);
    expect(text).toContain(line1(30));
    expect(text).toContain("Payment details");
    expect(text).toContain("12345678");
  });
});
