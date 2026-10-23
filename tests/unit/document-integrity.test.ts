/**
 * Reprints of imported documents (independent review of 0604bf4). An imported quote keeps its face value (£120) but
 * its single line, priced at total / quantity with VAT added, adds up to £144. Generated PDFs must never print a
 * total that wasn't issued: a document whose lines don't add up to its stored totals is refused, with the reason.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { storedTotalsProblem } from "@/components/pdf/BaseDocumentPDF";
import { InvoicePDF } from "@/components/pdf/InvoicePDF";
import { QuotePDF } from "@/components/pdf/QuotePDF";
import { JNR_PROFILE } from "@/lib/company";
import { DocumentTotalsMismatchError } from "@/lib/document-integrity";
import { pdfText } from "../support/pdf-text";

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
const importedQuote = {
  number: "QUO-7099",
  date: "07/03/2026",
  billTo: ["Legacy Example Ltd"],
  lineItems: [{ description: "Priceless line", quantity: 2, unitPrice: 60, vatPct: 20 }],
  vatEnabled: true,
  company,
};
const render = (element: unknown) => renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);

describe("imported quote reprint", () => {
  it("reproduction: rendered from its lines alone, a £120.00 quote prints a £144.00 total", async () => {
    const text = pdfText(await render(createElement(QuotePDF, { data: importedQuote })));
    expect(text).toMatch(/Total\s*:\s*£144\.00/);
  });

  it("with its stored total the PDF is refused, with the reason, and nothing is invented", async () => {
    const data = { ...importedQuote, storedTotals: { reference: "QUO-7099", issued: true, total: 120 } };
    const problem = storedTotalsProblem({ lineItems: data.lineItems, showVat: true, company, storedTotals: data.storedTotals });
    expect(problem).toBeInstanceOf(DocumentTotalsMismatchError);
    expect(problem?.message).toContain("stored total of £120.00");
    expect(problem?.message).toContain("add up to £144.00");
    expect(problem?.message).toContain("kept unchanged");
    // Rendering itself refuses too (the renderer wraps the error), so no path can produce the misleading PDF.
    await expect(render(createElement(QuotePDF, { data }))).rejects.toThrow();
  });

  it("a draft gets the correction hint instead", () => {
    const problem = storedTotalsProblem({ lineItems: importedQuote.lineItems, showVat: true, company, storedTotals: { reference: "QUO-7099", issued: false, total: 120 } });
    expect(problem?.message).toContain("Correct the lines so they match before issuing");
  });

  it("a quote whose lines match its stored total prints exactly that total", async () => {
    const data = { ...importedQuote, storedTotals: { reference: "QUO-7099", issued: true, total: 144 } };
    const text = pdfText(await render(createElement(QuotePDF, { data })));
    expect(text).toMatch(/Total\s*:\s*£144\.00/);
  });
});

describe("imported invoice reprint", () => {
  const invoice = {
    number: "INV-7099",
    date: "07/03/2026",
    billTo: ["Legacy Example Ltd"],
    lineItems: [{ description: "Machining", quantity: 3, unitPrice: 33.33, vatPct: 20 }],
    carriage: 10,
    vatEnabled: true,
    payments: 0,
    company,
  };

  it("lines that match subtotal, VAT and total print those amounts", async () => {
    const data = { ...invoice, storedTotals: { reference: "INV-7099", issued: true, subtotal: 99.99, vat: 20, total: 129.99 } };
    const text = pdfText(await render(createElement(InvoicePDF, { data })));
    expect(text).toContain("£129.99");
  });

  it("a stored VAT or subtotal that differs from the lines refuses the PDF (total alone isn't enough)", async () => {
    for (const stored of [{ subtotal: 99.99, vat: 0, total: 129.99 }, { subtotal: 109.99, vat: 20, total: 129.99 }, { subtotal: 99.99, vat: 20, total: 120 }]) {
      const data = { ...invoice, storedTotals: { reference: "INV-7099", issued: true, ...stored } };
      expect(storedTotalsProblem({ lineItems: data.lineItems, carriage: 10, showVat: true, company, storedTotals: data.storedTotals })).toBeInstanceOf(DocumentTotalsMismatchError);
      await expect(render(createElement(InvoicePDF, { data }))).rejects.toThrow();
    }
  });

  it("the paid watermark copy follows the same rule", async () => {
    const data = { ...invoice, paid: true, payments: 129.99, storedTotals: { reference: "INV-7099", issued: true, subtotal: 99.99, vat: 20, total: 150 } };
    await expect(render(createElement(InvoicePDF, { data }))).rejects.toThrow();
  });
});
