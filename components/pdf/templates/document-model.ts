/**
 * Module J: the one place every NON-classic design gets what it prints from. Pure (no PDF renderer): it turns a PdfDocumentData into
 * ready-to-print text, so a design only decides how things look, never what they say.
 *
 * Inputs: a PdfDocumentData (components/pdf/BaseDocumentPDF.tsx). Outputs: a DocumentModel with every figure, label, payment detail,
 * closing line and message already worked out by the SAME functions the classic layout uses (resolvePdfTotals, finalTotalRows, the table
 * cells and headings, paymentDetails, the stored-totals check). A design that prints only what is in the model cannot change a number,
 * VAT line, total, bank detail, payment wording or document number.
 * Must not change: it must keep calling the shared functions rather than re-working any amount, and must keep refusing a document
 * whose lines do not add up to its stored totals (the same error as the classic layout).
 */
import {
  cells, columnWidths, finalTotalRows, headings, money, type PdfColumns, type PdfDocumentData,
} from "@/components/pdf/BaseDocumentPDF";
import { resolvePdfTotals, storedTotalsProblem } from "@/components/pdf/pdf-totals";
import { footerContactRows, getCompanyProfile, type CompanyProfile } from "@/lib/company";
import { vatRowLabel } from "@/lib/money";

export type ModelTotalRow = { label: string; value: string; bold: boolean };

export type DocumentModel = {
  company: CompanyProfile;
  title: string;
  documentNumber: string;
  keyValues: PdfDocumentData["keyValues"];
  billToLabel: string;
  billTo: string[];
  deliverToLabel: string;
  deliverTo: string[];
  columns: PdfColumns;
  priced: boolean;
  showVat: boolean;
  /** Column headings and each line's cell text, in print order (the same text the classic table prints). */
  heads: string[];
  widths: number[];
  rows: string[][];
  /** The totals block, top to bottom (empty for a quantity-only document such as a delivery note). */
  totalRows: ModelTotalRow[];
  messageTitle: string;
  message: string[];
  paymentDetails: Array<{ label: string; value: string }>;
  customerSignOff: PdfDocumentData["customerSignOff"];
  closingLines: string[];
  /** True when the PAID watermark prints (the document says paid and its own balance due is nil). */
  paidWatermark: boolean;
  logo: string | undefined;
  footerContacts: Array<[string, string]>;
};

export function buildDocumentModel(data: PdfDocumentData): DocumentModel {
  const company = data.company ?? getCompanyProfile();
  const columns = data.columns ?? "priced";
  const priced = columns === "priced";
  const { showVat, standardVatRate, totals } = resolvePdfTotals(data, company);
  const mismatch = storedTotalsProblem(data);
  if (mismatch) throw mismatch;
  const vatRows = totals.vatBreakdown.filter((row) => !row.exempt);

  const totalRows: ModelTotalRow[] = [];
  if (priced) {
    totalRows.push({ label: "Subtotal:", value: money(totals.subtotal), bold: false }, { label: "Carriage:", value: money(totals.carriage), bold: false });
    if (showVat && vatRows.length > 1) for (const row of vatRows) totalRows.push({ label: `${vatRowLabel(row)}:`, value: money(row.vat), bold: false });
    if (showVat && vatRows.length <= 1) totalRows.push({ label: vatRows.length === 1 ? `${vatRowLabel(vatRows[0])}:` : "VAT:", value: money(totals.vat), bold: false });
    for (const row of finalTotalRows(totals)) totalRows.push({ label: `${row.label}:`, value: money(row.value), bold: row.bold });
  }

  return {
    company,
    title: data.title,
    documentNumber: data.documentNumber,
    keyValues: data.keyValues,
    billToLabel: data.billToLabel,
    billTo: data.billTo,
    deliverToLabel: data.deliverToLabel ?? "Deliver To:",
    deliverTo: data.deliverTo,
    columns,
    priced,
    showVat,
    heads: headings(columns, showVat),
    widths: columnWidths(columns, showVat),
    rows: data.lineItems.map((item) => cells(item, columns, showVat, standardVatRate)),
    totalRows,
    messageTitle: data.customerMessageTitle ?? "Customer Message",
    message: data.customerMessage ?? company.defaultCustomerMessage,
    paymentDetails: data.paymentDetails ?? [],
    customerSignOff: data.customerSignOff,
    closingLines: data.closingLines ?? [],
    paidWatermark: Boolean(data.paid) && totals.payments !== null && totals.balance <= 0,
    logo: data.logoSrc ?? company.logoSrc,
    footerContacts: footerContactRows(company),
  };
}

/** The company's brand colour for designs that use one: its primary colour, else a neutral navy. Always a valid #rrggbb. */
export const FALLBACK_BRAND = "#1e3472";
export const brandColour = (company: Pick<CompanyProfile, "brandPrimary">): string => (/^#[0-9a-f]{6}$/i.test(company.brandPrimary) ? company.brandPrimary.toLowerCase() : FALLBACK_BRAND);

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function inkOn(hex: string): "#000000" | "#ffffff" {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
