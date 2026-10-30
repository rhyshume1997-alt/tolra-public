/**
 * The totals an invoice shows on screen (audit A3). Same inputs and rules as its PDF: the invoice's own "Add VAT"
 * and carriage-VAT settings, and the company as it was when the invoice was issued (issuer snapshot, migration 019),
 * so a later change to VAT registration or the standard rate never changes an issued invoice's amounts.
 *
 * Drafts follow the CURRENT company settings, even though saving a draft also stores a snapshot (create/update_with_lines,
 * migration 021): issue_invoice (027) checks the totals at the current standard VAT rate and replaces the snapshot with
 * the current one, so a draft's saved snapshot is never what it is issued with. Pre-019 invoices have no snapshot and
 * follow the current profile too. The details panel, the totals check and the PDF all take the company from
 * invoiceIssuer, so they can't disagree.
 */
import type { PdfLineItem } from "@/components/pdf/BaseDocumentPDF";
import { resolvePdfTotals } from "@/components/pdf/pdf-totals";
import type { CompanyProfile } from "@/lib/company";
import { issuedCompany } from "@/lib/document-snapshot";
import { invoiceStatus } from "@/lib/receivables";

export type InvoiceVatSettings = {
  carriage: number;
  /** The invoice's own "Add VAT" switch (vat_enabled). */
  vatEnabled: boolean;
  /** Carriage taxed at the standard rate (carriage_vat). */
  carriageVat: boolean;
  /** Issuer details recorded when last saved or issued (ignored while the invoice is a draft); absent on older invoices. */
  issuerSnapshot?: unknown;
  /** invoices.status as stored ("draft" until issued; null or missing also means draft, as on the server). */
  rawStatus?: string | null;
};

/** The company an invoice is shown and printed with: current settings for a draft, the issue-time snapshot otherwise. */
export function invoiceIssuer(invoice: Pick<InvoiceVatSettings, "issuerSnapshot" | "rawStatus">, current: CompanyProfile): CompanyProfile {
  return invoiceStatus(invoice.rawStatus) === "draft" ? current : issuedCompany(current, invoice.issuerSnapshot);
}

/** Before the profile has loaded: registered at 20%, as companyVat(null). */
const PROFILE_LOADING = { vatRegistered: true, defaultVatRate: 20 } as const;

export function invoiceDisplayTotals(invoice: InvoiceVatSettings, lines: PdfLineItem[], current: CompanyProfile | null | undefined) {
  const company = current ? invoiceIssuer(invoice, current) : PROFILE_LOADING;
  return resolvePdfTotals({ lineItems: lines, carriage: invoice.carriage, showVat: invoice.vatEnabled, carriageVat: invoice.carriageVat }, company);
}
