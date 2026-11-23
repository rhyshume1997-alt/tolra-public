import type { PdfKeyValue, PdfLineItem } from "@/components/pdf/BaseDocumentPDF";
import { DocumentPDF } from "@/components/pdf/templates/document-pdf";
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
  /** When the order was issued (ISO date or date-time), so it prints in the design in force then (module J). Omit for a draft: it prints in the current design. */
  issuedAt?: string;
  /** Forces a design (the Settings preview only). */
  design?: string;
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
    <DocumentPDF
      type="purchase_order"
      issuedAt={data.issuedAt}
      design={data.design}
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
