import { BaseDocumentPDF, type PdfKeyValue, type PdfLineItem } from "@/components/pdf/BaseDocumentPDF";
import { type CompanyProfile, getCompanyProfile } from "@/lib/company";

export type PurchaseOrderPdfData = {
  number: string;
  date: string;
  requiredBy?: string;
  /** Supplier name and address lines. */
  supplier: string[];
  /** Defaults to the issuing company's name and address. */
  deliverTo?: string[];
  /** Unit prices are ex VAT. */
  lineItems: PdfLineItem[];
  notes?: string[];
  /** "Add VAT" on this document. Defaults to off: sales orders and POs used to be ex VAT. */
  vatEnabled?: boolean;
  company?: CompanyProfile;
  logoSrc?: string;
};

export function PurchaseOrderPDF({ data }: { data: PurchaseOrderPdfData }) {
  const company = data.company ?? getCompanyProfile();
  const keyValues: PdfKeyValue[] = [
    { label: "PO No.", value: data.number },
    { label: "Date", value: data.date },
    { label: "Required By", value: data.requiredBy ?? "" },
  ];
  return (
    <BaseDocumentPDF
      data={{
        title: "Purchase Order",
        documentNumber: data.number,
        keyValues,
        billToLabel: "Supplier:",
        billTo: data.supplier,
        deliverTo: data.deliverTo ?? [company.documentName, ...company.addressLines],
        showVat: data.vatEnabled === true,
        lineItems: data.lineItems,
        customerMessageTitle: "Notes",
        customerMessage: data.notes?.length ? data.notes : ["Please quote the PO number on all delivery notes and invoices."],
        company,
        logoSrc: data.logoSrc,
      }}
    />
  );
}
