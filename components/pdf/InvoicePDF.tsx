import { BaseDocumentPDF, type PdfDocumentData, type PdfKeyValue, type PdfLineItem } from "@/components/pdf/BaseDocumentPDF";
import { paymentDetailRows } from "@/lib/bank-details";
import { type CompanyProfile, getCompanyProfile, invoiceMessage } from "@/lib/company";
import { customerPoKeyValue } from "@/lib/customer-po";
import type { PdfCustomerSignOff } from "@/lib/customer-signoff-print";
import { gbp } from "@/lib/money";

export type InvoicePdfData = {
  /** INV-####. */
  number: string;
  date: string;
  /** Date of supply when it differs from `date`: printed as "Tax Point". Omit, or give the same date, and nothing is added. */
  taxPoint?: string;
  /** Defaults to the company's standard invoice terms ("30 days"). */
  terms?: string;
  /** Our quote number (QUO-####), when the invoice came from a quote. */
  quoteRef?: string;
  /** The customer's own purchase order number. */
  customerPo?: string;
  /** Delivery note numbers on this invoice ("DLN-0001, DLN-0002 +1 more"); printed as "Delivery Notes" only when there are some and the key/value box has room (at most 5 rows). */
  deliveryNotes?: string;
  billTo: string[];
  /** The invoice's delivery address (migration 073). Omit and the invoice address prints under Deliver To, as before. */
  deliverTo?: string[];
  /** The invoice's one-line note (migration 073): printed first in the message box. Omit and the box is exactly as it was. */
  note?: string;
  lineItems: PdfLineItem[];
  carriage?: number;
  /** "Add VAT" on this document. Defaults to on. */
  vatEnabled?: boolean;
  /** Carriage carries VAT at the standard rate (documents created with the VAT options). */
  carriageVat?: boolean;
  /** Amount already paid. Omit for none. */
  payments?: number;
  /** Credit notes applied (only passed when the company shows them): reduces Balance due and adds one "Less credit notes" line to the box. */
  credits?: number;
  /** Prints the PAID watermark. */
  paid?: boolean;
  /** The amount paid isn't known (payment to confirm, or marked paid with no amount recorded): print the Total only, no Paid or Balance due rows. */
  paymentUnknown?: boolean;
  customerMessage?: string[];
  /** The customer sign-off (072) of the job its delivery notes are on, when there is one: a small block under the message box. */
  customerSignOff?: PdfCustomerSignOff;
  company?: CompanyProfile;
  logoSrc?: string;
  /** Stored totals of the record: rendering refuses lines that don't add up to them (lib/document-integrity). */
  storedTotals?: PdfDocumentData["storedTotals"];
};

/** Rows the key/value box can hold before it runs into the address blocks (BaseDocumentPDF: top 71, 17.3pt rows, address at 174). */
export const MAX_KEY_VALUE_ROWS = 5;

export function InvoicePDF({ data }: { data: InvoicePdfData }) {
  const company = data.company ?? getCompanyProfile();
  const keyValues: PdfKeyValue[] = [
    { label: "Invoice No.", value: data.number },
    { label: "Date", value: data.date },
    // Only when a supply date is set and is not the invoice date; otherwise the block is exactly as it was.
    ...(data.taxPoint && data.taxPoint !== data.date ? [{ label: "Tax Point", value: data.taxPoint }] : []),
    // Only when the company's setting is on and a credit has been applied; otherwise the block is exactly as it was.
    ...(data.credits && data.credits > 0 && !data.paymentUnknown ? [{ label: "Less credit notes", value: gbp(data.credits, 2) }] : []),
    { label: "Terms", value: data.terms || company.defaultInvoiceTerms },
    ...(data.quoteRef ? [{ label: "Our Quote No.", value: data.quoteRef }] : []),
    ...customerPoKeyValue(data.customerPo),
  ];
  // The key/value box is a fixed 17.3pt per row above the address blocks: five rows fill it, a sixth would overlap "Bill To".
  // So the delivery notes row is printed only when there is a free row, and is dropped otherwise.
  if (data.deliveryNotes && keyValues.length < MAX_KEY_VALUE_ROWS) keyValues.push({ label: "Delivery Notes", value: data.deliveryNotes });
  return (
    <BaseDocumentPDF
      data={{
        title: "Invoice",
        documentNumber: data.number,
        keyValues,
        billToLabel: "Invoice To:",
        billTo: data.billTo,
        deliverTo: data.deliverTo ?? data.billTo,
        lineItems: data.lineItems,
        carriage: data.carriage,
        showVat: data.vatEnabled !== false,
        carriageVat: data.carriageVat,
        payments: data.paymentUnknown ? undefined : data.payments ?? 0,
        credits: data.paymentUnknown ? undefined : data.credits,
        paid: data.paymentUnknown ? false : data.paid,
        // Invoices have their own closing lines, never the quote wording (company_profile.defaultInvoiceMessage).
        customerMessage: data.note?.trim() ? [data.note.trim(), ...(data.customerMessage ?? invoiceMessage(company, data.terms))] : data.customerMessage ?? invoiceMessage(company, data.terms),
        // Invoices only: quotes and the other documents never print bank details.
        paymentDetails: paymentDetailRows(company.bankDetails),
        customerSignOff: data.customerSignOff,
        company,
        logoSrc: data.logoSrc,
        storedTotals: data.storedTotals,
      }}
    />
  );
}
