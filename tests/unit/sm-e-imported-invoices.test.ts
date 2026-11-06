/**
 * sm-e (3): how imported invoices (written by 076/085 as sent / partial / paid, amount_paid from the file's payments, payment_unverified when
 * "marked paid" came with no payments) read in the TS money rules: the invoice page's rule (lib/receivables) and the year-end summary
 * (lib/year-end-export invoicePaidFigures). Characterisation only; the SQL half is tests/db/sm-e-import-bypass.test.ts.
 */
import { describe, expect, it } from "vitest";

import { owed, invoiceLifecycle } from "@/lib/receivables";
import { invoicePaidFigures } from "@/lib/year-end-export";

const row = (o: Record<string, unknown>) => ({ invoice_ref: "INV-IMP-1", total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, payment_unverified: false, ...o });

describe("sm-e imported invoices in the money rules", () => {
  it("an unconfirmed import (marked paid, no payments) is owed nothing and exported blank with a problem line, never guessed", () => {
    const imported = row({ status: "sent", payment_unverified: true });
    expect(invoiceLifecycle("sent")).toBe("collectible");
    expect(owed(imported)).toBe(0);
    const f = invoicePaidFigures(imported);
    expect(f.paid).toBeNull();
    expect(f.balance).toBeNull();
    expect(f.problem).toMatch(/INV-IMP-1: payment to confirm \(imported without payment details and still to be confirmed\)/);
  });

  it("an imported unpaid invoice is owed in full; a part paid one owes the rest; both export exact figures with no problem", () => {
    expect(owed(row({ status: "sent" }))).toBe(120);
    expect(invoicePaidFigures(row({ status: "sent" }))).toEqual({ paid: 0, balance: 120, problem: null });
    expect(owed(row({ status: "partial", amount_paid: 50 }))).toBe(70);
    expect(invoicePaidFigures(row({ status: "partial", amount_paid: 50 }))).toEqual({ paid: 50, balance: 70, problem: null });
  });

  it("an imported paid invoice with payments exports balance 0; void and written-off ones export balance 0 and are owed nothing", () => {
    expect(invoicePaidFigures(row({ status: "paid", amount_paid: 120 }))).toEqual({ paid: 120, balance: 0, problem: null });
    for (const status of ["void", "cancelled", "written_off"]) {
      expect(owed(row({ status }))).toBe(0);
      expect(invoicePaidFigures(row({ status })).balance).toBe(0);
    }
  });

  it("a paid invoice whose payments were never recorded is blank with a problem (the other half of 'payment to confirm')", () => {
    const f = invoicePaidFigures(row({ status: "paid", amount_paid: 0 }));
    expect(f).toMatchObject({ paid: null, balance: null });
    expect(f.problem).toMatch(/marked paid but no payment amount was ever recorded/);
  });
});
