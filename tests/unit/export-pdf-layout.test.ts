/**
 * The record-export PDF (Quotes, Invoices, Job Board "Export PDF"): every export title is short and carries no company name (the
 * PDF already prints it top left), and the shared document layout keeps a long title off the company name and wraps table cells
 * inside their column instead of clipping them at the box edge.
 */
import { createElement } from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import {
  BaseDocumentPDF, COMPANY_NAME_WIDTH, companyNameLayout, companyNameLines, TITLE_MAX_FONT_SIZE, TITLE_WIDTH, columnStyle, printedTitle, styles, titleFontSize, type PdfDocumentData,
} from "@/components/pdf/BaseDocumentPDF";
import { CreditNotePDF } from "@/components/pdf/CreditNotePDF";
import { DeliveryNotePDF } from "@/components/pdf/DeliveryNotePDF";
import { InvoicePDF } from "@/components/pdf/InvoicePDF";
import { PurchaseOrderPDF } from "@/components/pdf/PurchaseOrderPDF";
import { QuotePDF } from "@/components/pdf/QuotePDF";
import { SalesOrderPDF } from "@/components/pdf/SalesOrderPDF";
import { JNR_PROFILE } from "@/lib/company";
import { EXPORT_TITLES } from "@/lib/export-records";
import { PRODUCT } from "@/lib/product";
import { pdfText } from "../support/pdf-text";

const ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("export titles", () => {
  const titles = Object.values(EXPORT_TITLES);

  it("are short and never contain the company or product name", () => {
    expect(titles.length).toBeGreaterThanOrEqual(3);
    const banned = [JNR_PROFILE.name, JNR_PROFILE.documentName, PRODUCT.name, "JNR", "J N R", "Engineering", "Ltd"].map((word) => word.toLowerCase());
    for (const title of titles) {
      expect(title.length).toBeLessThanOrEqual(24);
      for (const word of banned) expect(title.toLowerCase()).not.toContain(word);
    }
  });

  it("are the only titles any caller passes to exportRows", () => {
    const calls = [...sourceFiles(join(ROOT, "app")), ...sourceFiles(join(ROOT, "components"))]
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/exportRows\(\s*"(?:word|pdf|print)"\s*,\s*([^,]+),/g)].map((m) => m[1].trim()));
    expect(calls.length).toBeGreaterThanOrEqual(6); // Quotes, Invoices and Job Board, each as Word and PDF
    for (const arg of calls) expect(arg).toMatch(/^EXPORT_TITLES\.\w+$/);
  });
});

