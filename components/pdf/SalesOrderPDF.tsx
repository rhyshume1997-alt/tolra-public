import { BaseDocumentPDF, type PdfKeyValue, type PdfLineItem } from "@/components/pdf/BaseDocumentPDF";
import { type CompanyProfile, getCompanyProfile } from "@/lib/company";

export type SalesOrderPdfData = {
  /** The customer's own purchase order number (for example 4567 or PO1234). */
  number: string;
  date: string;
  deliveryDate?: string;
  quoteRef?: string;
  billTo: string[];
  deliverTo?: string[];
  /** Unit prices are ex VAT. */
  lineItems: PdfLineItem[];
  notes?: string[];
  /** "Add VAT" on this document. Defaults to off: sales orders and POs used to be ex VAT. */
  vatEnabled?: boolean;
  company?: CompanyProfile;
  logoSrc?: string;
};

export function SalesOrderPDF({ data }: { data: SalesOrderPdfData }) {
  const keyValues: PdfKeyValue[] = [
    { label: "Your Order No.", value: data.number },
    { label: "Order Date", value: data.date },
    { label: "Delivery", value: data.deliveryDate ?? "" },
    ...(data.quoteRef ? [{ label: "Our Quote No.", value: data.quoteRef }] : []),
  ];
  return (
    <BaseDocumentPDF
      data={{
        title: "Sales Order",
        documentNumber: data.number,
        keyValues,
        billToLabel: "Customer:",
        billTo: data.billTo,
        deliverTo: data.deliverTo ?? data.billTo,
        showVat: data.vatEnabled === true,
        lineItems: data.lineItems,
        customerMessageTitle: "Notes",
        customerMessage: data.notes?.length ? data.notes : ["Please use the order number as Ref"],
        company: data.company ?? getCompanyProfile(),
        logoSrc: data.logoSrc,
      }}
    />
  );
}
