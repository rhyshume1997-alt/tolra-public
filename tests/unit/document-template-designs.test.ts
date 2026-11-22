/**
 * Module J: every design prints the same words and figures. For each document type, each design's text must contain every amount, VAT line,
 * total, bank detail, payment wording, document number and message that the classic design prints; the brand colour and logo fallback
 * follow the company; a document whose lines do not add up to its stored totals is refused by every design.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { DeliveryNotePDF } from "@/components/pdf/DeliveryNotePDF";
import { InvoicePDF } from "@/components/pdf/InvoicePDF";
import { PurchaseOrderPDF } from "@/components/pdf/PurchaseOrderPDF";
import { QuotePDF } from "@/components/pdf/QuotePDF";
import { brandColour, FALLBACK_BRAND, inkOn } from "@/components/pdf/templates/document-model";
import { designFor, DOCUMENT_DESIGNS } from "@/components/pdf/templates/registry";
import { issuedCompany } from "@/lib/document-snapshot";
import { withTemplatesEnabled, setDesignChoice } from "@/lib/document-templates/document-template-settings";
import { sampleDocument } from "@/lib/document-templates/sample-documents";
import { FIXTURE_COMPANY, FIXTURE_DELIVERY_NOTE, FIXTURE_INVOICE, FIXTURE_INVOICE_PAID, FIXTURE_PURCHASE_ORDER, FIXTURE_QUOTE } from "../support/document-template-fixtures";
import { pdfText } from "../support/pdf-text";

type Maker = (design: string | undefined) => unknown;
const CASES: Array<{ name: string; make: Maker }> = [
  { name: "quote", make: (design) => createElement(QuotePDF, { data: { ...FIXTURE_QUOTE, design } }) },
  { name: "invoice", make: (design) => createElement(InvoicePDF, { data: { ...FIXTURE_INVOICE, design } }) },
  { name: "invoice-paid", make: (design) => createElement(InvoicePDF, { data: { ...FIXTURE_INVOICE_PAID, design } }) },
  { name: "purchase-order", make: (design) => createElement(PurchaseOrderPDF, { data: { ...FIXTURE_PURCHASE_ORDER, design } }) },
  { name: "delivery-note", make: (design) => createElement(DeliveryNotePDF, { data: { ...FIXTURE_DELIVERY_NOTE, design } }) },
];
const text = async (make: Maker, design: string | undefined) => pdfText(await renderToBuffer(make(design) as never));
/** Word-wrapped text is split across drawing operations, so compare without whitespace. */
const squash = (value: string) => value.replace(/\s+/g, "").toLowerCase();
/** The money amounts, labels and numbers a design must print: every line of the classic text that has a digit, a colon label or a currency sign. */
const tokens = (classic: string) => classic.split("\n").map((l) => l.trim()).filter((l) => /[\d£]/.test(l) || /:$/.test(l));

describe("registry", () => {
  it("lists classic first, with unique lower-case ids, and falls back to classic", () => {
    expect(DOCUMENT_DESIGNS[0].id).toBe("classic");
    expect(DOCUMENT_DESIGNS.length).toBeGreaterThanOrEqual(3);
    const ids = DOCUMENT_DESIGNS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(designFor("gone").id).toBe("classic");
    expect(designFor(undefined).id).toBe("classic");
  });
});

describe.each(CASES)("$name", ({ make }) => {
  it.each(DOCUMENT_DESIGNS.map((d) => d.id))("%s design prints the same figures, labels, bank details and numbers as classic", async (design) => {
    const classic = await text(make, "classic");
    const other = squash(await text(make, design));
    for (const token of tokens(classic)) expect(other, `missing "${token}"`).toContain(squash(token));
  });
});

