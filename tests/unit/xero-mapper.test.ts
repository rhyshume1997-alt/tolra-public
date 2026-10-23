/**
 * Xero payload mapping (G22, migration 084): invoices and credit notes keep Tolra's numbers and figures; every line's tax rate comes from
 * the company's mapping of its VAT key, and nothing maps while anything used is unmapped; text-only lines are description lines; Xero
 * never e-mails the customer (Q10); credit notes are Xero credit notes (Q7); no tracking categories (Q6); totals are compared to the penny.
 */
import { describe, expect, it } from "vitest";

import { decideContact } from "@/lib/integrations/contacts";
import type { IntegrationDocument, Mappings } from "@/lib/integrations/types";
import { UnmappedError, expectedTotals, mapCreditNote, mapInvoice, missingMappings, totalsDifference } from "@/lib/integrations/xero/mapper";
import { ALLOCATE_CREDIT_NOTES, CONNECT_ROLES, CREDIT_NOTE_XERO_TYPE, TRACKING_CATEGORIES, VOID_IN_XERO, XERO_EMAILS_CUSTOMERS, voidRefusedMessage } from "@/lib/integrations/xero/policy";

const mappings: Mappings = { salesAccount: "200", creditAccount: "260", taxRates: { "20": "OUTPUT2", "5": "RROUTPUT", "0": "ZERORATEDOUTPUT", exempt: "EXEMPTOUTPUT", no_vat: "NONE" } };

const invoice: IntegrationDocument = {
  doc_type: "invoice", id: "i-1", number: "INV-0042", date: "2026-10-21", due_date: "2026-11-20", reference: "PO 7781", customer: "Acme Engineering Ltd",
  status: "issued", voided: false, subtotal: 135, carriage: 15, vat: 26.5, total: 176.5,
  lines: [
    { description: "Bush, bored", quantity: 2, unit_price: 50, net: 100, vat: 20, vat_key: "20", text_only: false },
    { description: "Child seat part", quantity: 3, unit_price: 10, net: 30, vat: 1.5, vat_key: "5", text_only: false },
    { description: "Drawing ACL-7 rev C", quantity: 0, unit_price: 0, net: 0, vat: 0, vat_key: null, text_only: true },
    { description: "Exempt test fee", quantity: 1, unit_price: 5, net: 5, vat: 0, vat_key: "exempt", text_only: false },
    { description: "Carriage", quantity: 1, unit_price: 15, net: 15, vat: 3, vat_key: "20", text_only: false, carriage: true },
  ],
};
const credit: IntegrationDocument = {
  doc_type: "credit_note", id: "c-1", number: "CRD-2167", date: "2026-10-22", due_date: null, reference: "INV-0042", customer: "Acme Engineering Ltd",
  status: "issued", voided: false, subtotal: 50, carriage: 0, vat: 10, total: 60,
  lines: [{ description: "Bush returned", quantity: 1, unit_price: 50, net: 50, vat: 10, vat_key: "20", text_only: false }],
};

describe("invoice", () => {
  it("keeps Tolra's number, dates and PO; every priced line carries its account, mapped tax rate and Tolra's VAT", () => {
    const p = mapInvoice(invoice, mappings, "contact-1");
    expect(p).toMatchObject({ Type: "ACCREC", Contact: { ContactID: "contact-1" }, InvoiceNumber: "INV-0042", Reference: "PO 7781", Date: "2026-10-21", DueDate: "2026-11-20",
      LineAmountTypes: "Exclusive", Status: "AUTHORISED", SentToContact: false });
    expect(p.LineItems).toEqual([
      { Description: "Bush, bored", Quantity: 2, UnitAmount: 50, AccountCode: "200", TaxType: "OUTPUT2", TaxAmount: 20 },
      { Description: "Child seat part", Quantity: 3, UnitAmount: 10, AccountCode: "200", TaxType: "RROUTPUT", TaxAmount: 1.5 },
      { Description: "Drawing ACL-7 rev C" },
      { Description: "Exempt test fee", Quantity: 1, UnitAmount: 5, AccountCode: "200", TaxType: "EXEMPTOUTPUT", TaxAmount: 0 },
      { Description: "Carriage", Quantity: 1, UnitAmount: 15, AccountCode: "200", TaxType: "OUTPUT2", TaxAmount: 3 },
    ]);
    // No tracking categories (Q6) and never a payment field.
    expect(JSON.stringify(p)).not.toMatch(/Tracking|Payments|AmountPaid/);
  });

  it("a company that is not VAT registered: every line is 'no_vat', mapped like any other key", () => {
    const noVat: IntegrationDocument = { ...invoice, vat: 0, total: 150, lines: invoice.lines.map((l) => ({ ...l, vat: 0, vat_key: l.text_only ? null : "no_vat" })) };
    expect(mapInvoice(noVat, mappings, "c").LineItems.filter((l) => l.TaxType).every((l) => l.TaxType === "NONE" && l.TaxAmount === 0)).toBe(true);
  });

  it("without a PO or due date those fields are left out (Xero applies the contact's terms)", () => {
    const p = mapInvoice({ ...invoice, reference: null, due_date: null }, mappings, "c");
    expect("Reference" in p).toBe(false);
    expect("DueDate" in p).toBe(false);
  });
});

