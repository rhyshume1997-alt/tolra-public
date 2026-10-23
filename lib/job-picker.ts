/**
 * The job pickers (Create Invoice, New Delivery Note "Without an order"): search by job number or customer on the server, newest first, in
 * the caller's company (row rules), and what picking a job fills in. A job is never a free-text guess: it is chosen from this list.
 */

export const PICKER_LIMIT = 50;

export type PickerJob = { id: string; job_no: string; customer: string; quote_ref: string; customer_po: string; internal: boolean };

/** The search text made safe for a PostgREST filter: its wildcard, list and quote characters are dropped. */
export function sanitiseTerm(term: string): string {
  return term.replace(/[%_*,()"'\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** The `or` filter for a search ("job_no.ilike.%x%,customer.ilike.%x%"), or null for an empty search. */
export function jobSearchFilter(term: string): string | null {
  const clean = sanitiseTerm(term);
  return clean ? `job_no.ilike.%${clean}%,customer.ilike.%${clean}%` : null;
}

/** The part of the Supabase client used here (a test stands in for it). */
type Query = {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  or(filter: string): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
export type JobClient = { from(table: "jobs"): Query };

/** The newest jobs matching the search (all of them for an empty search), one more than the limit is asked for so the page can say "showing the first N". */
export async function findJobs(client: JobClient, term: string, options: { includeInternal: boolean }): Promise<{ jobs: PickerJob[]; truncated: boolean; failed: boolean }> {
  let query = client.from("jobs").select("id, job_no, customer, quote_ref, customer_po, is_internal");
  if (!options.includeInternal) query = query.eq("is_internal", false);
  const filter = jobSearchFilter(term);
  if (filter) query = query.or(filter);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(PICKER_LIMIT + 1);
  if (error || !Array.isArray(data)) return { jobs: [], truncated: false, failed: true };
  const rows = (data as Record<string, unknown>[]).map((row) => ({
    id: String(row.id), job_no: String(row.job_no), customer: String(row.customer ?? ""), quote_ref: String(row.quote_ref ?? ""),
    customer_po: String(row.customer_po ?? ""), internal: Boolean(row.is_internal),
  }));
  return { jobs: rows.slice(0, PICKER_LIMIT), truncated: rows.length > PICKER_LIMIT, failed: false };
}

/** What picking a job fills on an invoice: exactly the job's customer, quote number and customer PO. A field the job lacks is cleared, never left from the job before. */
export function invoiceFieldsFromJob(job: Pick<PickerJob, "customer" | "quote_ref" | "customer_po">): { customer: string; quoteRef: string; customerPo: string } {
  return { customer: job.customer, quoteRef: job.quote_ref, customerPo: job.customer_po };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The picked job no longer matches once the customer is changed to another one (a job with no customer matches any): the job link is dropped. */
export function jobSurvivesCustomerChange(job: Pick<PickerJob, "customer"> | null, customer: string): boolean {
  if (!job) return false;
  return !job.customer.trim() || same(job.customer, customer);
}
