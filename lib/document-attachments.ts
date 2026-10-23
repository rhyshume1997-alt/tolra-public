/**
 * Files on delivery notes and purchase orders (migration 067: document_attachments and the private document-attachments bucket).
 *
 * Who may do what is decided by the database, not here: a delivery note's files are read, added and removed by admin, office and
 * workshop (removal refused once the note has gone out); a purchase order's by admin and office. A stored file is never overwritten
 * (each upload gets its own name) and is deleted only after its row.
 */
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { missingDbObject } from "@/lib/db-features";

export const DOCUMENT_ATTACHMENTS_BUCKET = "document-attachments";
export const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_ATTACHMENT_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;
/** For <input accept>: the same list the bucket allows. */
export const DOCUMENT_ATTACHMENT_ACCEPT = DOCUMENT_ATTACHMENT_TYPES.join(",");

export type AttachmentParent = { kind: "delivery_note"; id: string } | { kind: "purchase_order"; id: string };
export type DocumentAttachment = { id: string; file_name: string; storage_path: string; mime_type: string | null; size_bytes: number | null; created_at: string; delivery_note_id: string | null };

const FOLDER = { delivery_note: "delivery-notes", purchase_order: "purchase-orders" } as const;
const COLUMN = { delivery_note: "delivery_note_id", purchase_order: "purchase_order_id" } as const;

/** A file name that is safe as the last part of a storage path (no folders, no odd characters), at most 200 characters. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "file").slice(0, 200);
}

/** Where a file for this parent is stored: <company>/<delivery-notes|purchase-orders>/<parent id>/<stamp>-<name> (067's CHECK). */
export function attachmentPath(organizationId: string, parent: AttachmentParent, fileName: string, stamp: number = Date.now()): string {
  return `${organizationId}/${FOLDER[parent.kind]}/${parent.id}/${stamp}-${safeFileName(fileName)}`;
}

/** Why this file can't be attached (the bucket refuses the same), or null. */
export function attachmentProblem(file: { name: string; type: string; size: number }): string | null {
  if (!(DOCUMENT_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return `${file.name}: only PDF, PNG, JPEG or WebP files can be attached.`;
  if (file.size <= 0) return `${file.name} is empty.`;
  if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) return `${file.name} is larger than 20 MB.`;
  return null;
}

/** "Not available yet" when the database has no 067 (the table or bucket is missing), so the panel can say so plainly. */
export function attachmentsUnavailable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return missingDbObject(error) || /bucket not found/i.test(error.message ?? "");
}

const COLUMNS = "id, file_name, storage_path, mime_type, size_bytes, created_at, delivery_note_id";

export async function listAttachments(parent: AttachmentParent): Promise<DocumentAttachment[]> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.from("document_attachments").select(COLUMNS).eq(COLUMN[parent.kind], parent.id).order("created_at").order("id");
  if (error) throw error;
  return (data ?? []) as DocumentAttachment[];
}

/** The files on the delivery notes that are on this invoice (admin and office read both). */
export async function listInvoiceDeliveryNoteAttachments(invoiceId: string): Promise<Array<DocumentAttachment & { dn_number: string }>> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: notes, error } = await supabase.from("delivery_notes").select("id, dn_number").eq("invoice_id", invoiceId);
  if (error) throw error;
  if (!notes?.length) return [];
  const numbers = new Map(notes.map((n) => [String(n.id), String(n.dn_number ?? "")]));
  const { data, error: filesError } = await supabase.from("document_attachments").select(COLUMNS).in("delivery_note_id", [...numbers.keys()]).order("created_at").order("id");
  // Before 067 there is no files table: the invoice simply has no note files to show.
  if (filesError && missingDbObject(filesError)) return [];
  if (filesError) throw filesError;
  return ((data ?? []) as DocumentAttachment[]).map((row) => ({ ...row, dn_number: numbers.get(String(row.delivery_note_id)) ?? "" }));
}

/** Uploads the file to the parent's folder, then records it. A failed record removes the upload again (best effort). */
export async function addAttachment(parent: AttachmentParent, file: File): Promise<DocumentAttachment> {
  const problem = attachmentProblem(file);
  if (problem) throw new Error(problem);
  if (!supabase) throw new Error("Supabase is not configured.");
  const organizationId = await getCurrentOrganizationId();
  const { data: userData } = await supabase.auth.getUser();
  const path = attachmentPath(organizationId, parent, file.name);
  const upload = await supabase.storage.from(DOCUMENT_ATTACHMENTS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (upload.error) throw upload.error;
  const { data, error } = await supabase.from("document_attachments").insert({
    organization_id: organizationId, [COLUMN[parent.kind]]: parent.id, file_name: file.name.slice(0, 255), storage_path: path,
    mime_type: file.type, size_bytes: file.size, uploaded_by: userData.user?.id ?? null,
  }).select(COLUMNS).single();
  if (error) {
    await supabase.storage.from(DOCUMENT_ATTACHMENTS_BUCKET).remove([path]);
    throw error;
  }
  return data as DocumentAttachment;
}

/** Removes the record (the database decides whether it may go), then the stored file. */
export async function removeAttachment(attachment: Pick<DocumentAttachment, "id" | "storage_path">): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.from("document_attachments").delete().eq("id", attachment.id).select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("That file couldn't be removed: you don't have access to remove it.");
  // The record has gone, so the file is no longer listed anywhere; a failure here only leaves an unlisted file behind.
  await supabase.storage.from(DOCUMENT_ATTACHMENTS_BUCKET).remove([attachment.storage_path]);
}

/** A short-lived link that downloads the file under its own name. */
export async function attachmentUrl(attachment: Pick<DocumentAttachment, "storage_path" | "file_name">): Promise<string> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.storage.from(DOCUMENT_ATTACHMENTS_BUCKET).createSignedUrl(attachment.storage_path, 300, { download: attachment.file_name });
  if (error || !data?.signedUrl) throw error ?? new Error("Couldn't create the download link.");
  return data.signedUrl;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "";
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
