/**
 * Audit A3: an issued invoice's details panel must show the amounts it was issued with (and that its PDF prints),
 * not amounts recomputed from today's VAT settings. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { storedTotalsProblem } from "@/components/pdf/BaseDocumentPDF";
import { InvoicePDF } from "@/components/pdf/InvoicePDF";
import { JNR_PROFILE } from "@/lib/company";
import { issuedCompany } from "@/lib/document-snapshot";
import { invoiceDisplayTotals, invoiceIssuer } from "@/lib/invoice-totals";
import { pdfText } from "../support/pdf-text";

const base = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined, vatRegistered: true, defaultVatRate: 20 };
const snapshot = { documentName: "Example Engineering Ltd", vatRegistered: true, defaultVatRate: 20 };
const lines = [
  { description: "Widget", quantity: 2, unitPrice: 30, vatPct: 20 },
  { description: "Bracket", quantity: 1, unitPrice: 40, vatPct: 20 },
];
// Issued under a 20% registered snapshot: £100 lines + £20 carriage (VAT on) + £24 VAT = £144.
const issued = { carriage: 20, vatEnabled: true, carriageVat: true, issuerSnapshot: snapshot, rawStatus: "issued" };
const storedTotals = { reference: "INV-9001", issued: true, subtotal: 100, vat: 24, total: 144 };

const todayProfiles = {
  "unchanged (registered, 20%)": base,
  "no longer VAT registered": { ...base, vatRegistered: false },
  "standard rate now 17.5%": { ...base, defaultVatRate: 17.5 },
};

/** What the invoices page renders as the PDF (buildInvoicePdf): issue-time company, the invoice's own VAT settings. */
function invoicePdf(current: typeof base) {
  return createElement(InvoicePDF, {
    data: {
      storedTotals, number: "INV-9001", date: "01/02/2026", billTo: ["Test Customer Ltd"], lineItems: lines,
      carriage: issued.carriage, vatEnabled: issued.vatEnabled, carriageVat: issued.carriageVat, payments: 0,
      company: issuedCompany(current, issued.issuerSnapshot),
    },
  });
}
const render = (element: unknown) => renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);

describe("issued invoice totals follow the issue-time snapshot (audit A3)", () => {
  for (const [label, current] of Object.entries(todayProfiles)) {
    it(`details panel: £144 with £24 VAT when today's profile is ${label}`, () => {
      const { showVat, totals } = invoiceDisplayTotals(issued, lines, current);
      expect(showVat).toBe(true);
      expect(totals).toMatchObject({ subtotal: 100, carriage: 20, vat: 24, total: 144 });
      expect(totals.vatBreakdown).toEqual([{ rate: 20, exempt: false, net: 120, vat: 24 }]);
    });

    it(`PDF: stored-totals check passes and prints £144 / VAT £24 when today's profile is ${label}`, async () => {
      const company = issuedCompany(current, issued.issuerSnapshot);
      expect(storedTotalsProblem({ lineItems: lines, carriage: issued.carriage, showVat: issued.vatEnabled, carriageVat: issued.carriageVat, company, storedTotals })).toBeNull();
      const text = pdfText(await render(invoicePdf(current)));
      expect(text).toMatch(/VAT[^£]*£24\.00/);
      expect(text).toMatch(/Invoice total\s*:?\s*£144\.00/);
    });
  }

  it("the stored-totals check still refuses lines that don't add up to what was issued", () => {
    const company = issuedCompany(todayProfiles["standard rate now 17.5%"], snapshot);
    const problem = storedTotalsProblem({ lineItems: lines, carriage: 20, showVat: true, carriageVat: true, company, storedTotals: { ...storedTotals, total: 150, vat: 30 } });
    expect(problem).not.toBeNull();
  });

  it("an invoice issued with VAT off stays VAT-free", () => {
    const { showVat, totals } = invoiceDisplayTotals({ ...issued, vatEnabled: false }, lines, base);
    expect(showVat).toBe(false);
    expect(totals).toMatchObject({ subtotal: 100, carriage: 20, vat: 0, total: 120 });
  });
});

describe("drafts follow the current settings (with or without a saved snapshot)", () => {
  const draft = { carriage: 20, vatEnabled: true, carriageVat: true };

  it("registered at 20%", () => {
    expect(invoiceDisplayTotals(draft, lines, base).totals).toMatchObject({ vat: 24, total: 144 });
  });

  it("standard rate now 17.5%: carriage VAT at the current standard rate", () => {
    // Lines keep their own 20% rate; carriage takes the standard rate: 20 + 3.50.
    expect(invoiceDisplayTotals(draft, lines, { ...base, defaultVatRate: 17.5 }).totals).toMatchObject({ vat: 23.5, total: 143.5 });
  });

  it("not VAT registered: no VAT", () => {
    const { showVat, totals } = invoiceDisplayTotals(draft, lines, { ...base, vatRegistered: false });
    expect(showVat).toBe(false);
    expect(totals).toMatchObject({ vat: 0, total: 120 });
  });

  it("profile still loading: registered at 20%, as companyVat(null)", () => {
    expect(invoiceDisplayTotals(draft, lines, null)).toMatchObject({ showVat: true, totals: { vat: 24, total: 144 } });
  });

  // Saving a draft also stores a snapshot (021), but issuing re-checks at today's rate and re-snapshots (027).
  const savedDraft = { ...draft, issuerSnapshot: snapshot, rawStatus: "draft" };
  it("a saved draft's 20% snapshot is ignored once the rate is 17.5%: details and PDF company follow today's settings", () => {
    const today = { ...base, defaultVatRate: 17.5 };
    expect(invoiceIssuer(savedDraft, today).defaultVatRate).toBe(17.5);
    expect(invoiceDisplayTotals(savedDraft, lines, today).totals).toMatchObject({ vat: 23.5, total: 143.5 });
    // Its stored £144 no longer adds up at today's rate: flagged, as issue_invoice would refuse it.
    const problem = storedTotalsProblem({ lineItems: lines, carriage: 20, showVat: true, carriageVat: true, company: invoiceIssuer(savedDraft, today), storedTotals: { ...storedTotals, reference: "draft", issued: false } });
    expect(problem).not.toBeNull();
  });

  it("the same saved snapshot is kept once issued", () => {
    expect(invoiceDisplayTotals({ ...savedDraft, rawStatus: "issued" }, lines, { ...base, defaultVatRate: 17.5 }).totals.total).toBe(144);
  });
});

describe("the invoices page uses the shared helper", () => {
  const source = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/invoices/page.tsx"), "utf8");

  it("computes the details panel totals with invoiceDisplayTotals, not today's VAT settings", () => {
    expect(source).toMatch(/const \{ showVat: viewVat, totals: viewTotals \} = invoiceDisplayTotals\(viewingInvoice\b/);
    expect(source).not.toMatch(/viewVat\s*=.*vat\.registered/);
    expect(source).toMatch(/<VatTotals totals=\{viewTotals\} vatEnabled=\{viewVat\}/);
  });

  it("the totals check and the PDF take the company from invoiceIssuer (drafts: today's settings)", () => {
    expect(source).toMatch(/invoiceTotalsProblem\(viewingInvoice, viewLineItems, invoiceIssuer\(viewingInvoice, company\)\)/);
    expect(source).toMatch(/const profile = invoiceIssuer\(invoice, currentProfile\);/);
    expect(source).not.toMatch(/issuedCompany\(/);
  });
});
