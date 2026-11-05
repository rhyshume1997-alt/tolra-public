/**
 * C17 (post-144 release 147): a delivery note for a job that did NOT come from a sales order. The database function
 * create_job_delivery_note links it to the job and to the job's customer record by key, numbers it DLN in the same transaction, keeps
 * the inspection release gate, and returns the first note again for a repeated request id (so a double submit makes one note).
 * This file holds the button rule, the customer the form starts on, and the arguments sent; the database decides everything else.
 */
import { jobReadyForDeliveryNote } from "@/lib/job-delivery-note";

export const JOB_DELIVERY_NOTE_RPC = "create_job_delivery_note";

/**
 * The Job Board's "Delivery note" button on a job with no sales order: office and admin only, as the order button (the database also
 * lets workshop make one, as create_delivery_note does); not on an internal job; once the job is ready (the same rule as the order button).
 */
export function canOfferJobDeliveryNoteWithoutOrder(
  role: string | null | undefined,
  job: { from_sales_order?: boolean; is_internal?: boolean; inspected_at?: string | null; stage?: string | null },
): boolean {
  return (role === "admin" || role === "office") && !job.from_sales_order && !job.is_internal && jobReadyForDeliveryNote(job);
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** The one customer record named as the job's customer (ignoring case and spaces), or null when none or several are. */
export function customerForJob(jobCustomer: string | null | undefined, customers: Array<{ id: string; name: string | null }>): string | null {
  const hits = customers.filter((c) => norm(c.name) === norm(jobCustomer) && norm(jobCustomer) !== "");
  return hits.length === 1 ? hits[0].id : null;
}

export type JobDeliveryNoteForm = {
  jobId: string;
  customerId: string;
  /** Made once when the form opens and kept for every submit of it. */
  requestId: string;
  shipDate: string;
  taxDate: string;
  shipVia: string;
  notes: string;
  lines: Array<{ description: string; quantity: string }>;
};

export type JobDeliveryNoteArgs = {
  p_job: string;
  p_customer: string;
  p_request: string;
  p_ship_date: string;
  p_tax_date: string;
  p_ship_via: string | null;
  p_notes: string | null;
  p_lines: Array<{ description: string; quantity: number }>;
};

/** The RPC arguments, or the plain reason the form can't be sent yet. Blank lines are dropped. */
export function buildJobDeliveryNoteArgs(form: JobDeliveryNoteForm): { ok: true; args: JobDeliveryNoteArgs } | { ok: false; error: string } {
  if (!form.customerId) return { ok: false, error: "Choose the customer this job is for." };
  if (!form.shipDate || !form.taxDate) return { ok: false, error: "The ship date and tax date are required." };
  const filled = form.lines.map((l) => ({ description: l.description.trim(), quantity: l.quantity.trim() })).filter((l) => l.description || l.quantity);
  if (!filled.length) return { ok: false, error: "Add at least one line with a description and a quantity." };
  const lines: Array<{ description: string; quantity: number }> = [];
  for (const l of filled) {
    if (!l.description) return { ok: false, error: "Every line needs a description." };
    const q = Number(l.quantity);
    if (!/^\d+(\.\d{1,3})?$/.test(l.quantity) || !(q > 0)) return { ok: false, error: "Each quantity must be more than zero, with at most three decimal places." };
    lines.push({ description: l.description, quantity: q });
  }
  return {
    ok: true,
    args: {
      p_job: form.jobId,
      p_customer: form.customerId,
      p_request: form.requestId,
      p_ship_date: form.shipDate,
      p_tax_date: form.taxDate,
      p_ship_via: form.shipVia.trim() || null,
      p_notes: form.notes.trim() || null,
      p_lines: lines,
    },
  };
}
