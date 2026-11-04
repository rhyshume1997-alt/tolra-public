/**
 * A job's or a customer's delivery notes, for the read-only list on the job and customer pages. Reads the delivery_notes the signed-in
 * person's company already owns (row security keeps another company's rows out), nothing new in the database.
 *
 * A note made from a sales order or a job carries job_id / customer_id. A note made by hand carries the job reference and the customer
 * name as text only, so those are matched by text too (the same company only), each note listed once.
 */
export type NoteListRow = { id: string; ref: string; status: string; date: string };

export type NoteListQuery = { jobId?: string; jobNo?: string; customerId?: string; customerName?: string };

type Row = Record<string, unknown>;
type Builder = PromiseLike<{ data: unknown; error: { message?: string } | null }> & {
  select: (columns: string) => Builder;
  eq: (column: string, value: unknown) => Builder;
  order: (column: string, options?: { ascending?: boolean }) => Builder;
  limit: (count: number) => Builder;
};
export type NoteListDb = { from: (table: string) => unknown };

const COLUMNS = "id, dn_number, status, delivery_date, ship_date, created_at";
const LIMIT = 100;

/** The delivery-note roles (row security: admin, office, workshop). A viewer has no access to delivery notes. */
export function canListDeliveryNotes(role: string | null | undefined): boolean {
  return role === "admin" || role === "office" || role === "workshop";
}

export const deliveryNoteHref = (id: string) => `/delivery-notes/${id}/print`;

export async function fetchDeliveryNotesFor(db: NoteListDb, query: NoteListQuery): Promise<NoteListRow[]> {
  const matches: Array<[string, string]> = [];
  if (query.jobId) matches.push(["job_id", query.jobId]);
  if (query.jobNo?.trim()) matches.push(["job_ref", query.jobNo.trim()]);
  if (query.customerId) matches.push(["customer_id", query.customerId]);
  if (query.customerName?.trim()) matches.push(["customer", query.customerName.trim()]);
  const found = new Map<string, Row>();
  for (const [column, value] of matches) {
    const { data, error } = await (db.from("delivery_notes") as Builder).select(COLUMNS).eq(column, value).order("created_at", { ascending: false }).limit(LIMIT);
    if (error) throw new Error(error.message || "Couldn't load delivery notes.");
    for (const row of (data ?? []) as Row[]) found.set(String(row.id), row);
  }
  return [...found.values()]
    .map((row) => ({ row, date: String(row.delivery_date || row.ship_date || row.created_at || "") }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(({ row, date }) => ({
      id: String(row.id),
      ref: String(row.dn_number || `DN-${String(row.id).slice(0, 8)}`),
      status: String(row.status || ""),
      date,
    }));
}
