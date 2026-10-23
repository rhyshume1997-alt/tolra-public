/**
 * The customer's sign-off (migration 072) on the paperwork that follows the job: the delivery note PDF for the job, and the invoice PDF
 * when the invoice came from that job's delivery note(s). The data is the worksheet print's: the job's CURRENT customer sign-off (the
 * latest, as customerSignOffs orders them), read through the signed-in person's own client, so row security keeps it to their company.
 * No sign-off, a database without 072 (no customer rows, or a table that can't be read), or a read that fails: nothing is returned and the
 * document prints exactly as it did.
 */
import type { InvoiceNote } from "@/lib/invoice-delivery-notes";
import { type JobSignOff, customerLine, customerSignOffs, formatSignedAt, formatSignedOn } from "@/lib/job-signoff";

/** What the PDFs print: a small "Customer sign-off" block. */
export type PdfCustomerSignOff = {
  /** "Jane Smith, Site Manager, Acme Ltd" (customerLine). */
  name: string;
  /** The wording the customer was shown, as stored with their sign-off. */
  statement?: string;
  /** "17 Oct 2026, 14:03 (phone time)": the phone's time, else the UK date. */
  signedAt: string;
  signature: { kind: "drawn" | "typed"; data: string };
};

/** The job's current customer sign-off: the latest one (newest created_at first, as the worksheet orders them), or null when there is none. */
export function latestCustomerSignOff(rows: JobSignOff[]): JobSignOff | null {
  return customerSignOffs(rows)[0] ?? null;
}

/** The block's height is fixed (BaseDocumentPDF), so long text is clipped to keep it to its lines; the full statement stays on the job worksheet. */
const NAME_MAX = 80;
const STATEMENT_MAX = 180;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text);

/** The PDF block for a sign-off, worded as the worksheet print words it; undefined when there is none (the layout then stays as it was). */
export function customerSignOffPdfProps(row: JobSignOff | null | undefined): PdfCustomerSignOff | undefined {
  if (!row || row.kind !== "customer") return undefined;
  const when = formatSignedAt(row.device_signed_at) || formatSignedOn(row.signed_on);
  return {
    name: clip(customerLine(row), NAME_MAX),
    statement: row.statement?.trim() ? clip(row.statement.trim(), STATEMENT_MAX) : undefined,
    signedAt: `${when} (phone time)`,
    signature: { kind: row.signature_kind, data: row.signature_data },
  };
}

type Result = PromiseLike<{ data: unknown; error: unknown }>;
type Builder = Result & { select: (columns: string) => Builder; eq: (column: string, value: string) => Builder; limit: (count: number) => Builder; maybeSingle: () => Builder };
export type SignOffDb = { from: (table: string) => unknown };
const table = (db: SignOffDb, name: string) => db.from(name) as Builder;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job's current customer sign-off, or null (none, 072 not applied, or unreadable: the document never claims a sign-off it couldn't read). */
export async function fetchJobCustomerSignOff(db: SignOffDb, jobId: string | null | undefined): Promise<JobSignOff | null> {
  if (!jobId || !UUID.test(jobId)) return null;
  try {
    const { data, error } = await table(db, "job_signoffs").select("*").eq("job_id", jobId).eq("kind", "customer");
    if (error) return null;
    return latestCustomerSignOff((Array.isArray(data) ? data : []) as JobSignOff[]);
  } catch {
    return null;
  }
}

/** A delivery note's job: its job_id, else the job whose number is its job_ref (059 matches them the same way). Null when it has none or the number is ambiguous. */
async function noteJobId(db: SignOffDb, noteId: string): Promise<string | null> {
  const { data, error } = await table(db, "delivery_notes").select("job_id, job_ref").eq("id", noteId).maybeSingle();
  if (error || !data) return null;
  const note = data as { job_id?: string | null; job_ref?: string | null };
  if (note.job_id) return String(note.job_id);
  const ref = note.job_ref?.trim();
  if (!ref) return null;
  const { data: jobs, error: jobError } = await table(db, "jobs").select("id").eq("job_no", ref).limit(2);
  const found = Array.isArray(jobs) ? (jobs as Array<{ id?: string }>) : [];
  return jobError || found.length !== 1 || !found[0].id ? null : String(found[0].id);
}

/** The block for a delivery note's PDF: its job's current customer sign-off. Undefined for no job, no sign-off, 072 absent or any failed read. */
export async function deliveryNoteCustomerSignOff(db: SignOffDb, noteId: string): Promise<PdfCustomerSignOff | undefined> {
  try {
    return customerSignOffPdfProps(await fetchJobCustomerSignOff(db, await noteJobId(db, noteId)));
  } catch {
    return undefined;
  }
}

/**
 * The job an invoice's own delivery notes (not the ones merely on its job) all belong to: exactly one job, or null. An invoice from notes of
 * several jobs has no single customer to attribute a signature to, so it prints none.
 */
export function singleJobOfNotes(notes: InvoiceNote[]): string | null {
  // Every note on the invoice must be of that one job: a note on no job (or another job) means the sign-off may not cover the invoice.
  const own = notes.filter((note) => note.via === "invoice");
  const jobs = new Set(own.map((note) => note.jobId ?? ""));
  return jobs.size === 1 && !jobs.has("") ? [...jobs][0] : null;
}

/** The block for an invoice's PDF, from the delivery notes it was made from (fetchInvoiceNotes), when they are all of one job. */
export async function invoiceCustomerSignOff(db: SignOffDb, notes: InvoiceNote[]): Promise<PdfCustomerSignOff | undefined> {
  return customerSignOffPdfProps(await fetchJobCustomerSignOff(db, singleJobOfNotes(notes)));
}
