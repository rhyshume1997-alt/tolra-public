/**
 * Bank details on invoices: structured fields in the company profile (JSONB), lenient parsing, light validation, and a
 * "Payment details" block on the invoice PDF only (never on quotes), listing only the filled fields.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { InvoicePDF, type InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { QuotePDF, type QuotePdfData } from "@/components/pdf/QuotePDF";
import { EMPTY_BANK_DETAILS, paymentDetailRows, parseBankDetails, validateBankDetails } from "@/lib/bank-details";
import { JNR_PROFILE, parseCompanyProfile, storedProfile } from "@/lib/company";
import { toForm } from "@/lib/company-form";
import { issuedCompany } from "@/lib/document-snapshot";
import { pdfText } from "../support/pdf-text";

const stored = { documentName: "Alpha Ltd", addressLines: ["Unit 1"], vatRegistered: false };
const FULL = { accountName: "J N R Engineering Ltd", bankName: "Example Bank", sortCode: "12-34-56", accountNumber: "12345678", iban: "GB00EXAM12345612345678", bic: "EXAMGB2L" };
const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };

describe("parsing and defaults", () => {
  it("a stored profile without bank details has all-empty ones; JNR's seed too", () => {
    expect(parseCompanyProfile(stored)?.bankDetails).toEqual(EMPTY_BANK_DETAILS);
    expect(JNR_PROFILE.bankDetails).toEqual(EMPTY_BANK_DETAILS);
  });

  it("reads leniently: wrong types and shapes become empty, text is trimmed, unknown keys are dropped", () => {
    expect(parseBankDetails(null)).toEqual(EMPTY_BANK_DETAILS);
    expect(parseBankDetails("12-34-56")).toEqual(EMPTY_BANK_DETAILS);
    expect(parseBankDetails([FULL])).toEqual(EMPTY_BANK_DETAILS);
    expect(parseBankDetails({ accountName: 5, bankName: " Example Bank ", sortCode: null, accountNumber: { x: 1 }, iban: "  GB00 ", other: "x" }))
      .toEqual({ ...EMPTY_BANK_DETAILS, bankName: "Example Bank", iban: "GB00" });
    expect(parseCompanyProfile({ ...stored, bankDetails: "nonsense" })?.bankDetails).toEqual(EMPTY_BANK_DETAILS);
  });

  it("round-trips through the stored profile and the settings form", () => {
    const profile = parseCompanyProfile({ ...stored, bankDetails: FULL })!;
    expect(profile.bankDetails).toEqual(FULL);
    expect(storedProfile(profile).bankDetails).toEqual(FULL);
    expect(toForm(profile).bank).toEqual(FULL);
  });
});

describe("validation", () => {
  it("accepts a sort code with or without dashes or spaces and tidies it to 12-34-56", () => {
    for (const sortCode of ["123456", "12-34-56", "12 34 56", " 12-3456 "]) {
      const check = validateBankDetails({ sortCode, accountNumber: "12345678" });
      expect(check.errors).toEqual([]);
      expect(check.bank.sortCode).toBe("12-34-56");
    }
  });

  it("refuses a sort code that is not 6 digits and an account number that is not 8 digits, with friendly messages", () => {
    expect(validateBankDetails({ sortCode: "12-34-5", accountNumber: "12345678" }).errors).toEqual(["The sort code needs 6 digits, like 12-34-56."]);
    expect(validateBankDetails({ sortCode: "12-34-5x", accountNumber: "12345678" }).errors).toHaveLength(1);
    expect(validateBankDetails({ sortCode: "123456", accountNumber: "1234567" }).errors).toEqual(["The account number needs 8 digits."]);
    expect(validateBankDetails({ sortCode: "123456", accountNumber: "1234 5678" }).bank.accountNumber).toBe("12345678");
    expect(validateBankDetails({ sortCode: "1", accountNumber: "2" }).errors).toHaveLength(2);
  });

  it("wants the sort code and account number together, but allows leaving everything empty", () => {
    expect(validateBankDetails({ sortCode: "123456" }).errors).toEqual(["Enter both the sort code and the account number, or leave both empty."]);
    expect(validateBankDetails({ accountNumber: "12345678" }).errors).toHaveLength(1);
    expect(validateBankDetails({}).errors).toEqual([]);
    expect(validateBankDetails(null).bank).toEqual(EMPTY_BANK_DETAILS);
  });

  it("IBAN and BIC are free-form but trimmed", () => {
    const check = validateBankDetails({ iban: "  GB00 EXAM 1234  ", bic: " exam gb2l " });
    expect(check.errors).toEqual([]);
    expect(check.bank.iban).toBe("GB00 EXAM 1234");
    expect(check.bank.bic).toBe("exam gb2l");
  });
});

describe("payment detail rows", () => {
  it("lists only the filled fields, in a fixed order", () => {
    expect(paymentDetailRows(FULL).map((r) => r.label)).toEqual(["Account name", "Bank", "Sort code", "Account number", "IBAN", "BIC"]);
    expect(paymentDetailRows({ ...EMPTY_BANK_DETAILS, sortCode: "12-34-56", accountNumber: "12345678" })).toEqual([
      { label: "Sort code", value: "12-34-56" }, { label: "Account number", value: "12345678" },
    ]);
    expect(paymentDetailRows(EMPTY_BANK_DETAILS)).toEqual([]);
    expect(paymentDetailRows(undefined)).toEqual([]);
  });
});

const invoiceData = (bankDetails: Partial<typeof FULL>): InvoicePdfData => ({
  number: "INV-7300", date: "07/03/2026", billTo: ["Example Customer Ltd"], lineItems: [{ description: "Bush", quantity: 2, unitPrice: 50, vatPct: 20 }],
  vatEnabled: true, payments: 0, company: { ...company, bankDetails: { ...EMPTY_BANK_DETAILS, ...bankDetails } },
  storedTotals: { reference: "INV-7300", issued: true, subtotal: 100, vat: 20, total: 120 },
});
const render = async (element: Parameters<typeof renderToBuffer>[0]) => pdfText(await renderToBuffer(element));
const invoiceText = (bankDetails: Partial<typeof FULL>) => render(createElement(InvoicePDF, { data: invoiceData(bankDetails) }) as Parameters<typeof renderToBuffer>[0]);

describe("invoice PDF", () => {
  it("prints a Payment details block with every filled field", async () => {
    const text = await invoiceText(FULL);
    for (const piece of ["Payment details", "Account name", "J N R Engineering Ltd", "Bank", "Example Bank", "Sort code", "12-34-56", "Account number", "12345678", "IBAN", "GB00EXAM12345612345678", "BIC", "EXAMGB2L"]) {
      expect(text).toContain(piece);
    }
  });

  it("with all six fields and a second VAT rate, the invoice still fits on one page", async () => {
    const data = invoiceData(FULL);
    data.lineItems = [...data.lineItems, { description: "Pin", quantity: 1, unitPrice: 10, vatPct: 5 }];
    data.storedTotals = { reference: "INV-7300", issued: true, subtotal: 110, vat: 20.5, total: 130.5 };
    const pdf = await renderToBuffer(createElement(InvoicePDF, { data }) as Parameters<typeof renderToBuffer>[0]);
    expect(pdf.toString("latin1").match(/\/Type \/Page\b(?!s)/g)).toHaveLength(1);
  });

  it("prints only the filled fields", async () => {
    const text = await invoiceText({ sortCode: "12-34-56", accountNumber: "12345678" });
    expect(text).toContain("Payment details");
    expect(text).toContain("12-34-56");
    for (const absent of ["Account name", "IBAN", "BIC", "Example Bank"]) expect(text).not.toContain(absent);
  });

  it("prints nothing, and is identical to an invoice from before bank details, when all are empty", async () => {
    const empty = await invoiceText({});
    expect(empty).not.toContain("Payment details");
    expect(empty).toContain("Customer Message");
    const { bankDetails: _omitted, ...withoutBank } = invoiceData({}).company!;
    void _omitted;
    expect(await render(createElement(InvoicePDF, { data: { ...invoiceData({}), company: { ...withoutBank } as typeof company } }) as Parameters<typeof renderToBuffer>[0])).toBe(empty);
  });
});

describe("quotes never print bank details", () => {
  it("a quote from a company that has bank details has no Payment details block and none of the values", async () => {
    const quote: QuotePdfData = {
      number: "QUO-7300", date: "07/03/2026", terms: "Valid for 7 days", validUntil: "14/03/2026", billTo: ["Example Customer Ltd"],
      lineItems: [{ description: "Bush", quantity: 2, unitPrice: 50, vatPct: 20 }], vatEnabled: true, company: { ...company, bankDetails: FULL },
      storedTotals: { reference: "QUO-7300", issued: true, total: 120 },
    };
    const text = await render(createElement(QuotePDF, { data: quote }) as Parameters<typeof renderToBuffer>[0]);
    expect(text).toContain("QUOTE");
    for (const absent of ["Payment details", "12-34-56", "12345678", "Example Bank", "GB00EXAM", "EXAMGB2L"]) expect(text).not.toContain(absent);
  });
});

describe("issued invoices", () => {
  it("print the bank details set today: the issuer snapshot does not carry them", () => {
    const today = { ...JNR_PROFILE, bankDetails: FULL };
    expect(issuedCompany(today, { documentName: "Alpha Ltd", defaultInvoiceMessage: ["Then"], bankDetails: { sortCode: "99-99-99" } }).bankDetails).toEqual(FULL);
    expect(issuedCompany(today, { documentName: "Alpha Ltd" }).bankDetails).toEqual(FULL);
  });
});
