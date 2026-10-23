import { describe, expect, it } from "vitest";

import { decimalPlaces, documentTotals, linePence, toPence } from "@/lib/money";
import { invoiceSaveSchema, quoteSaveSchema } from "@/lib/validation/schemas";

describe("exact decimal money (audit D12)", () => {
  it("rounds the exact product half away from zero, not the float product", () => {
    expect(linePence(0.02, 7.25)).toBe(15); // 0.145 -> 15p (a float product gives 14p)
    expect(linePence(0.5, 2.01)).toBe(101); // 1.005 -> £1.01
    expect(linePence(3, 0.33)).toBe(99);
    expect(linePence(1.333, 3)).toBe(400); // 3.999 -> £4.00
    expect(linePence(2, 150)).toBe(30000);
    expect(linePence(0.001, 0.01)).toBe(0); // 0.00001
    expect(linePence(1, 0.005)).toBe(1);
  });

  it("converts pounds to pence exactly, including negatives and large values", () => {
    expect(toPence(1.005)).toBe(101);
    expect(toPence(-1.005)).toBe(-101);
    expect(toPence(1.239)).toBe(124);
    expect(toPence(9999999.99)).toBe(999999999);
    expect(toPence(0)).toBe(0);
    expect(toPence(1e-7)).toBe(0);
  });

  it("charges VAT per line on the exact net, including fractional rates", () => {
    expect(documentTotals([{ quantity: 0.02, unitPrice: 7.25, vatPct: 20 }])).toMatchObject({ subtotal: 0.15, vat: 0.03, total: 0.18 });
    expect(documentTotals([{ quantity: 1, unitPrice: 10.1, vatPct: 17.5 }])).toMatchObject({ vat: 1.77 }); // 1.7675
    expect(documentTotals([{ quantity: 1, unitPrice: 0.1, vatPct: 5 }])).toMatchObject({ vat: 0.01 }); // 0.005
  });

  it("counts decimal places as written", () => {
    expect(decimalPlaces(0.125)).toBe(3);
    expect(decimalPlaces(1.5)).toBe(1);
    expect(decimalPlaces(2)).toBe(0);
    expect(decimalPlaces(1e-7)).toBe(7);
    expect(decimalPlaces(100)).toBe(0);
  });
});

describe("supported scales (audit D13): rejected, never silently rounded", () => {
  const quote = (line: { description: string; quantity: number; unitPrice: number }) =>
    quoteSaveSchema.safeParse({ customer: "C", description: "", customerNotes: "", internalNotes: "", terms: "", validUntil: "", lines: [line] });

  it("accepts pounds and pence and quantities to a thousandth", () => {
    expect(quote({ description: "Part", quantity: 2.125, unitPrice: 150.5 }).success).toBe(true);
    expect(quote({ description: "Part", quantity: 1, unitPrice: 0 }).success).toBe(true); // zero-priced draft line
  });

  it("refuses finer prices and quantities with a clear message", () => {
    const price = quote({ description: "Part", quantity: 1, unitPrice: 0.125 });
    expect(price.success).toBe(false);
    expect(price.error?.issues[0].message).toMatch(/pounds and pence/);
    const qty = quote({ description: "Part", quantity: 1.2345, unitPrice: 1 });
    expect(qty.success).toBe(false);
    expect(qty.error?.issues[0].message).toMatch(/3 decimal places/);
  });

  it("refuses a priced line without a description", () => {
    expect(quote({ description: " ", quantity: 1, unitPrice: 10 }).error?.issues[0].message).toBe("Every line needs a description");
  });

  it("refuses carriage with more than pence", () => {
    const parsed = invoiceSaveSchema.safeParse({ customer: "C", invoiceDate: "2026-10-09", dueDate: "2026-11-08", terms: "", quoteRef: "", customerPo: "", carriage: 1.005, lines: [{ description: "Part", quantity: 1, unitPrice: 1 }] });
    expect(parsed.error?.issues[0].message).toMatch(/Carriage is in pounds and pence/);
  });
});
