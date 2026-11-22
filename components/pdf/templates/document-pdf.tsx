import type { PdfDocumentData } from "@/components/pdf/BaseDocumentPDF";
import { designFor } from "@/components/pdf/templates/registry";
import { getCompanyProfile } from "@/lib/company";
import { type DocumentType, resolveDesignId } from "@/lib/document-templates/document-template-settings";

/**
 * Module J: prints a document in the company's chosen design. Inputs: the document type, its PdfDocumentData, optionally `issuedAt` (when
 * the document was issued: an ISO date or date-time; omit for a document not issued yet) and `design` (an explicit design id, used by the
 * Settings preview only). Output: the design's react-pdf <Document>.
 * The design is the one in force on the day the document was issued (lib/document-templates), so an issued document never changes when a
 * company picks a new design. Off, nothing chosen, or an unknown id: the classic layout, exactly as before.
 * Must not change: the default path (it must render BaseDocumentPDF with the same data), and it must never alter the data it is given.
 */
const LONG_AGO = "1970-01-01T00:00:00Z";

export function DocumentPDF({ type, data, issuedAt, design }: { type: DocumentType; data: PdfDocumentData; issuedAt?: string | null; design?: string | null }) {
  const company = data.company ?? getCompanyProfile();
  // The issue date: given by the caller, else when the document's issuer snapshot was captured. A quote or invoice that is issued but has
  // no recorded date (imported, or issued before snapshots) counts as issued long ago, so it keeps the classic design and never changes.
  const when = issuedAt ?? company.issuedAt ?? (data.storedTotals?.issued ? LONG_AGO : undefined);
  const id = design ?? resolveDesignId(company.documentTemplates, type, when);
  const { Component } = designFor(id);
  return <Component data={data} />;
}
