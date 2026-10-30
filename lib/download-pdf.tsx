"use client";

import type { AuditTable } from "@/lib/audit-contract";
import type { ReactElement } from "react";
import { type DocumentProps, pdf } from "@react-pdf/renderer";
import { toast } from "sonner";

import { auditEvent } from "@/lib/audit";
import { CompanyProfileMissingError } from "@/lib/company";
import { DocumentTotalsMismatchError } from "@/lib/document-integrity";
import { friendlyError } from "@/lib/friendly-error";

/** Message safe to show when a PDF can't be built. A missing company profile has its own friendly text. */
export function pdfErrorMessage(error: unknown) {
  if (error instanceof CompanyProfileMissingError || error instanceof DocumentTotalsMismatchError) return error.message;
  return friendlyError(error, "Couldn't generate the PDF. Try again.");
}

/**
 * Builds and downloads a PDF. `source` is either the document element or an async builder, so callers can
 * await requireCompanyProfile() and load their data inside it and have every failure toasted the same way.
 * Resolves true when the file was handed to the browser, false when it failed (already toasted). `silent` skips the success toast.
 */
export async function downloadPdf(
  source: ReactElement | (() => Promise<ReactElement>),
  filename: string,
  audit: { entityTable: AuditTable; entityId: string | number },
  options: { silent?: boolean } = {},
): Promise<boolean> {
  try {
    const element = typeof source === "function" ? await source() : source;
    // Every caller's element renders a <Document> (React 19 types no longer infer that from ReactElement).
    const blob = await pdf(element as ReactElement<DocumentProps>).toBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    void auditEvent({ action: "DOWNLOAD_PDF", entityTable: audit.entityTable, entityId: audit.entityId, metadata: { filename } });
    if (!options.silent) toast.success("PDF downloaded");
    return true;
  } catch (error) {
    toast.error(pdfErrorMessage(error));
    return false;
  }
}

/** The PDF of a document element as a Blob (for attaching to a one-click e-mail, components/email/send-email-button). */
export async function pdfBlob(element: ReactElement): Promise<Blob> {
  return pdf(element as ReactElement<DocumentProps>).toBlob();
}

/** Opens the user's email client with a draft to `to`. The PDF can't be attached from a mailto: link, so callers also download it. */
export function openMailDraft(to: string, subject: string, body: string) {
  const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const link = document.createElement("a");
  link.href = href;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
