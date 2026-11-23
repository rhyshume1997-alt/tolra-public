/**
 * Module J: the list of printable designs. ADDING A DESIGN = one template file in this folder (a component taking a PdfDocumentData,
 * built on buildDocumentModel) + one entry below. Nothing else changes: the Settings picker, the live preview and the printing all read this list.
 *
 * Inputs: none. Outputs: DOCUMENT_DESIGNS (in the order the picker lists them) and designFor(id).
 * Must not change: the "classic" entry (it is components/pdf/BaseDocumentPDF.tsx, today's layout, and the fallback for any unknown or
 * removed id); an id once stored in a company's history must never be reused for a different look; the ids are lower-case slugs.
 */
import type { ComponentType } from "react";

import { BaseDocumentPDF, type PdfDocumentData } from "@/components/pdf/BaseDocumentPDF";
import { MinimalDocument } from "@/components/pdf/templates/minimal";
import { ModernDocument } from "@/components/pdf/templates/modern";
import { DEFAULT_DESIGN_ID } from "@/lib/document-templates/document-template-settings";

export type DocumentDesign = {
  id: string;
  label: string;
  description: string;
  Component: ComponentType<{ data: PdfDocumentData }>;
};

export const DOCUMENT_DESIGNS: readonly DocumentDesign[] = [
  { id: "classic", label: "Classic", description: "The layout your documents have always had: boxed key details, ruled table, black and white.", Component: BaseDocumentPDF },
  { id: "modern", label: "Modern", description: "Your brand colour on the title, rule and table heading; logo top left; soft row lines.", Component: ModernDocument },
  { id: "minimal", label: "Minimal", description: "Light and spacious: no boxes, hairline rows, brand colour only on the title and total.", Component: MinimalDocument },
];

/** The design for an id; anything unknown (a removed design, a bad value) is the classic layout. */
export function designFor(id: string | null | undefined): DocumentDesign {
  return DOCUMENT_DESIGNS.find((design) => design.id === id) ?? (DOCUMENT_DESIGNS.find((design) => design.id === DEFAULT_DESIGN_ID) as DocumentDesign);
}
