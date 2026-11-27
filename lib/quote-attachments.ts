/**
 * Inputs: quote attachment read/upload client, quote reference, file metadata, and organization context.
 * Outputs: registered quote attachment rows and atomic upload+registration with compensating storage cleanup on DB insert failure.
 * Boundary: Module 3 (Quotes) only; preserves listQuoteAttachments pre-067 fallback and does not alter storage buckets or other modules.
 */
import { missingDbObject } from "@/lib/db-features";
import { ValidationError } from "@/lib/validation/schemas";

export type QuoteAttachmentRow = { id: string; file_path: string; file_name: string; size_bytes: number | null; created_at: string; kind?: string };

const BEFORE_067 = "id, file_path, file_name, size_bytes, created_at";
const WITH_KIND = `${BEFORE_067}, kind`;

type Result = { data: unknown; error: { code?: string; message?: string } | null };
/** The part of the Supabase client used here (so the fallback can be tested without a database). */
export type QuoteAttachmentReader = { from(table: "quote_attachments"): { select(columns: string): { eq(column: "quote_ref", value: string): { order(column: "created_at", options: { ascending: boolean }): PromiseLike<Result> } } } };

export type QuoteAttachmentUploader = {
  storage: {
    from(bucket: "quote-attachments"): {
      upload(path: string, file: File, options?: { contentType?: string }): Promise<{ error: { message?: string } | null }>;
      remove(paths: string[]): Promise<{ error: { message?: string } | null }>;
    };
  };
  from(table: "quote_attachments"): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: { code?: string; message?: string; hint?: string } | null }>;
  };
};

export async function listQuoteAttachments(client: QuoteAttachmentReader, quoteRef: string): Promise<{ files: QuoteAttachmentRow[]; customerPoSupported: boolean }> {
  const read = (columns: string) => client.from("quote_attachments").select(columns).eq("quote_ref", quoteRef).order("created_at", { ascending: false });
  const first = await read(WITH_KIND);
  if (!first.error) return { files: (first.data ?? []) as QuoteAttachmentRow[], customerPoSupported: true };
  if (!missingDbObject(first.error)) throw first.error;
  const plain = await read(BEFORE_067);
  if (plain.error) throw plain.error;
  return { files: (plain.data ?? []) as QuoteAttachmentRow[], customerPoSupported: false };
}

/**
 * Uploads one quote attachment to storage and registers its quote_attachments row.
 * If database registration fails, removes the uploaded object from storage so no unregistered file is left behind;
 * if cleanup also fails, surfaces an explicit error so staff know manual cleanup may be required.
 */
export async function uploadQuoteAttachment(
  client: QuoteAttachmentUploader,
  params: {
    organizationId: string;
    quoteRef: string;
    file: File;
    uploadedBy: string | null;
    kind: "file" | "customer_po";
    now?: () => number;
  },
): Promise<{ path: string }> {
  const { organizationId, quoteRef, file, uploadedBy, kind, now = Date.now } = params;
  const safeName = file.name.replace(/[^\w.\- ()]+/g, "_");
  let path = `${organizationId}/${quoteRef}/${safeName}`;
  const bucket = client.storage.from("quote-attachments");
  let result = await bucket.upload(path, file, { contentType: file.type || undefined });
  if (result.error && /exists|duplicate/i.test(result.error.message ?? "")) {
    path = `${organizationId}/${quoteRef}/${now()}-${safeName}`;
    result = await bucket.upload(path, file, { contentType: file.type || undefined });
  }
  if (result.error) {
    if (/bucket.*not found/i.test(result.error.message ?? "")) {
      throw new ValidationError("File storage is not set up yet. Ask an admin to create the quote-attachments bucket.");
    }
    throw result.error;
  }

  const { error } = await client.from("quote_attachments").insert({
    organization_id: organizationId,
    quote_ref: quoteRef,
    file_path: path,
    file_name: file.name,
    size_bytes: file.size,
    uploaded_by: uploadedBy,
    // The customer's PO travels to the job made from this quote (job pack); plain files keep the default.
    ...(kind === "customer_po" ? { kind } : {}),
  });

  if (error) {
    let cleanupFailed = false;
    try {
      const removed = await bucket.remove([path]);
      if (removed.error) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      if (typeof console !== "undefined") {
        console.error("[quote-attachments] failed to remove unregistered upload after DB insert error", path);
      }
      throw new ValidationError("The attachment could not be registered, and the uploaded file could not be removed automatically. Ask an admin to check quote-attachments storage.");
    }
    throw error;
  }

  return { path };
}
