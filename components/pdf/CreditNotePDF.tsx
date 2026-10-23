import { BaseDocumentPDF, type PdfDocumentData, type PdfKeyValue, type PdfLineItem } from "@/components/pdf/BaseDocumentPDF";
import { type CompanyProfile, getCompanyProfile } from "@/lib/company";

export type CreditNotePdfData = {
  /** CRD-#### (078; CN-#### on credit notes issued before it). */
  number: string;
  date: string;
  /** The invoice it credits (INV-####): printed in the box with the number and date. */
  invoiceRef: string;
  billTo: string[];
  lineItems: PdfLineItem[];
  /** "Add VAT" on the invoice it credits. Defaults to on. */
  vatEnabled?: boolean;
  /** Why the credit is given: printed in the box where invoices print their closing message. */
  reason?: string;
  company?: CompanyProfile;
  logoSrc?: string;
  storedTotals?: PdfDocumentData["storedTotals"];
};

/** A credit note prints on the invoice layout with the title "Credit Note": the same box, address blocks, table and totals. */
export function CreditNotePDF({ data }: { data: CreditNotePdfData }) {
  const company = data.company ?? getCompanyProfile();
  const keyValues: PdfKeyValue[] = [
    { label: "Credit Note No.", value: data.number },
    { label: "Date", value: data.date },
    { label: "Invoice No.", value: data.invoiceRef },
  ];
  return (
    <BaseDocumentPDF
      data={{
        title: "Credit Note",
        documentNumber: data.number,
        keyValues,
        billToLabel: "Credit To:",
        billTo: data.billTo,
        deliverTo: data.billTo,
        lineItems: data.lineItems,
        showVat: data.vatEnabled !== false,
        customerMessageTitle: "Reason",
        customerMessage: data.reason ? data.reason.split(/\r?\n/).filter(Boolean) : [],
        company,
        logoSrc: data.logoSrc,
        storedTotals: data.storedTotals,
      }}
    />
  );
}