describe("shared document header and table layout", () => {
  it("gives the title and the company name their own one-line columns that cannot overlap", () => {
    const title = styles.title as Record<string, unknown>;
    const name = styles.companyName as Record<string, unknown>;
    expect(title.width).toBe(TITLE_WIDTH);
    expect(title.maxLines).toBe(1);
    expect(name.width).toBe(COMPANY_NAME_WIDTH);
    // Never cut: a legal name wraps or shrinks instead of ending in an ellipsis.
    expect(name.maxLines).toBeUndefined();
    expect(name.textOverflow).toBeUndefined();
    // Company column (from x=24) ends before the title column (from 571 - TITLE_WIDTH) begins.
    expect(24 + COMPANY_NAME_WIDTH).toBeLessThanOrEqual(571 - TITLE_WIDTH);
  });

  it("keeps today's company names exactly as they were (16pt, one line, top 46) and wraps or shrinks longer ones", () => {
    for (const name of [JNR_PROFILE.documentName, "J N R Engineering Ltd", "Acme", "Smith & Sons Engineering Ltd"]) {
      expect(companyNameLayout(name)).toEqual({ fontSize: 16, top: 46 });
      expect(companyNameLines(name)).toBe(1);
    }
    const forty5 = companyNameLayout("Wolverhampton Precision Engineering Limited");
    expect(forty5.fontSize).toBeLessThan(16);
    expect(forty5.fontSize).toBeGreaterThanOrEqual(13);
    for (const name of ["Wolverhampton & District Precision Engineering and Fabrication Holdings Ltd", "x ".repeat(60).trim()]) {
      const layout = companyNameLayout(name);
      expect(companyNameLines(name)).toBe(2);
      expect(layout.fontSize).toBeLessThanOrEqual(12);
      // Two lines end above the key/value box (top 71) and start no higher than the page margin area.
      expect(layout.top + 2 * layout.fontSize * 1.2).toBeLessThanOrEqual(69.01);
      expect(layout.top).toBeGreaterThan(30);
    }
  });

  it("prints a 45-character company name in full, with no ellipsis, beside a long title", async () => {
    const documentName = "Wolverhampton Precision Engineering Limited";
    const data: PdfDocumentData = {
      title: "Wolverhampton Precision Engineering Quotes Export", documentNumber: "x", keyValues: [{ label: "Records", value: "1" }],
      billToLabel: "Export For:", billTo: ["a"], deliverTo: ["b"], columns: "descriptionOnly", lineItems: [{ description: "Row", quantity: 1 }],
      company: { ...JNR_PROFILE, name: documentName, documentName, logoSrc: undefined },
    };
    const text = pdfText(await renderToBuffer(createElement(BaseDocumentPDF, { data }) as unknown as Parameters<typeof renderToBuffer>[0])).replace(/\s+/g, " ");
    expect(text).toContain(documentName);
    // (The over-long title is the only thing cut, by design: its own "..." follows the title, never the company name.)
    expect(text).not.toMatch(/Limited\s*(\.\.\.|\u2026)/);
    expect(text).not.toContain("\u2026");
  });

  it("shrinks a long title to fit its column, and keeps a short one at full size", () => {
    expect(titleFontSize("Quotes Export")).toBe(TITLE_MAX_FONT_SIZE);
    expect(titleFontSize("Delivery Note")).toBe(TITLE_MAX_FONT_SIZE);
    const long = "JNR Engineering Ltd Quotes Export";
    const size = titleFontSize(long);
    expect(size).toBeLessThan(TITLE_MAX_FONT_SIZE);
    expect(size).toBeGreaterThanOrEqual(9);
    expect(long.length * 0.72 * size).toBeLessThanOrEqual(TITLE_WIDTH);
    expect(titleFontSize("x".repeat(200))).toBe(9);
    // Past the smallest size it is cut with "..." rather than left to run past its column.
    expect(printedTitle("Quotes Export")).toBe("QUOTES EXPORT");
    const cut = printedTitle("x".repeat(200));
    expect(cut.endsWith("...")).toBe(true);
    expect(cut.length * 0.72 * 9).toBeLessThanOrEqual(TITLE_WIDTH);
  });

  it("lets the Description column take the remaining width and pads its text on both sides", () => {
    expect(columnStyle([546], 0)).toMatchObject({ flexGrow: 1, flexShrink: 1, minWidth: 0 });
    expect(columnStyle([285.5, 65.5], 1)).toEqual({ width: 65.5 });
    const desc = styles.descText as Record<string, number>;
    expect(desc.paddingLeft).toBeGreaterThan(0);
    expect(desc.paddingRight).toBeGreaterThan(0);
  });

  it("renders a long title and long wrapped descriptions without losing any text", async () => {
    const description = Array.from({ length: 14 }, (_, i) => `Customer ${i}: Status: Running, Priority: High, Notes: needs the long bracket re-machined`).join(" | ");
    const data: PdfDocumentData = {
      title: "JNR Engineering Ltd Quotes Export", documentNumber: "2026-10-22", keyValues: [{ label: "Records", value: "1" }],
      billToLabel: "Export For:", billTo: [JNR_PROFILE.name], deliverTo: [JNR_PROFILE.documentName], columns: "descriptionOnly",
      lineItems: [{ description, quantity: 1 }], company: JNR_PROFILE, logoSrc: undefined,
    };
    const buffer = await renderToBuffer(createElement(BaseDocumentPDF, { data }) as unknown as Parameters<typeof renderToBuffer>[0]);
    const text = pdfText(buffer).replace(/\s+/g, " ");
    expect(text).toContain("J N R Engineering Ltd");
    expect(text).toContain("QUOTES EXPORT");
    expect(text).toContain("needs the long bracket re-machined");
  });
});

