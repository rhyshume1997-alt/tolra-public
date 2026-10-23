import { BaseDocumentPDF } from "@/components/pdf/BaseDocumentPDF";
import { type CompanyProfile, getCompanyProfile } from "@/lib/company";
import type { PdfCustomerSignOff } from "@/lib/customer-signoff-print";

export type DeliveryNotePdfData = {
  /** DLN-####, the same number as the invoice (INV-0456 <-> DLN-0456). */
  number: string;
  taxDate: string;
  shipDate: string;
  shipVia?: string;
  billTo: string[];
  deliverTo?: string[];
  items: Array<{ description: string; quantity: number }>;
  customerMessage?: string[];
  /** The job's customer sign-off (072), when it has one: a small block under the message box. */
  customerSignOff?: PdfCustomerSignOff;
  company?: CompanyProfile;
  logoSrc?: string;
};

export function DeliveryNotePDF({ data }: { data: DeliveryNotePdfData }) {
  return (
    <BaseDocumentPDF
      data={{
        title: "Delivery Note",
        documentNumber: data.number,
        keyValues: [
          { label: "Delivery No.", value: data.number },
          { label: "Tax Date", value: data.taxDate },
          { label: "Ship Date", value: data.shipDate },
          { label: "Ship Via", value: data.shipVia ?? "" },
        ],
        billToLabel: "Invoice To:",
        billTo: data.billTo,
        deliverTo: data.deliverTo ?? data.billTo,
        columns: "qtyOnly",
        lineItems: data.items,
        customerMessage: data.customerMessage,
        customerSignOff: data.customerSignOff,
        company: data.company ?? getCompanyProfile(),
        logoSrc: data.logoSrc,
      }}
    />
  );
}
