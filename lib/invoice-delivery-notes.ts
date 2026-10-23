/**
 * The delivery notes behind an invoice, from data that already exists (no migration):
 *   - "invoice": delivery_notes.invoice_id is this invoice (set by create_invoice_from_delivery_notes, 034/059). This is the
 *     authoritative link and the only one printed on the invoice.
 *   - "job": the note is on the same job as the invoice (delivery_notes.job_id = invoices.job_id) and is not on any invoice yet.
 *     Shown on the invoice screen so a note made from it is visible straight away; never printed.
 * A note already on another invoice is never listed here.
 */
export type NoteRow = Record<string, unknown>;

export type InvoiceNote = {
  id: string;
  ref: string;
  date: string;
  status: string;
  jobId: string | null;
  salesOrderId: string | null;
  via: "invoice" | "job";
};

export const NOTE_COLUMNS = "id, dn_number, delivery_date, status, invoice_id, job_id, sales_order_id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

/** The PostgREST filter for "this invoice's notes, plus unlinked notes on its job". Ids are checked, never pasted as typed. */
export function invoiceNotesFilter(invoiceId: string, jobId?: string | null): string | null {
  if (!UUID.test(invoiceId)) return null;
  const parts = [`invoice_id.eq.${invoiceId}`];
  if (jobId && UUID.test(jobId)) parts.push(`and(invoice_id.is.null,job_id.eq.${jobId})`);
  return parts.join(",");
}

/** Reads the rows for one invoice, dropping notes on other invoices, and sorts by number. */
export function toInvoiceNotes(rows: NoteRow[], invoice: { id: string; jobId?: string | null }): InvoiceNote[] {
  const notes: InvoiceNote[] = [];
  for (const row of rows) {
    const invoiceId = text(row.invoice_id);
    const jobId = text(row.job_id);
    const via = invoiceId === invoice.id ? "invoice" : !invoiceId && invoice.jobId && jobId === invoice.jobId ? "job" : null;
    if (!via || !text(row.id)) continue;
    notes.push({
      id: text(row.id), ref: text(row.dn_number) || "Delivery note", date: text(row.delivery_date).slice(0, 10), status: text(row.status) || "pending",
      jobId: jobId || null, salesOrderId: text(row.sales_order_id) || null, via,
    });
  }
  return notes.sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }) || a.id.localeCompare(b.id));
}

/** What a new delivery note on this invoice is made from: its job, else the sales order of a note already on it. */
export function deliveryNoteSource(invoice: { jobId?: string | null }, notes: InvoiceNote[]): { source: "job" | "order"; id: string } | null {
  if (invoice.jobId && UUID.test(invoice.jobId)) return { source: "job", id: invoice.jobId };
  const order = notes.find((note) => note.via === "invoice" && note.salesOrderId && UUID.test(note.salesOrderId));
  return order?.salesOrderId ? { source: "order", id: order.salesOrderId } : null;
}

/**
 * Whether the invoice screen offers "Create delivery note": a source exists AND a note is already on this invoice (via "invoice"),
 * i.e. the invoice came from delivery notes, so what is left on the job is genuinely un-invoiced. A note made here has no
 * invoice_id; sending it out makes its own draft invoice (059), so on any other invoice the button would promise an attach that
 * never happens.
 */
export function canOfferCreateDeliveryNote(invoice: { jobId?: string | null }, notes: InvoiceNote[]): boolean {
  return deliveryNoteSource(invoice, notes) !== null && notes.some((note) => note.via === "invoice");
}

/** Roles that may already make a delivery note (create_delivery_note, 034/037). Nothing is added for anyone else. */
export function canCreateDeliveryNote(role: string | null | undefined): boolean {
  return role === "admin" || role === "office" || role === "workshop";
}

/** "DLN-0001, DLN-0002" for the printed invoice: only notes on the invoice itself, at most `max` (2: the value must stay on one line) then "+N more". */
export function deliveryNotesPrintedLine(notes: InvoiceNote[], max = 2): string | undefined {
  const refs = [...new Set(notes.filter((note) => note.via === "invoice").map((note) => note.ref))];
  if (!refs.length) return undefined;
  return refs.length > max ? `${refs.slice(0, max).join(", ")} +${refs.length - max} more` : refs.join(", ");
}

type Query = { select: (columns: string) => { or: (filter: string) => { order: (column: string) => { limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }> } } } };

/** One query; row security decides what the signed-in person may see. */
export async function fetchInvoiceNotes(db: { from: (table: string) => unknown }, invoice: { id: string; jobId?: string | null }): Promise<InvoiceNote[]> {
  const filter = invoiceNotesFilter(invoice.id, invoice.jobId);
  if (!filter) return [];
  const { data, error } = await (db.from("delivery_notes") as Query).select(NOTE_COLUMNS).or(filter).order("dn_number").limit(100);
  if (error) throw error;
  return toInvoiceNotes((data ?? []) as NoteRow[], invoice);
}
