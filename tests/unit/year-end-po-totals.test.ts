/**
 * Audit A2: purchase_orders.total_value is stored NET of VAT, so the year-end summary.csv Gross for a PO must be
 * worked out from its lines exactly as the printed PO (PurchaseOrderPDF) totals them, never copied from total_value.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { computePdfTotals } from "@/components/pdf/BaseDocumentPDF";
import { PurchaseOrderPDF } from "@/components/pdf/PurchaseOrderPDF";
import { JNR_PROFILE } from "@/lib/company";
import { exportReadme, purchaseOrderExportTotals, purchaseOrderSummaryRow, summaryCsv } from "@/lib/year-end-export";
import { pdfText } from "../support/pdf-text";

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined, vatRegistered: true, defaultVatRate: 20 };

/** What PurchaseOrderPDF/BaseDocumentPDF compute for the same lines and VAT switch. */
function pdfTotals(lineItems: Parameters<typeof computePdfTotals>[0]["lineItems"], vatEnabled: boolean, c = company) {
  const showVat = vatEnabled === true && c.vatRegistered !== false;
  return computePdfTotals({ lineItems, showVat, standardVatRate: c.defaultVatRate ?? 20 });
}

const po = (fields: Record<string, unknown>) => ({ po_ref: "PO-0001", supplier: "Example Supplies Ltd", status: "sent", ...fields });

