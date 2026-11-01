import { describe, expect, it } from "vitest";

import { paymentFromRow } from "@/lib/payments";
import { invoicePaidFigures, paymentExportRows, paymentsCsv, summaryCsv } from "@/lib/year-end-export";

describe("year-end summary.csv", () => {
  it("has the agreed columns, ISO dates, two decimals, quoting and a BOM for Excel", () => {
    const csv = summaryCsv([{ type: "Invoice", number: "INV-0001", date: "2025-03-04", party: 'Smith, "Quoted" Ltd', net: 100, vat: 20, gross: 120, paid: 120, balance: 0, paidDate: "2025-04-01", status: "paid", pdf: "invoices/INV-0001.pdf" }]);
    expect(csv.startsWith("﻿Type,Number,Date,Customer / supplier,Net,VAT,Gross,Paid,Balance due,Paid date,Status,PDF\r\n")).toBe(true);
    expect(csv).toContain('Invoice,INV-0001,2025-03-04,"Smith, ""Quoted"" Ltd",100.00,20.00,120.00,120.00,0.00,2025-04-01,paid,invoices/INV-0001.pdf\r\n');
  });

  it("leaves paid and balance blank for other documents and for an unknown payment", () => {
    const csv = summaryCsv([
      { type: "Quote", number: "QUO-1", date: "2025-03-04", party: "A", net: 10, vat: 2, gross: 12, paidDate: "", status: "sent", pdf: "" },
      { type: "Invoice", number: "INV-2", date: "2025-03-04", party: "B", net: 10, vat: 2, gross: 12, paid: null, balance: null, paidDate: "", status: "issued", pdf: "" },
    ]);
    expect(csv).toContain("Quote,QUO-1,2025-03-04,A,10.00,2.00,12.00,,,,sent,\r\n");
    expect(csv).toContain("Invoice,INV-2,2025-03-04,B,10.00,2.00,12.00,,,,issued,\r\n");
  });
});

describe("year-end paid and balance (migration 032)", () => {
  it("uses amount_paid, the sum of the real payments", () => {
    expect(invoicePaidFigures({ invoice_ref: "INV-1", status: "partial", total: 120, amount_paid: 50 })).toEqual({ paid: 50, balance: 70, problem: null });
    expect(invoicePaidFigures({ invoice_ref: "INV-2", status: "paid", total: 120, amount_paid: 120 })).toEqual({ paid: 120, balance: 0, problem: null });
    expect(invoicePaidFigures({ invoice_ref: "INV-3", status: "issued", total: 120, amount_paid: 0 })).toEqual({ paid: 0, balance: 120, problem: null });
    expect(invoicePaidFigures({ invoice_ref: "INV-4", status: "cancelled", total: 120, amount_paid: 0 })).toEqual({ paid: 0, balance: 0, problem: null });
  });

  it("never guesses: an unverified invoice, or one marked paid with no amount held, is blank with a problems.txt line", () => {
    const unverified = invoicePaidFigures({ invoice_ref: "INV-5", status: "sent", total: 120, amount_paid: 0, payment_unverified: true });
    expect(unverified).toMatchObject({ paid: null, balance: null });
    expect(unverified.problem).toContain("Invoice INV-5: payment to confirm");
    expect(unverified.problem).toContain("still to be confirmed");
    const paidNoAmount = invoicePaidFigures({ invoice_ref: "INV-6", status: "paid", total: 120, amount_paid: 0 });
    expect(paidNoAmount).toMatchObject({ paid: null, balance: null });
    expect(paidNoAmount.problem).toContain("no payment amount was ever recorded");
  });
});

describe("year-end payments.csv", () => {
  const row = (over: Record<string, unknown>) => paymentFromRow({ invoice_id: "i1", source: "recorded", created_at: "2025-04-01T10:00:00Z", ...over });
  const invoices = [{ id: "i1", invoice_ref: "INV-0001" }, { id: "i2", invoice_ref: "INV-0002" }];

  it("lists payments with source and reversed, oldest first, only for the exported invoices", () => {
    const payments = [
      row({ id: "p2", amount: -40, paid_on: "2025-05-10", method: "cheque", reference: "CHQ 7", reverses_payment_id: "p1", void_reason: "cheque bounced", created_at: "2025-05-10T09:00:00Z" }),
      row({ id: "p1", amount: 40, paid_on: "2025-04-01", method: "cheque", reference: "CHQ 7" }),
      row({ id: "p3", invoice_id: "i2", amount: 80, paid_on: "2025-04-02", method: "BACS", reference: 'Ref, "A"' }),
      row({ id: "p4", invoice_id: "i2", amount: 25, source: "legacy", paid_on: null }),
      row({ id: "p9", invoice_id: "other", amount: 999, paid_on: "2025-04-02" }),
    ];
    const rows = paymentExportRows(invoices, payments);
    expect(rows.map((r) => [r.invoice, r.amount, r.reversed])).toEqual([
      ["INV-0001", 40, "Yes"],
      ["INV-0001", -40, "Reversal: cheque bounced"],
      ["INV-0002", 80, "No"],
      ["INV-0002", 25, "No"],
    ]);
    const csv = paymentsCsv(rows);
    expect(csv.startsWith("﻿Invoice,Paid on,Amount,Method,Reference,Source,Reversed\r\n")).toBe(true);
    expect(csv).toContain("INV-0001,2025-04-01,40.00,cheque,CHQ 7,recorded,Yes\r\n");
    expect(csv).toContain("INV-0001,2025-05-10,-40.00,cheque,CHQ 7,recorded,Reversal: cheque bounced\r\n");
    expect(csv).toContain('INV-0002,2025-04-02,80.00,BACS,"Ref, ""A""",recorded,No\r\n');
    expect(csv).toContain("INV-0002,,25.00,,,legacy,No\r\n");
  });

  it("is just the header when nothing was paid", () => {
    expect(paymentsCsv([])).toBe("﻿Invoice,Paid on,Amount,Method,Reference,Source,Reversed\r\n");
  });
});
