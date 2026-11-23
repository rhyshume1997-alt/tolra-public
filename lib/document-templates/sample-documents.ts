/**
 * Module J: sample data for the Settings live preview. Inputs: the company profile (its own logo, brand colour, terms and bank details are used)
 * and a document type. Outputs: data for the real quote / invoice / purchase order / delivery note document components, so the preview
 * is the same code that prints real documents. Invented customers and figures only; nothing is read from or written to the database.
 * Must not change: it must stay pure and must never contain a real customer, price or number.
 */
import type { DeliveryNotePdfData } from "@/components/pdf/DeliveryNotePDF";
import type { InvoicePdfData } from "@/components/pdf/InvoicePDF";
import type { PurchaseOrderPdfData } from "@/components/pdf/PurchaseOrderPDF";
import type { QuotePdfData } from "@/components/pdf/QuotePDF";
import type { CompanyProfile } from "@/lib/company";
import type { DocumentType } from "@/lib/document-templates/document-template-settings";

const LINES = [
  { description: "Machined bracket, mild steel (sample item)", quantity: 25, unitPrice: 14.37 },
  { description: "Powder coating, per bracket (sample item)", quantity: 25, unitPrice: 2.1 },
  { description: "Packing and labelling (sample item)", quantity: 1, unitPrice: 18 },
];
const CUSTOMER = ["Sample Customer Ltd", "1 Example Street", "Exampleton", "AB1 2CD"];

export type SampleDocument =
  | { type: "quote"; data: QuotePdfData }
  | { type: "invoice"; data: InvoicePdfData }
  | { type: "purchase_order"; data: PurchaseOrderPdfData }
  | { type: "delivery_note"; data: DeliveryNotePdfData };

export function sampleDocument(type: DocumentType, company: CompanyProfile, design: string): SampleDocument {
  const base = { company, design };
  switch (type) {
    case "quote":
      return { type, data: { ...base, number: "QUO-0001", date: "01/01/2027", validUntil: "31/01/2027", billTo: CUSTOMER, lineItems: LINES, carriage: 10, vatEnabled: true } };
    case "invoice":
      return { type, data: { ...base, number: "INV-0001", date: "01/01/2027", billTo: CUSTOMER, lineItems: LINES, carriage: 10, vatEnabled: true, payments: 100 } };
    case "purchase_order":
      return { type, data: { ...base, number: "PO-0001", date: "01/01/2027", requiredBy: "08/01/2027", supplier: ["Sample Supplier Ltd", "2 Example Lane", "Exampleton"], lineItems: LINES, vatEnabled: true } };
    case "delivery_note":
      return { type, data: { ...base, number: "DLN-0001", taxDate: "01/01/2027", shipDate: "01/01/2027", shipVia: "Own van", billTo: CUSTOMER, items: LINES.map((l) => ({ description: l.description, quantity: l.quantity })) } };
  }
}
