import { describe, expect, it } from "vitest";

import { defaultInvoiceMessage, invoiceMessage, parseCompanyProfile } from "@/lib/company";
import { issuedCompany } from "@/lib/document-snapshot";
import { knownPaid, netPaid, paidState, paymentAmountProblem, paymentDateProblem, paymentFromRow, paymentsEmptyText, reversedIds } from "@/lib/payments";
import { balanceDue, invoiceLifecycle, isPartPaid, owed } from "@/lib/receivables";
import { JNR_PROFILE } from "@/lib/company";

describe("part payments: balance and status (migration 032)", () => {
  it("works out where an invoice stands, in whole pence", () => {
    expect(paidState(120, 0)).toBe("unpaid");
    expect(paidState(120, 50)).toBe("partial");
    expect(paidState(120, 119.99)).toBe("partial");
    expect(paidState(120, 120)).toBe("paid");
    expect(paidState(0.3, 0.1 + 0.2)).toBe("paid"); // 0.30000000000000004
  });

  it("a part paid invoice is open and collectible for the remaining balance", () => {
    expect(invoiceLifecycle("partial")).toBe("collectible");
    expect(owed({ status: "partial", total: 120, amount_paid: 50 })).toBe(70);
    expect(isPartPaid({ status: "partial", total: 120, amount_paid: 50 })).toBe(true);
    expect(isPartPaid({ status: "sent", total: 120, amount_paid: 50 })).toBe(true); // older statuses with receipts
    expect(isPartPaid({ status: "issued", total: 120, amount_paid: 0 })).toBe(false);
    expect(isPartPaid({ status: "paid", total: 120, amount_paid: 120 })).toBe(false);
    expect(isPartPaid({ status: "cancelled", total: 120, amount_paid: 50 })).toBe(false);
    expect(balanceDue(120, 50)).toBe(70);
  });

  it("an imported invoice with its payment still to confirm is not owed, even when part paid", () => {
    expect(owed({ status: "partial", total: 120, amount_paid: 50, payment_unverified: true })).toBe(0);
  });

  it("sums payments net of reversals", () => {
    const payments = [{ amount: 40 }, { amount: 80.1 }, { amount: -40 }];
    expect(netPaid(payments)).toBe(80.1);
    expect(netPaid([])).toBe(0);
    expect(reversedIds([{ reversesPaymentId: null }, { reversesPaymentId: "p1" }])).toEqual(new Set(["p1"]));
  });

  it("refuses the same amounts the server does", () => {
    expect(paymentAmountProblem(0, 100)).toMatch(/more than zero/);
    expect(paymentAmountProblem(-5, 100)).toMatch(/more than zero/);
    expect(paymentAmountProblem(Number.NaN, 100)).toMatch(/more than zero/);
    expect(paymentAmountProblem(10.005, 100)).toMatch(/pence/);
    expect(paymentAmountProblem(100.01, 100)).toBe("That is more than the balance due (£100.00).");
    expect(paymentAmountProblem(100, 100)).toBeNull();
    expect(paymentAmountProblem(0.01, 100)).toBeNull();
  });

  it("a payment can't be dated in the future", () => {
    expect(paymentDateProblem("2026-10-11", "2026-10-11")).toBeNull();
    expect(paymentDateProblem("2026-10-12", "2026-10-11")).toMatch(/future/);
    expect(paymentDateProblem("", "2026-10-11")).toMatch(/date/);
  });

  it("maps an API row, with a legacy row's empty date", () => {
    expect(paymentFromRow({ id: "p", invoice_id: "i", amount: "12.50", paid_on: null, source: "legacy", created_at: "2026-01-01T00:00:00Z" })).toMatchObject({ amount: 12.5, paidOn: "", source: "legacy", reversesPaymentId: null });
  });

  it("knows when a paid amount is not known (never guessed)", () => {
    expect(knownPaid({ status: "partial", amount_paid: 50 })).toBe(50);
    expect(knownPaid({ status: "issued", amount_paid: 0 })).toBe(0);
    expect(knownPaid({ status: "paid", amount_paid: 120 })).toBe(120);
    expect(knownPaid({ status: "paid", amount_paid: 0 })).toBeNull();
    expect(knownPaid({ status: "sent", amount_paid: 0, payment_unverified: true })).toBeNull();
  });
});

describe("invoice message (issue #3)", () => {
  it("invoices use their own message, falling back to neutral wording; quotes keep theirs", () => {
    const company = parseCompanyProfile({ documentName: "Alpha Ltd", addressLines: ["Unit 1"], vatRegistered: false, defaultCustomerMessage: ["Quotations are valid for 7 days."] });
    expect(company?.defaultCustomerMessage).toEqual(["Quotations are valid for 7 days."]);
    expect(company?.defaultInvoiceMessage).toEqual([]);
    expect(invoiceMessage(company!)).toEqual(defaultInvoiceMessage("30 days"));
    const withMessage = parseCompanyProfile({ documentName: "Alpha Ltd", addressLines: ["Unit 1"], vatRegistered: false, defaultInvoiceMessage: ["Payment due in 30 days.", "", "Quote the invoice number."] });
    expect(invoiceMessage(withMessage!)).toEqual(["Payment due in 30 days.", "Quote the invoice number."]);
  });

  it("an issued invoice keeps what it was issued with", () => {
    const today = { ...JNR_PROFILE, defaultCustomerMessage: ["Quote wording now"], defaultInvoiceMessage: ["Invoice wording now"] };
    // Issued before invoices had their own message: printed the shared one, and still does.
    expect(invoiceMessage(issuedCompany(today, { documentName: "Alpha Ltd", defaultCustomerMessage: ["Shared wording then"] }))).toEqual(["Shared wording then"]);
    // Issued after: its own message at the time (here none was set: the default wording), whatever is set now.
    expect(invoiceMessage(issuedCompany(today, { documentName: "Alpha Ltd", defaultCustomerMessage: ["Quote wording then"], defaultInvoiceMessage: [] }))).toEqual(defaultInvoiceMessage("30 days"));
    expect(invoiceMessage(issuedCompany(today, { documentName: "Alpha Ltd", defaultInvoiceMessage: ["Invoice wording then"] }))).toEqual(["Invoice wording then"]);
    // No snapshot at all (a draft, or before 019): today's.
    expect(invoiceMessage(issuedCompany(today, null))).toEqual(["Invoice wording now"]);
  });
});

describe("the Payments section when there are no rows to list", () => {
  it("never says an invoice was marked paid without payments while the rows are still loading", () => {
    expect(paymentsEmptyText({ loaded: false, status: "paid", amountPaid: 360 })).toBe("Loading payments…");
    expect(paymentsEmptyText({ loaded: false, status: "paid", amountPaid: 0 })).toBe("Loading payments…");
  });
  it("says it only when loaded, paid and nothing is held as received", () => {
    expect(paymentsEmptyText({ loaded: true, status: "paid", amountPaid: 0 })).toContain("Marked paid before payments were recorded");
    expect(paymentsEmptyText({ loaded: true, status: "partial", amountPaid: 0 })).toBe("No payments recorded yet.");
  });
  it("does not call it legacy when money is held as received but no rows came back", () => {
    const text = paymentsEmptyText({ loaded: true, status: "paid", amountPaid: 360 });
    expect(text).not.toContain("Marked paid before");
    expect(text).toContain("could not be listed");
  });
});