describe("credit note (Q7: a Xero credit note, unallocated)", () => {
  it("is an ACCRECCREDIT with Tolra's CRD number, the credit-note account and the invoice number as its reference", () => {
    const p = mapCreditNote(credit, mappings, "contact-1");
    expect(p).toMatchObject({ Type: "ACCRECCREDIT", CreditNoteNumber: "CRD-2167", Reference: "INV-0042", Date: "2026-10-22", Status: "AUTHORISED", SentToContact: false });
    expect(p.LineItems).toEqual([{ Description: "Bush returned", Quantity: 1, UnitAmount: 50, AccountCode: "260", TaxType: "OUTPUT2", TaxAmount: 10 }]);
    expect(JSON.stringify(p)).not.toMatch(/Allocations/);
  });

  it("an invoice is never mapped as a credit note, nor the other way round", () => {
    expect(() => mapCreditNote(invoice, mappings, "c")).toThrow();
    expect(() => mapInvoice(credit, mappings, "c")).toThrow();
  });
});

describe("the mapping completeness gate", () => {
  it("names each account and VAT key used and not mapped; text-only lines need nothing", () => {
    expect(missingMappings(invoice, mappings)).toEqual([]);
    expect(missingMappings(invoice, { ...mappings, taxRates: { "20": "OUTPUT2" } })).toEqual(["vat:5", "vat:exempt"]);
    expect(missingMappings(invoice, { ...mappings, salesAccount: null })).toEqual(["account:sales"]);
    expect(missingMappings(credit, { ...mappings, creditAccount: null })).toEqual(["account:credit"]);
    expect(missingMappings({ ...invoice, lines: [invoice.lines[2]] }, { salesAccount: "200", creditAccount: null, taxRates: {} })).toEqual([]);
  });

  it("nothing is mapped while anything is missing (UnmappedError, before any request)", () => {
    expect(() => mapInvoice(invoice, { ...mappings, taxRates: { "20": "OUTPUT2" } }, "c")).toThrow(UnmappedError);
    expect(() => mapCreditNote(credit, { ...mappings, creditAccount: null }, "c")).toThrow(/account:credit/);
  });

  it("a document without a number (not issued) is never mapped", () => {
    expect(() => mapInvoice({ ...invoice, number: null }, mappings, "c")).toThrow(/no number/);
  });
});

describe("totals", () => {
  it("Xero's net includes carriage; equal to the penny is no difference; any difference is said, never rounded away", () => {
    expect(expectedTotals(invoice)).toEqual({ subTotal: 150, totalTax: 26.5, total: 176.5 });
    expect(totalsDifference(expectedTotals(invoice), { subTotal: 150.0000001, totalTax: 26.5, total: 176.5 })).toBeNull();
    expect(totalsDifference(expectedTotals(invoice), { subTotal: 150, totalTax: 26.51, total: 176.51 })).toBe("Totals differ: VAT Tolra 26.50, Xero 26.51; total Tolra 176.50, Xero 176.51");
  });
});

describe("contact match: exact name, one / none / two", () => {
  it("one active contact with exactly that name is linked; none is created; two is a problem", () => {
    expect(decideContact(" Acme Ltd ", [{ id: "a", name: "Acme Ltd", archived: false }])).toEqual({ kind: "link", id: "a" });
    expect(decideContact("Acme Ltd", [])).toEqual({ kind: "create" });
    expect(decideContact("Acme Ltd", [{ id: "a", name: "Acme Ltd", archived: false }, { id: "b", name: "Acme Ltd ", archived: true }])).toMatchObject({ kind: "problem", reason: expect.stringMatching(/^2 contacts/) });
  });

  it("never guesses: an archived match or a different spelling is a problem; an empty name is a problem", () => {
    expect(decideContact("Acme Ltd", [{ id: "a", name: "Acme Ltd", archived: true }])).toMatchObject({ kind: "problem", reason: expect.stringMatching(/archived/) });
    expect(decideContact("Acme Ltd", [{ id: "a", name: "ACME LTD", archived: false }])).toMatchObject({ kind: "problem", reason: expect.stringMatching(/spelt differently/) });
    expect(decideContact("  ", [])).toMatchObject({ kind: "problem" });
    // Another contact whose name only contains it is not a match (Xero's lookup is by the whole name; these are ignored).
    expect(decideContact("Acme", [{ id: "x", name: "Acme Ltd", archived: false }])).toEqual({ kind: "create" });
  });
});

describe("the question-dependent switches (lib/integrations/xero/policy.ts) are at their G22 defaults", () => {
  it("Q7 credit notes, Q9 admins only, Q10 Xero never e-mails, Q6 no tracking, Q11 voids sent as voids", () => {
    expect(CREDIT_NOTE_XERO_TYPE).toBe("ACCRECCREDIT");
    expect(ALLOCATE_CREDIT_NOTES).toBe(false);
    expect([...CONNECT_ROLES]).toEqual(["admin"]);
    expect(XERO_EMAILS_CUSTOMERS).toBe(false);
    expect(TRACKING_CATEGORIES).toEqual([]);
    expect(VOID_IN_XERO).toBe(true);
    expect(voidRefusedMessage("payment applied")).toMatch(/raise a credit note in Xero by hand/);
  });
});
