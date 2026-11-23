/**
 * Fixed sample documents for the document template tests (module J): one per document type, with mixed VAT rates, an exempt line, a text-only
 * line, carriage, payments, credits, bank details and a long description, so every part of a printed document is exercised.
 * Test support only: must not be imported by app code.
 */
import type { DeliveryNotePdfData } from "@/components/pdf/DeliveryNotePDF";
import type { InvoicePdfData } from "@/components/pdf/InvoicePDF";
import type { PurchaseOrderPdfData } from "@/components/pdf/PurchaseOrderPDF";
import type { QuotePdfData } from "@/components/pdf/QuotePDF";
import { type CompanyProfile, JNR_PROFILE } from "@/lib/company";

export const FIXTURE_COMPANY: CompanyProfile = {
  ...JNR_PROFILE,
  brandPrimary: "#7a1f3d",
  brandAccent: "#e8b04b",
  bankDetails: { accountName: "JNR Engineering Ltd", bankName: "Example Bank", sortCode: "12-34-56", accountNumber: "12345678", iban: "GB00EXAM12345612345678", bic: "EXAMGB2L" },
  logoSrc: undefined,
};

const LINES = [
  { description: "CNC machined bracket, mild steel, as drawing JNR-1001 rev C", quantity: 25, unitPrice: 14.37 },
  { description: "Powder coat, RAL 7016, per bracket", quantity: 25, unitPrice: 2.1, vatPct: 5 },
  { description: "Export certificate (outside the scope of VAT)", quantity: 1, unitPrice: 45, vatExempt: true },
  { description: "Delivered in two lots; the second follows within the week.", quantity: 0, unitPrice: 0 },
  { description: "Long description line that has to wrap across the width of the description column so that the row grows and the table fills correctly on the page", quantity: 3, unitPrice: 99.99 },
];

export const FIXTURE_QUOTE: QuotePdfData = {
  number: "QUO-0042", date: "22/11/2026", validUntil: "22/12/2026", terms: "Valid for 30 days", scope: "Brackets as drawing JNR-1001", customerPo: "PO-778",
  billTo: ["Acme Fabrications Ltd", "1 Example Road", "Sheffield", "S1 1AA"], lineItems: LINES, carriage: 12.5, carriageVat: true, vatEnabled: true,
  customerMessage: ["Thank you for the enquiry.", "Prices are ex VAT unless shown."], company: FIXTURE_COMPANY,
};

export const FIXTURE_INVOICE: InvoicePdfData = {
  number: "INV-1234", date: "22/11/2026", taxPoint: "20/11/2026", terms: "30 days", quoteRef: "QUO-0042", customerPo: "PO-778", deliveryNotes: "DLN-1230, DLN-1231",
  billTo: ["Acme Fabrications Ltd", "1 Example Road", "Sheffield", "S1 1AA"], deliverTo: ["Acme Goods In", "Unit 4", "Rotherham", "S60 1AA"],
  note: "Part invoice, balance to follow.", lineItems: LINES, carriage: 12.5, carriageVat: true, vatEnabled: true, payments: 100, credits: 25.25, company: FIXTURE_COMPANY,
};

export const FIXTURE_INVOICE_PAID: InvoicePdfData = { ...FIXTURE_INVOICE, number: "INV-1235", note: undefined, payments: undefined, credits: undefined, paid: true, paymentUnknown: false };

export const FIXTURE_PURCHASE_ORDER: PurchaseOrderPdfData = {
  number: "PO-0310", date: "22/11/2026", requiredBy: "29/11/2026", supplier: ["Steel Supplies plc", "2 Mill Lane", "Leeds", "LS1 1AA"],
  lineItems: LINES.slice(0, 2), vatEnabled: true, notes: ["Please quote the PO number on all delivery notes and invoices.", "Deliver to goods in, 7am to 4pm."], company: FIXTURE_COMPANY,
};

export const FIXTURE_DELIVERY_NOTE: DeliveryNotePdfData = {
  number: "DLN-1230", taxDate: "22/11/2026", shipDate: "22/11/2026", shipVia: "Own van", customerPo: "PO-778",
  billTo: ["Acme Fabrications Ltd", "1 Example Road", "Sheffield", "S1 1AA"], items: LINES.map((l) => ({ description: l.description, quantity: l.quantity })),
  signedByName: "A. Customer", signedDate: "23/11/2026", customerMessage: ["Goods checked on receipt."], company: FIXTURE_COMPANY,
};
