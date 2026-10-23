import { describe, expect, it } from "vitest";

import { documentTotals, fromPence, toPence, vatRowLabel } from "@/lib/money";
import { companyVat, fromVatChoice, toVatChoice, vatColumnText } from "@/lib/vat";
import { computePdfTotals } from "@/components/pdf/BaseDocumentPDF";
import { JNR_TEST_INVOICES } from "@/lib/jnr-test-data";
import { SAMPLE_INVOICE_0101_LINES, SAMPLE_INVOICE_0102_LINES } from "../fixtures/original-documents";

describe("money", () => {
  it("rounds to integer pence", () => {
    expect(toPence(1.239)).toBe(124);
    expect(toPence(-2.5)).toBe(-250);
    expect(fromPence(250)).toBe(2.5);
  });

  // Golden totals for two invented documents. INV-0101 is the per-line rounding case: 20% of the subtotal would be
  // 723.54, but VAT rounded to the penny on each line and then summed is 723.55. INV-0102 comes out the same both ways.
  it.each([
    ["INV-0102", SAMPLE_INVOICE_0102_LINES, 1989.82, 397.96, 2387.78],
    ["INV-0101", SAMPLE_INVOICE_0101_LINES, 3617.71, 723.55, 4341.26],
  ])("%s: totals match the pinned golden values", (_ref, lines, subtotal, vat, total) => {
    const totals = documentTotals(lines);
    expect(totals.subtotal).toBe(subtotal);
    expect(totals.vat).toBe(vat);
    expect(totals.total).toBe(total);
  });

  it.each(JNR_TEST_INVOICES.map((inv) => [inv.ref, inv] as const))("demo %s states the totals the app computes", (_ref, invoice) => {
    expect(documentTotals(invoice.lines)).toMatchObject({ subtotal: invoice.subtotal, vat: invoice.vat, total: invoice.total });
  });

  it("adds carriage without VAT by default (documents issued before the VAT options)", () => {
    const totals = documentTotals([{ quantity: 1, unitPrice: 100 }], 10);
    expect(totals).toMatchObject({ subtotal: 100, carriage: 10, vat: 20, total: 130 });
  });

  it("charges VAT on carriage at the standard rate when asked", () => {
    const totals = documentTotals([{ quantity: 1, unitPrice: 100 }], 10, { carriageVat: true });
    expect(totals).toMatchObject({ subtotal: 100, carriage: 10, vat: 22, total: 132 });
    expect(totals.vatBreakdown).toEqual([{ rate: 20, exempt: false, net: 110, vat: 22 }]);
  });

  it("fixes the earlier carriage example: £1,025.50 + £25 carriage at 20%", () => {
    const lines = [{ quantity: 2, unitPrice: 470, vatPct: 20 }, { quantity: 1, unitPrice: 85.5, vatPct: 20 }];
    expect(documentTotals(lines, 25)).toMatchObject({ vat: 205.1, total: 1255.6 });
    expect(documentTotals(lines, 25, { carriageVat: true })).toMatchObject({ subtotal: 1025.5, carriage: 25, vat: 210.1, total: 1260.6 });
  });

  it("taxes each line at its own rate", () => {
    const totals = documentTotals([
      { quantity: 1, unitPrice: 100, vatPct: 20 },
      { quantity: 2, unitPrice: 50, vatPct: 5 },
      { quantity: 1, unitPrice: 40, vatPct: 0 },
    ]);
    expect(totals).toMatchObject({ subtotal: 240, vat: 25, total: 265 });
    expect(totals.vatBreakdown).toEqual([
      { rate: 20, exempt: false, net: 100, vat: 20 },
      { rate: 5, exempt: false, net: 100, vat: 5 },
      { rate: 0, exempt: false, net: 40, vat: 0 },
    ]);
  });

  it("keeps exempt lines out of VAT and lists them last", () => {
    const totals = documentTotals([{ quantity: 1, unitPrice: 100, vatPct: 20 }, { quantity: 1, unitPrice: 30, vatExempt: true, vatPct: 20 }]);
    expect(totals).toMatchObject({ subtotal: 130, vat: 20, total: 150 });
    expect(totals.vatBreakdown.at(-1)).toEqual({ rate: 0, exempt: true, net: 30, vat: 0 });
    expect(vatRowLabel(totals.vatBreakdown[0])).toBe("VAT 20%");
    expect(vatRowLabel(totals.vatBreakdown[1])).toBe("Exempt");
  });

  it("charges no VAT at all when the document's VAT is off (carriage included)", () => {
    const totals = documentTotals([{ quantity: 3, unitPrice: 33.33, vatPct: 20 }], 15, { vatEnabled: false, carriageVat: true });
    expect(totals).toEqual({ subtotal: 99.99, carriage: 15, vat: 0, total: 114.99, vatBreakdown: [] });
  });

  it("uses the company's standard rate for lines without one, and for carriage", () => {
    const totals = documentTotals([{ quantity: 1, unitPrice: 200 }], 20, { standardRate: 5, carriageVat: true });
    expect(totals).toMatchObject({ vat: 11, total: 231 });
  });

  it("rounds VAT per line to the penny, then sums (2 dp throughout)", () => {
    // 0.333 * 3 = 0.999 -> £1.00 net; 20% = 0.20. 2 x 0.125 = 0.25 net; 5% = 0.0125 -> £0.01.
    const totals = documentTotals([{ quantity: 3, unitPrice: 0.333, vatPct: 20 }, { quantity: 2, unitPrice: 0.125, vatPct: 5 }]);
    expect(totals).toMatchObject({ subtotal: 1.25, vat: 0.21, total: 1.46 });
    // Three lines whose VAT each rounds up: per-line rounding gives 3 x 0.01, not round(0.0375 + ...).
    const tiny = documentTotals([0.05, 0.05, 0.05].map((unitPrice) => ({ quantity: 1, unitPrice, vatPct: 20 })));
    expect(tiny.vat).toBe(0.03);
    for (const value of [tiny.subtotal, tiny.vat, tiny.total]) expect(Math.round(value * 100) / 100).toBe(value);
  });

  it("still accepts the old numeric default-rate argument", () => {
    expect(documentTotals([{ quantity: 1, unitPrice: 100 }], 0, 5)).toMatchObject({ vat: 5, total: 105 });
  });

  it("PDF totals follow the document's switch, carriage flag and rates", () => {
    const lineItems = [{ description: "A", quantity: 1, unitPrice: 100, vatPct: 20 }, { description: "B", quantity: 1, unitPrice: 100, vatPct: 5 }];
    expect(computePdfTotals({ lineItems, carriage: 10, carriageVat: true })).toMatchObject({ vat: 27, total: 237 });
    expect(computePdfTotals({ lineItems, carriage: 10, showVat: false })).toMatchObject({ vat: 0, total: 210, vatBreakdown: [] });
    expect(computePdfTotals({ lineItems, carriage: 10, payments: 50 })).toMatchObject({ vat: 25, total: 235, balance: 185 });
  });
});

describe("vat choices", () => {
  it("maps line choices to stored fields and back", () => {
    expect(fromVatChoice("exempt")).toEqual({ vatPct: 0, vatExempt: true });
    expect(fromVatChoice("5")).toEqual({ vatPct: 5, vatExempt: false });
    expect(toVatChoice(20, false)).toBe("20");
    expect(toVatChoice(0, true)).toBe("exempt");
    expect(toVatChoice(17.5, false, "20")).toBe("20");
    expect(vatColumnText(5, false)).toBe("5");
    expect(vatColumnText(undefined, true)).toBe("Exempt");
  });

  it("defaults to VAT registered at 20%, and off when the company says so", () => {
    expect(companyVat(null)).toEqual({ registered: true, standardRate: 20, defaultChoice: "20" });
    expect(companyVat({ vatRegistered: false, defaultVatRate: 20 }).registered).toBe(false);
    expect(companyVat({ vatRegistered: true, defaultVatRate: 5 })).toEqual({ registered: true, standardRate: 5, defaultChoice: "5" });
  });
});
