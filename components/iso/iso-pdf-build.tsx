/**
 * BOUNDARY (module 9, ISO templates). Inputs: a FilledDocument (lib/iso/fill.ts, or lib/iso/editable-document.ts effectiveDocument) and the logo.
 * Output: the PDF bytes for that one document (react-pdf is loaded only when called). Used by the pack page and the editor so both print the same way.
 * Must not change: it adds no wording and reads nothing; the header and footer come from the FilledDocument.
 */
import type { FilledDocument } from "@/lib/iso/fill";

export async function isoDocumentPdfBytes(doc: FilledDocument, logoSrc?: string): Promise<Uint8Array> {
  const [{ pdf }, { IsoDocumentPDF }] = await Promise.all([import("@react-pdf/renderer"), import("@/components/iso/iso-document-pdf")]);
  const blob = await pdf(<IsoDocumentPDF doc={doc} logoSrc={logoSrc} /> as never).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}