describe("what comes out is the company's", () => {
  it("every design shows the bank details and payment wording on an invoice, and none on a quote", async () => {
    for (const { id } of DOCUMENT_DESIGNS) {
      const invoice = squash(await text(CASES[1].make, id));
      for (const part of ["Paymentdetails", "12-34-56", "12345678", "ExampleBank", "Balancedue", "Invoicetotal", "Paid:"]) expect(invoice).toContain(part.toLowerCase());
      const quote = squash(await text(CASES[0].make, id));
      expect(quote).not.toContain("12-34-56");
    }
  });
  it("with no logo every design prints the company name instead", async () => {
    for (const { id } of DOCUMENT_DESIGNS.slice(1)) expect(squash(await text(CASES[0].make, id))).toContain(squash(FIXTURE_COMPANY.name));
  });
  it("brand colour: the company's, else a neutral fallback; ink is readable on it", () => {
    expect(brandColour({ brandPrimary: "#7A1F3D" })).toBe("#7a1f3d");
    expect(brandColour({ brandPrimary: "" })).toBe(FALLBACK_BRAND);
    expect(brandColour({ brandPrimary: "red" })).toBe(FALLBACK_BRAND);
    expect(inkOn("#ffffff")).toBe("#000000");
    expect(inkOn("#1e3472")).toBe("#ffffff");
  });
  it("a document whose lines do not add up to its stored totals is refused by every design", async () => {
    for (const { id } of DOCUMENT_DESIGNS) {
      const data = { ...FIXTURE_QUOTE, design: id, storedTotals: { reference: "QUO-0042", issued: true, total: 1 } };
      await expect(renderToBuffer(createElement(QuotePDF, { data }) as never)).rejects.toThrow();
    }
  });
});

describe("choosing a design", () => {
  const settings = withTemplatesEnabled(setDesignChoice(null, "quote", "modern", new Date("2026-12-01T00:00:00Z")), true);
  const company = { ...FIXTURE_COMPANY, documentTemplates: settings };
  it("an issued document keeps its design; a new one gets the chosen design; other types are untouched", async () => {
    const issuedBefore = await text(() => createElement(QuotePDF, { data: { ...FIXTURE_QUOTE, company, issuedAt: "2026-11-30" } }), undefined);
    const classic = await text(CASES[0].make, "classic");
    expect(issuedBefore).toBe(classic);
    const issuedAfter = await text(() => createElement(QuotePDF, { data: { ...FIXTURE_QUOTE, company, issuedAt: "2026-12-02" } }), undefined);
    const modern = await text(CASES[0].make, "modern");
    expect(issuedAfter).toBe(modern);
    expect(issuedAfter).not.toBe(classic);
    const invoice = await text(() => createElement(InvoicePDF, { data: { ...FIXTURE_INVOICE, company } }), undefined);
    expect(invoice).toBe(await text(CASES[1].make, "classic"));
  });
  it("the preview sample data is invented and carries the design asked for", () => {
    for (const type of ["quote", "invoice", "purchase_order", "delivery_note"] as const) {
      const sample = sampleDocument(type, FIXTURE_COMPANY, "minimal");
      expect(sample.data.design).toBe("minimal");
      expect(JSON.stringify(sample.data)).toContain("Sample");
    }
  });
  it("a quote or invoice takes its date from the issuer snapshot: an old snapshot keeps classic, a newer one gets the choice, a draft gets the current design", async () => {
    const quoteWith = async (capturedAt: string | undefined) => pdfText(await renderToBuffer(createElement(QuotePDF, { data: { ...FIXTURE_QUOTE, company: issuedCompany(company, capturedAt ? { name: company.name, capturedAt } : undefined) } }) as never));
    const classic = await text(CASES[0].make, "classic");
    const modern = await text(CASES[0].make, "modern");
    expect(await quoteWith("2026-11-20T10:00:00Z")).toBe(classic);
    expect(await quoteWith("2026-12-05T10:00:00Z")).toBe(modern);
    expect(await quoteWith(undefined)).toBe(modern); // no snapshot and not marked issued: a draft
  });
  it("an issued quote with no recorded date (imported, or before snapshots) never changes", async () => {
    const { resolvePdfTotals } = await import("@/components/pdf/pdf-totals");
    const t = resolvePdfTotals({ lineItems: FIXTURE_QUOTE.lineItems, carriage: FIXTURE_QUOTE.carriage, carriageVat: FIXTURE_QUOTE.carriageVat, showVat: true }, company).totals;
    const storedTotals = { reference: "QUO-0042", issued: true, subtotal: t.subtotal, vat: t.vat, total: t.total };
    const out = await text(() => createElement(QuotePDF, { data: { ...FIXTURE_QUOTE, company, storedTotals } }), undefined);
    expect(out).toBe(await text(CASES[0].make, "classic"));
  });
});
