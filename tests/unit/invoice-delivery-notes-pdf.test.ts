/**
 * The "Delivery Notes" row of the invoice header. The key/value box is absolutely positioned with fixed 17.3pt rows and the
 * address blocks start below five of them, so a sixth row would print over "Bill To": the row is dropped when the box is full.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { InvoicePDF, type InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { JNR_PROFILE } from "@/lib/company";
import { pdfText } from "../support/pdf-text";

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
const base: InvoicePdfData = {
  number: "INV-7200",
  date: "07/03/2026",
  billTo: ["Example Customer Ltd"],
  lineItems: [{ description: "Machining", quantity: 3, unitPrice: 33.33, vatPct: 20 }],
  carriage: 10,
  vatEnabled: true,
  payments: 0,
  company,
  storedTotals: { reference: "INV-7200", issued: true, subtotal: 99.99, vat: 20, total: 129.99 },
};
const render = (data: InvoicePdfData) => renderToBuffer(createElement(InvoicePDF, { data }) as Parameters<typeof renderToBuffer>[0]);
const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

describe("InvoicePDF delivery notes row", () => {
  it("short case (Invoice No., Date, Terms): the row is printed, on one page", async () => {
    const pdf = await render({ ...base, deliveryNotes: "DLN-0001, DLN-0002 +3 more" });
    const out = pdfText(pdf);
    expect(out).toMatch(/Terms[\s\S]*Delivery Notes/);
    expect(out).toContain("DLN-0001, DLN-0002 +3 more");
    expect(pages(pdf)).toBe(1);
  });

  it("five rows already (Invoice No., Date, Terms, Our Quote No., Your Order No.): the row is dropped and the page is unchanged", async () => {
    const full = { ...base, quoteRef: "QUO-0042", customerPo: "PO-9" };
    const without = pdfText(await render(full));
    const pdf = await render({ ...full, deliveryNotes: "DLN-0001, DLN-0002" });
    const out = pdfText(pdf);
    expect(out).not.toMatch(/Delivery Notes/);
    expect(out).not.toContain("DLN-0001");
    expect(out).toBe(without);
    expect(pages(pdf)).toBe(1);
  });

  it("four rows (with a tax point): the fifth row still fits and is printed", async () => {
    const pdf = await render({ ...base, taxPoint: "03/03/2026", deliveryNotes: "DLN-0001" });
    expect(pdfText(pdf)).toMatch(/Terms[\s\S]*Delivery Notes/);
    expect(pages(pdf)).toBe(1);
  });

  it("an over-long value is cut to one line and the document stays one page", async () => {
    const pdf = await render({ ...base, deliveryNotes: "DLN-123456789012, DLN-123456789013 +12 more refs on this invoice" });
    expect(pages(pdf)).toBe(1);
    expect(pdfText(pdf)).not.toContain("on this invoice");
  });
});
