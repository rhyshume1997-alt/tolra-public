import { BaseDocumentPDF, type PdfDocumentData, type PdfKeyValue, type PdfLineItem } from "@/components/pdf/BaseDocumentPDF";
import { type CompanyProfile, getCompanyProfile } from "@/lib/company";
import { customerPoKeyValue } from "@/lib/customer-po";

export type QuotePdfData = {
  /** QUO-####. */
  number: string;
  date: string;
  /** Defaults to the company's standard quote terms ("Valid for 7 days"). */
  terms?: string;
  billTo: string[];
  deliverTo?: string[];
  lineItems: PdfLineItem[];
  carriage?: number;
  /** "Add VAT" on this document. Defaults to on. */
  vatEnabled?: boolean;
  /** Carriage carries VAT at the standard rate (documents created with the VAT options). */
  carriageVat?: boolean;
  /** Customer-facing lines only. Never pass internal notes. */
  customerMessage?: string[];
  /** Printed valid-until date. "" or absent omits the Valid Until line (the Terms line still states the period), matching the on-screen quote. */
  validUntil?: string;
  /** Customer-facing scope of work (the quote's description). */
  scope?: string;
  /** The customer's own PO (migration 123): printed as "Customer PO" beside the quote number, only when there is one. */
  customerPo?: string;
  company?: CompanyProfile;
  logoSrc?: string;
  /** Stored totals of the record: rendering refuses lines that don't add up to them (lib/document-integrity). */
  storedTotals?: PdfDocumentData["storedTotals"];
};

/**
 * Header rows of a quote: number, the customer's PO (only when there is one), date, validity (only when a date is stored: never "Not
 * set" beside "Valid for N days") and terms. At most five rows, the key/value box's room.
 */
export function quoteKeyValues(data: Pick<QuotePdfData, "number" | "date" | "validUntil" | "terms" | "customerPo">, company: Pick<CompanyProfile, "defaultQuoteTerms">): PdfKeyValue[] {
  return [
    { label: "Our Quote No.", value: data.number },
    ...customerPoKeyValue(data.customerPo),
    { label: "Date", value: data.date },
    ...(data.validUntil?.trim() ? [{ label: "Valid Until", value: data.validUntil }] : []),
    { label: "Terms", value: data.terms || company.defaultQuoteTerms },
  ];
}

/** Message block: the scope first, then the given customer lines (or the company's standard ones). */
export function quoteMessage(data: Pick<QuotePdfData, "scope" | "customerMessage">, company: Pick<CompanyProfile, "defaultCustomerMessage">): string[] {
  const lines = data.customerMessage ?? company.defaultCustomerMessage;
  return data.scope?.trim() ? [`Scope: ${data.scope.trim()}`, ...lines] : lines;
}

export function QuotePDF({ data }: { data: QuotePdfData }) {
  const company = data.company ?? getCompanyProfile();
  return (
    <BaseDocumentPDF
      data={{
        title: "Quote",
        documentNumber: data.number,
        keyValues: quoteKeyValues(data, company),
        billToLabel: "Quote To:",
        billTo: data.billTo,
        deliverTo: data.deliverTo ?? data.billTo,
        lineItems: data.lineItems,
        carriage: data.carriage,
        showVat: data.vatEnabled !== false,
        carriageVat: data.carriageVat,
        customerMessage: quoteMessage(data, company),
        company,
        logoSrc: data.logoSrc,
        storedTotals: data.storedTotals,
      }}
    />
  );
}
