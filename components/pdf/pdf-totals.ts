/**
 * The totals a printed document shows, without the PDF renderer: pages, the invoice details panel (lib/invoice-totals.ts) and
 * the stored-totals check import these from here, so @react-pdf/renderer is only loaded when a PDF is made
 * (components/pdf/BaseDocumentPDF.tsx re-exports them for the documents themselves).
 */
import type { PdfDocumentData, PdfTotals } from "@/components/pdf/BaseDocumentPDF";
import { type CompanyProfile, getCompanyProfile } from "@/lib/company";
import { totalsMismatch } from "@/lib/document-integrity";
import { documentTotals, fromPence, toPence } from "@/lib/money";

/**
 * Subtotal, VAT (rounded per line), carriage, total and balance due. Delegates to documentTotals in lib/money.ts
 * so the quote builder preview, the saved totals and the PDF can never drift apart.
 */
export function computePdfTotals(data: Pick<PdfDocumentData, "lineItems" | "showVat" | "carriage" | "payments" | "credits" | "carriageVat" | "standardVatRate">): PdfTotals {
  const totals = documentTotals(
    data.lineItems.map((item) => ({ quantity: item.quantity, unitPrice: item.unitPrice ?? 0, vatPct: item.vatPct, vatExempt: item.vatExempt, vatAmount: item.vatAmount })),
    data.carriage ?? 0,
    { vatEnabled: data.showVat !== false, carriageVat: data.carriageVat, standardRate: data.standardVatRate ?? 20 },
  );
  const payments = data.payments === undefined ? null : fromPence(toPence(data.payments));
  const balance = fromPence(toPence(totals.total) - toPence(payments ?? 0) - toPence(payments === null ? 0 : data.credits ?? 0));
  return { subtotal: totals.subtotal, carriage: totals.carriage, vat: totals.vat, total: totals.total, payments, balance, vatBreakdown: totals.vatBreakdown };
}

type TotalsInput = Pick<PdfDocumentData, "lineItems" | "showVat" | "carriage" | "carriageVat" | "standardVatRate" | "company" | "columns" | "storedTotals">;

/**
 * The VAT switch, standard rate and totals a document prints with, from the document's own settings and the printing
 * company (for an issued document, its issue-time snapshot). One place, so the printed totals, the stored-totals check
 * and on-screen copies of them (the invoice details panel) can never disagree.
 */
export function resolvePdfTotals(
  data: Pick<PdfDocumentData, "lineItems" | "showVat" | "carriage" | "carriageVat" | "standardVatRate" | "columns" | "payments" | "credits">,
  company: Pick<CompanyProfile, "vatRegistered" | "defaultVatRate">,
) {
  // A company that isn't VAT registered never prints VAT, whatever the document says.
  const showVat = (data.columns ?? "priced") === "priced" && data.showVat !== false && company.vatRegistered !== false;
  const standardVatRate = data.standardVatRate ?? company.defaultVatRate ?? 20;
  return { showVat, standardVatRate, totals: computePdfTotals({ ...data, showVat, standardVatRate }) };
}

/**
 * The reason a document can't be rendered from its lines (they don't add up to the totals stored on the record), or
 * null. Same VAT and rounding rules as the printed totals. Callers check it first to explain; rendering enforces it.
 */
export function storedTotalsProblem(data: TotalsInput) {
  if (!data.storedTotals) return null;
  const { totals } = resolvePdfTotals(data, data.company ?? getCompanyProfile());
  const { reference, issued, ...stored } = data.storedTotals;
  return totalsMismatch(reference, stored, totals, issued);
}
