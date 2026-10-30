"use client";

import type { AuditTable } from "@/lib/audit-contract";
import type { ReactElement } from "react";
import type { DocumentProps } from "@react-pdf/renderer";
import { toast } from "sonner";

import { auditEvent } from "@/lib/audit";
import { CompanyProfileMissingError } from "@/lib/company";
import { DocumentTotalsMismatchError } from "@/lib/document-integrity";
import { friendlyError } from "@/lib/friendly-error";

/** Shown when the PDF code (loaded on the first PDF, not with the page) cannot be fetched because the device is offline. */
export const PDF_OFFLINE_MESSAGE = "PDF needs an internet connection to load. Connect and try again.";

/** The bundler's or the browser's answer when a lazily loaded file could not be fetched (webpack ChunkLoadError, native import()). */
const CHUNK_LOAD_FAILED = /Loading (css )?chunk \S+ failed|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** True when making the PDF failed because its code could not be loaded: the device says it is offline, or the import itself failed. */
export function pdfCodeUnreachable(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_LOAD_FAILED.test(error.message);
}

/** Message safe to show when a PDF can't be built. A missing company profile has its own friendly text. */
export function pdfErrorMessage(error: unknown) {
  if (error instanceof CompanyProfileMissingError || error instanceof DocumentTotalsMismatchError) return error.message;
  if (pdfCodeUnreachable(error)) return PDF_OFFLINE_MESSAGE;
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
    // Loaded on the first PDF, not with the page (it is the largest library in the app).
    const { pdf } = await import("@react-pdf/renderer");
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

/** Opens the user's email client with a draft to `to`. The PDF can't be attached from a mailto: link, so callers also download it. */
export function openMailDraft(to: string, subject: string, body: string) {
  const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const link = document.createElement("a");
  link.href = href;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
