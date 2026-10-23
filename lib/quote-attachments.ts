/**
 * A quote's attachment list. Migration 067 adds quote_attachments.kind ('file' or 'customer_po'); the app may be deployed before it
 * is applied, so the list is read with kind and, if the database doesn't have the column yet, read again exactly as before 067
 * (and "Upload customer PO" stays hidden).
 */
import { missingDbObject } from "@/lib/db-features";

export type QuoteAttachmentRow = { id: string; file_path: string; file_name: string; size_bytes: number | null; created_at: string; kind?: string };

const BEFORE_067 = "id, file_path, file_name, size_bytes, created_at";
const WITH_KIND = `${BEFORE_067}, kind`;

type Result = { data: unknown; error: { code?: string; message?: string } | null };
/** The part of the Supabase client used here (so the fallback can be tested without a database). */
export type QuoteAttachmentReader = { from(table: "quote_attachments"): { select(columns: string): { eq(column: "quote_ref", value: string): { order(column: "created_at", options: { ascending: boolean }): PromiseLike<Result> } } } };

export async function listQuoteAttachments(client: QuoteAttachmentReader, quoteRef: string): Promise<{ files: QuoteAttachmentRow[]; customerPoSupported: boolean }> {
  const read = (columns: string) => client.from("quote_attachments").select(columns).eq("quote_ref", quoteRef).order("created_at", { ascending: false });
  const first = await read(WITH_KIND);
  if (!first.error) return { files: (first.data ?? []) as QuoteAttachmentRow[], customerPoSupported: true };
  if (!missingDbObject(first.error)) throw first.error;
  const plain = await read(BEFORE_067);
  if (plain.error) throw plain.error;
  return { files: (plain.data ?? []) as QuoteAttachmentRow[], customerPoSupported: false };
}
