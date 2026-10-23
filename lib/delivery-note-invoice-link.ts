/**
 * A delivery note put on its job's draft invoice, from the delivery note (migration 067, link_delivery_note_to_invoice).
 *
 * The database decides: admin or office with Invoicing shown, the note and the invoice of the caller's company, the invoice still a
 * DRAFT, the same job (the note's job, or the job its order became) and the same customer (ignoring case and repeated spaces), and
 * the note on no other live invoice and with no hand-typed invoice number. The list offered here is read under the person's own row
 * rules and narrowed with the same tests, so it only offers drafts the function will accept; when it can tell the note can't be put
 * on any invoice it says so in the function's own words.
 *
 * Linking only records which invoice the note is on, so 059 makes no second draft when the note goes out. The note's items are NOT
 * added to the invoice: the draft usually bills them already (made from the order, or by 059 for an earlier note) and nothing ties
 * an invoice line to a note item, so adding them could bill the same parts twice. What is billed is changed with Edit Draft on the
 * invoice (replace_draft_invoice).
 */
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

export type LinkNote = { id: string; dnNumber: string; customer: string; jobId: string | null; salesOrderId: string | null; invoiceId: string | null; invoiceRef: string | null };
export type InvoiceRow = { id: string; status: string | null; invoice_ref: string | null; customer: string | null; job_id: string | null; total: number | string | null; invoice_date: string | null };
export type DraftCandidate = { id: string; customer: string; jobId: string; total: number; invoiceDate: string | null };
export type CurrentInvoice = { id: string; ref: string | null; draft: boolean };
export type LinkOptions = { note: LinkNote; current: CurrentInvoice | null; blocked: string | null; candidates: DraftCandidate[] };

/** Shown next to the control: what attaching does and doesn't do. */
export const ITEMS_NOT_ADDED =
  "Attaching puts this delivery note on the draft, so no second invoice is made when it goes out. Its items are not added to the invoice's lines (the draft may already bill them, and adding them could bill the same parts twice): check the lines and use Edit Draft on the invoice if anything is missing or different.";

/** The function's own refusals, word for word (067, link_delivery_note_to_invoice). */
export const LINK_REFUSALS = {
  issued: (invoiceRef: string | null) => `Invoice ${invoiceRef ?? ""} has been issued: a delivery note can only be put on a draft invoice.`,
  onAnother: (dnNumber: string) => `Delivery note ${dnNumber} is already on another invoice.`,
  typedRef: (dnNumber: string, invoiceRef: string) => `Delivery note ${dnNumber} records invoice ${invoiceRef}, so it can't be put on another one.`,
  otherJob: (dnNumber: string) => `Delivery note ${dnNumber} is not for the job this invoice is for.`,
  otherCustomer: (dnNumber: string) => `Delivery note ${dnNumber} is for a different customer from the invoice.`,
};

const DEAD = ["void", "voided", "cancelled", "canceled"];
/** A draft exactly as the function tests it: coalesce(status, 'draft') = 'draft'. */
const isDraft = (value: string | null | undefined) => (value ?? "draft") === "draft";

/** The same customer as the function compares them (btrim, runs of white space as one space, then lower case). */
export function sameCustomer(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (value: string | null | undefined) => (value ?? "").replace(/^ +| +$/g, "").replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/** A live invoice (not void or cancelled): a note on one can't be put on another. */
export function invoiceLive(rawStatus: string | null | undefined): boolean {
  return !DEAD.includes((rawStatus ?? "draft").toLowerCase());
}

/** Why this note can't be put on any invoice now, in the function's words, or null. A note already on a live invoice is shown as such. */
export function noteLinkBlocked(note: LinkNote, current: CurrentInvoice | null): string | null {
  if (current) return null;
  if (!note.invoiceId && note.invoiceRef?.trim()) return LINK_REFUSALS.typedRef(note.dnNumber, note.invoiceRef.trim());
  return null;
}

/** The drafts the function will accept for this note: still a draft, for one of the note's jobs, for the same customer. */
export function draftCandidates(note: LinkNote, invoices: InvoiceRow[], jobIds: readonly string[]): DraftCandidate[] {
  const jobs = new Set(jobIds);
  return invoices
    .filter((invoice) => isDraft(invoice.status) && invoice.job_id !== null && jobs.has(invoice.job_id) && sameCustomer(invoice.customer, note.customer))
    .map((invoice) => ({ id: invoice.id, customer: invoice.customer ?? "", jobId: invoice.job_id as string, total: Number(invoice.total ?? 0), invoiceDate: invoice.invoice_date }));
}

/** The jobs a note belongs to, as the function sees them: its own job and the job its sales order became. */
export function noteJobIds(note: LinkNote, convertedJobIds: readonly string[]): string[] {
  return [...new Set([...(note.jobId ? [note.jobId] : []), ...convertedJobIds])];
}

/** Loads the note, the invoice it is on, and the drafts it can go on (all under the person's own row rules). */
export async function loadLinkOptions(noteId: string): Promise<LinkOptions> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const organizationId = await getCurrentOrganizationId();
  const { data: row, error } = await supabase.from("delivery_notes")
    .select("id, dn_number, customer, job_id, sales_order_id, invoice_id, invoice_ref").eq("organization_id", organizationId).eq("id", noteId).single();
  if (error) throw error;
  const note: LinkNote = {
    id: String(row.id), dnNumber: String(row.dn_number ?? ""), customer: String(row.customer ?? ""), jobId: row.job_id ? String(row.job_id) : null,
    salesOrderId: row.sales_order_id ? String(row.sales_order_id) : null, invoiceId: row.invoice_id ? String(row.invoice_id) : null, invoiceRef: row.invoice_ref ? String(row.invoice_ref) : null,
  };

  let current: CurrentInvoice | null = null;
  if (note.invoiceId) {
    const { data: invoice, error: invoiceError } = await supabase.from("invoices").select("id, status, invoice_ref").eq("organization_id", organizationId).eq("id", note.invoiceId).maybeSingle();
    if (invoiceError) throw invoiceError;
    if (invoice && invoiceLive(invoice.status)) current = { id: String(invoice.id), ref: invoice.invoice_ref ? String(invoice.invoice_ref) : null, draft: isDraft(invoice.status) };
  }
  const blocked = noteLinkBlocked(note, current);
  if (current || blocked) return { note, current, blocked, candidates: [] };

  let converted: string[] = [];
  if (note.salesOrderId) {
    const { data: jobs, error: jobsError } = await supabase.from("jobs").select("id").eq("organization_id", organizationId).eq("converted_from_sales_order_id", note.salesOrderId);
    if (jobsError) throw jobsError;
    converted = (jobs ?? []).map((job) => String(job.id));
  }
  const jobIds = noteJobIds(note, converted);
  if (!jobIds.length) return { note, current, blocked, candidates: [] };
  const { data: invoices, error: listError } = await supabase.from("invoices")
    .select("id, status, invoice_ref, customer, job_id, total, invoice_date").eq("organization_id", organizationId).in("job_id", jobIds)
    .or("status.is.null,status.eq.draft").order("created_at", { ascending: false }).limit(50);
  if (listError) throw listError;
  return { note, current, blocked, candidates: draftCandidates(note, (invoices ?? []) as InvoiceRow[], jobIds) };
}

/** Puts the note on the draft. The function refuses anything it shouldn't, in the words above. */
export async function linkNoteToInvoice(noteId: string, invoiceId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("link_delivery_note_to_invoice", { p_note: noteId, p_invoice: invoiceId });
  if (error) throw error;
}