describe("real customer documents are laid out as before the export fix", () => {
  const company = { ...JNR_PROFILE, logoSrc: undefined };
  const long = "Machine and weld a stainless steel bracket assembly to drawing JNR-4471 rev C including all deburring, passivation, inspection report and certificate of conformance, packed and delivered";
  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ description: i === 1 ? long : `Bush ${i} 40mm OD`, quantity: i + 1, unitPrice: 12.5 + i, vatPct: 20 }));
  const customer = ["Wolverhampton & District Precision Engineering and Fabrication Holdings Limited", "Unit 14, Very Long Industrial Estate Road", "Wolverhampton", "WV1 1AA"];
  const pages = async (element: unknown) => (await renderToBuffer(element as Parameters<typeof renderToBuffer>[0])).toString("latin1").match(/\/Type \/Page$/gm)?.length ?? 0;

  // Page counts taken from the layout before the change (6c41042), same fixtures: 4 lines (one long, wrapping) and 40 lines.
  const documents = (n: number) => ({
    quote: createElement(QuotePDF, { data: { number: "QUO-1001", date: "22/10/2026", billTo: customer, lineItems: lines(n), carriage: 15, validUntil: "21/11/2026", scope: "Bracket supply", company } }),
    invoice: createElement(InvoicePDF, { data: { number: "INV-1001", date: "22/10/2026", billTo: customer, lineItems: lines(n), carriage: 15, payments: 50, credits: 10, customerPo: "PO-99812", company } }),
    credit: createElement(CreditNotePDF, { data: { number: "CRD-1001", date: "22/10/2026", invoiceRef: "INV-1001", billTo: customer, lineItems: lines(n), company } }),
    delivery: createElement(DeliveryNotePDF, { data: { number: "DLN-1001", taxDate: "22/10/2026", shipDate: "23/10/2026", billTo: customer, items: lines(n), company } }),
    po: createElement(PurchaseOrderPDF, { data: { number: "PO-1001", date: "22/10/2026", supplier: customer, lineItems: lines(n), vatEnabled: true, company } }),
    so: createElement(SalesOrderPDF, { data: { number: "SO-1001", date: "22/10/2026", billTo: customer, lineItems: lines(n), vatEnabled: true, company } }),
  });

  it("keeps each document's page count", async () => {
    const short = Object.fromEntries(await Promise.all(Object.entries(documents(4)).map(async ([k, v]) => [k, await pages(v)])));
    const many = Object.fromEntries(await Promise.all(Object.entries(documents(40)).map(async ([k, v]) => [k, await pages(v)])));
    expect(short).toEqual({ quote: 2, invoice: 1, credit: 1, delivery: 1, po: 1, so: 1 });
    expect(many).toEqual({ quote: 3, invoice: 3, credit: 3, delivery: 3, po: 3, so: 3 });
  }, 60000);

  it("prints every standard document title at full size, so only export titles ever shrink", () => {
    for (const title of ["Quote", "Invoice", "Credit Note", "Delivery Note", "Purchase Order", "Sales Order"]) {
      expect(titleFontSize(title)).toBe(TITLE_MAX_FONT_SIZE);
      expect(printedTitle(title)).toBe(title.toUpperCase());
    }
  });

  it("fills the table exactly: fixed columns plus the flexible Description column", () => {
    // Table inner width = A4 595.28 - 2 x 24 page padding - 2 x 1 border = 545.28; the fixed columns sum to 260.5 (priced with VAT).
    expect(columnStyle([285.5, 65.5, 66.5, 62.5, 66], 0)).toMatchObject({ flexGrow: 1 });
    expect([65.5, 66.5, 62.5, 66].map((w, i) => (columnStyle([285.5, 65.5, 66.5, 62.5, 66], i + 1) as { width: number }).width)).toEqual([65.5, 66.5, 62.5, 66]);
  });
});