describe("year-end export: purchase order totals", () => {
  it("£100 net, one 20% line, VAT on: Net 100.00, VAT 20.00, Gross 120.00, same as the printed PO", async () => {
    const r = po({ total_value: 100, vat_enabled: true, items: [{ description: "Steel plate", qty: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }] });
    const out = purchaseOrderExportTotals(r, company);
    expect(out).toMatchObject({ net: 100, vat: 20, gross: 120, problem: null });
    const pdf = pdfTotals(out.items, true);
    expect([out.net, out.vat, out.gross]).toEqual([pdf.subtotal, pdf.vat, pdf.total]);
    const element = createElement(PurchaseOrderPDF, { data: { number: "PO-0001", date: "01/03/2026", supplier: ["Example Supplies Ltd"], lineItems: out.items, vatEnabled: true, company } });
    const text = pdfText(await renderToBuffer(element as unknown as Parameters<typeof renderToBuffer>[0]));
    expect(text).toMatch(/Total\s*:\s*£120\.00/);
  });

  it.each([false, null, undefined])("VAT off on the PO (vat_enabled %s): VAT 0, Gross = Net", (vatEnabled) => {
    const r = po({ total_value: 100, vat_enabled: vatEnabled, items: [{ description: "Steel plate", qty: 1, unit_price: 100, vat_pct: 20 }] });
    const out = purchaseOrderExportTotals(r, company);
    expect(out).toMatchObject({ net: 100, vat: 0, gross: 100, problem: null });
    const pdf = pdfTotals(out.items, false);
    expect([out.net, out.vat, out.gross]).toEqual([pdf.subtotal, pdf.vat, pdf.total]);
  });

  it("company not VAT registered: no VAT even when the PO says VAT on (as the PDF prints)", () => {
    const unregistered = { ...company, vatRegistered: false };
    const r = po({ total_value: 100, vat_enabled: true, items: [{ description: "Steel plate", qty: 1, unit_price: 100, vat_pct: 20 }] });
    expect(purchaseOrderExportTotals(r, unregistered)).toMatchObject({ net: 100, vat: 0, gross: 100 });
  });

  it("an exempt line mixed with a standard-rate line", () => {
    const r = po({
      total_value: 150.5,
      vat_enabled: true,
      items: [
        { description: "Machining", qty: 2, unit_price: 50.25, vat_pct: 20, vat_exempt: false },
        { description: "Courier (exempt)", qty: 1, unit_price: 50, vat_pct: 0, vat_exempt: true },
      ],
    });
    const out = purchaseOrderExportTotals(r, company);
    expect(out).toMatchObject({ net: 150.5, vat: 20.1, gross: 170.6, problem: null });
    const pdf = pdfTotals(out.items, true);
    expect([out.net, out.vat, out.gross]).toEqual([pdf.subtotal, pdf.vat, pdf.total]);
  });

  it("valid PO: summary row carries Net 100.00 / VAT 20.00 / Gross 120.00 and its PDF is included", () => {
    const r = po({ total_value: 100, vat_enabled: true, items: [{ description: "Steel plate", qty: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }] });
    const out = purchaseOrderSummaryRow(r, company);
    expect(out).toMatchObject({ includePdf: true, unresolved: null, problem: null });
    expect(out.row).toMatchObject({ net: 100, vat: 20, gross: 120, status: "sent" });
    expect(summaryCsv([out.row])).toContain(",100.00,20.00,120.00,");
  });

  it("stored net not matching its lines: UNRESOLVED, no amounts, no PDF, and the discrepancy is reported", () => {
    const r = po({ po_ref: "PO-0042", total_value: 90, vat_enabled: true, items: [{ description: "Steel plate", qty: 1, unit_price: 100, vat_pct: 20 }] });
    const out = purchaseOrderSummaryRow(r, company);
    expect(out.unresolved).toEqual({ storedNet: 90, calculatedNet: 100, discrepancy: 10 });
    expect(out.includePdf).toBe(false);
    expect(out.row).toMatchObject({ number: "PO-0042", net: null, vat: null, gross: null, pdf: "" });
    expect(out.row.status).toMatch(/^UNRESOLVED/);
    expect(out.problem).toBe("Purchase order PO-0042: UNRESOLVED, not reconciled. Stored net £90.00, calculated net from its lines £100.00, discrepancy £10.00 (lines minus stored). Left out of the summary amounts and no PDF included; the stored value is unchanged.");
    // In summary.csv it is listed with empty Net/VAT/Gross (not 0.00, not the line totals) and no PDF path.
    const line = summaryCsv([out.row]).split("\r\n")[1];
    expect(line).toMatch(/^Purchase order,PO-0042,,Example Supplies Ltd,,,,,,,UNRESOLVED[^,]*,$/);
    expect(line).not.toMatch(/\d+\.\d{2}/);
    expect((r as Record<string, unknown>).total_value).toBe(90); // the stored value is never rewritten
  });

  it("README leads with an unresolved-records warning only when there are any", () => {
    const counts = { documents: 2, invoices: 0, quotes: 0, pos: 2, notes: 0 };
    expect(exportReadme("Example Engineering Ltd", "2026-01-01", "2026-12-31", { ...counts, unresolved: 0 })).not.toMatch(/UNRESOLVED/);
    const readme = exportReadme("Example Engineering Ltd", "2026-01-01", "2026-12-31", { ...counts, unresolved: 1 });
    expect(readme.startsWith("WARNING: THIS EXPORT CONTAINS 1 UNRESOLVED RECORD.")).toBe(true);
    expect(readme).toMatch(/problems\.txt/);
  });

  it("stored net equal to the lines to the penny is not a problem (exact money comparison)", () => {
    const r = po({ total_value: "0.30", vat_enabled: true, items: [{ description: "Washers", qty: 3, unit_price: 0.1, vat_pct: 20 }] });
    expect(purchaseOrderExportTotals(r, company).problem).toBeNull();
  });

  it("no saved items: one line for the stored net, with VAT added when the PO has VAT on (as the PDF prints)", () => {
    const on = purchaseOrderExportTotals(po({ total_value: 250, vat_enabled: true, items: [] }), company);
    expect(on.items).toEqual([{ description: "Materials ordered from Example Supplies Ltd", quantity: 1, unitPrice: 250 }]);
    expect(on).toMatchObject({ net: 250, vat: 50, gross: 300, problem: null });
    const pdf = pdfTotals(on.items, true);
    expect([on.net, on.vat, on.gross]).toEqual([pdf.subtotal, pdf.vat, pdf.total]);

    const off = purchaseOrderExportTotals(po({ total_value: 250, vat_enabled: false, items: null }), company);
    expect(off).toMatchObject({ net: 250, vat: 0, gross: 250, problem: null });
  });
});
