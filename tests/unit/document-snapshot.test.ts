import { describe, expect, it } from "vitest";

import { computePdfTotals } from "@/components/pdf/BaseDocumentPDF";
import { JNR_PROFILE } from "@/lib/company";
import { issuedBillTo, issuedCompany } from "@/lib/document-snapshot";

const snapshot = {
  documentName: "Alpha Engineering Ltd", addressLines: ["Unit 1", "Testtown"], vatNumber: "GB 1", vatRegistered: true,
  defaultVatRate: 20, defaultInvoiceTerms: "30 days", defaultCustomerMessage: ["Thanks"],
};

describe("printing an issued document from its snapshot (audit D9)", () => {
  // Since issue the company moved, deregistered for VAT, changed its standard rate and terms.
  const today = { ...JNR_PROFILE, documentName: "Renamed Ltd", addressLines: ["New HQ"], vatRegistered: false, defaultVatRate: 17.5, defaultInvoiceTerms: "7 days", logoSrc: "data:image/png;base64,AAAA" };

  it("uses the issuer details recorded at issue, keeping today's logo", () => {
    const company = issuedCompany(today, snapshot);
    expect(company).toMatchObject({ documentName: "Alpha Engineering Ltd", addressLines: ["Unit 1", "Testtown"], vatRegistered: true, defaultVatRate: 20, defaultInvoiceTerms: "30 days", logoSrc: today.logoSrc });
  });

  it("keeps the economics identical to the issued document", () => {
    const lines = [{ description: "Part", quantity: 2, unitPrice: 150, vatPct: 20 }];
    const issued = issuedCompany(today, snapshot);
    const totals = computePdfTotals({ lineItems: lines, showVat: issued.vatRegistered, carriage: 10, carriageVat: true, payments: 0, standardVatRate: issued.defaultVatRate });
    expect(totals).toMatchObject({ subtotal: 300, carriage: 10, vat: 62, total: 372 });
  });

  it("uses the customer's address as recorded", () => {
    expect(issuedBillTo({ name: "Acme", address: "1 Old Road\nOldtown", found: true }, "Acme")).toEqual(["Acme", "1 Old Road", "Oldtown"]);
    expect(issuedBillTo({ name: "Walk-in", address: null, found: false }, "Walk-in")).toEqual(["Walk-in"]);
  });

  it("falls back to today's details for documents issued before snapshots existed", () => {
    expect(issuedCompany(today, null)).toBe(today);
    expect(issuedBillTo(undefined, "Acme")).toBeNull();
  });
});

import { finalTotalRows } from "@/components/pdf/BaseDocumentPDF";

describe("invoice PDF closing rows (audit A13)", () => {
  it("a fully paid £120 invoice shows £120 total, £120 paid, £0 balance due", () => {
    expect(finalTotalRows({ total: 120, payments: 120, balance: 0 }).map((r) => [r.label, r.value])).toEqual([["Invoice total", 120], ["Paid", 120], ["Balance due", 0]]);
  });
  it("part paid and unpaid", () => {
    expect(finalTotalRows({ total: 120, payments: 50, balance: 70 }).at(-1)).toEqual({ label: "Balance due", value: 70, bold: true });
    expect(finalTotalRows({ total: 120, payments: 0, balance: 120 })[0]).toEqual({ label: "Invoice total", value: 120, bold: false });
  });
  it("quotes and POs (no payments) keep a single Total", () => {
    expect(finalTotalRows({ total: 99, payments: null, balance: 99 })).toEqual([{ label: "Total", value: 99, bold: true }]);
  });
});
