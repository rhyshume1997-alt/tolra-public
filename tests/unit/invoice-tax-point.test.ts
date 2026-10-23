/**
 * Invoice tax point (supply date). JNR's accountant has approved the current invoice layout, so it must not change: the
 * "Tax Point" line is printed only when a supply date is set AND differs from the invoice date. Otherwise the PDF is
 * exactly what it was before this field existed.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { InvoicePDF, type InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { JNR_PROFILE } from "@/lib/company";
import { pdfText } from "../support/pdf-text";

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
const base: InvoicePdfData = {
  number: "INV-7100",
  date: "07/03/2026",
  billTo: ["Example Customer Ltd"],
  lineItems: [{ description: "Machining", quantity: 3, unitPrice: 33.33, vatPct: 20 }],
  carriage: 10,
  vatEnabled: true,
  payments: 0,
  company,
  storedTotals: { reference: "INV-7100", issued: true, subtotal: 99.99, vat: 20, total: 129.99 },
};
const text = async (data: InvoicePdfData) => pdfText(await renderToBuffer(createElement(InvoicePDF, { data }) as Parameters<typeof renderToBuffer>[0]));

describe("InvoicePDF tax point", () => {
  it("no supply date: no Tax Point line, and the header block is Invoice No., Date, Terms as before", async () => {
    const out = await text(base);
    expect(out).not.toMatch(/Tax Point/i);
    expect(out).toMatch(/Invoice No\.[\s\S]*Date[\s\S]*Terms/);
    expect(out).toContain("07/03/2026");
  });

  it("a supply date equal to the invoice date prints nothing extra: identical to having none", async () => {
    const without = await text(base);
    const same = await text({ ...base, taxPoint: "07/03/2026" });
    expect(same).not.toMatch(/Tax Point/i);
    expect(same).toBe(without);
    // An empty value (a draft with the field cleared) is the same as none.
    expect(await text({ ...base, taxPoint: "" })).toBe(without);
  });

  it("a different supply date prints one Tax Point line, between Date and Terms, and nothing else changes", async () => {
    const without = await text(base);
    const out = await text({ ...base, taxPoint: "03/03/2026" });
    expect(out).toMatch(/Tax Point/);
    expect(out).toMatch(/Date[\s\S]*Tax Point[\s\S]*Terms/);
    expect(out).toContain("03/03/2026");
    expect(out.match(/Tax Point/g)).toHaveLength(1);
    // Everything else on the page is the same text, in the same order.
    expect(out.split("\n").filter((line) => !/Tax Point|03\/03\/2026/.test(line))).toEqual(without.split("\n"));
  });
});
