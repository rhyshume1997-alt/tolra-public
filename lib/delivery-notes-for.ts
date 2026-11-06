/**
 * A job's or a customer's delivery notes, for the read-only list on the job and customer pages. Reads the delivery_notes the signed-in
 * person's company already owns (row security keeps another company's rows out).
 *
 * A note made from a sales order, from a job's order, or from a job with no order (create_job_delivery_note, release 147) carries
 * job_id / customer_id: it is matched by that key only. A legacy note made by hand carries the job reference and the customer name as
 * text only: it is matched by text, but only while it has no key of its own, so a note keyed to another job or customer that happens to
 * repeat the text is never listed here. Each note once; at most DELIVERY_NOTE_LIST_LIMIT, and `more` says when there were more.
 */
export type NoteListRow = { id: string; ref: string; status: string; date: string };

export type NoteListQuery = { jobId?: string; jobNo?: string; customerId?: string; customerName?: string };

export type NoteList = { rows: NoteListRow[]; more: boolean };

type Row = Record<string, unknown>;
type Builder = PromiseLike<{ data: unknown; error: { message?: string } | null }> & {
  select: (columns: string) => Builder;
  eq: (column: string, value: unknown) => Builder;
  is: (column: string, value: null) => Builder;
  order: (column: string, options?: { ascending?: boolean }) => Builder;
  limit: (count: number) => Builder;
};
export type NoteListDb = { from: (table: string) => unknown };

const COLUMNS = "id, dn_number, status, delivery_date, ship_date, created_at";
export const DELIVERY_NOTE_LIST_LIMIT = 100;

/** The delivery-note roles (row security: admin, office, workshop). A viewer has no access to delivery notes. */
export function canListDeliveryNotes(role: string | null | undefined): boolean {
  return role === "admin" || role === "office" || role === "workshop";
}

export const deliveryNoteHref = (id: string) => `/delivery-notes/${id}/print`;

/** Each match: the column, its value, and (for a legacy text match) the key column that must be empty. */
type Match = { column: string; value: string; keyless?: string };

export async function fetchDeliveryNotesFor(db: NoteListDb, query: NoteListQuery): Promise<NoteList> {
  const matches: Match[] = [];
  if (query.jobId) matches.push({ column: "job_id", value: query.jobId });
  if (query.jobNo?.trim()) matches.push({ column: "job_ref", value: query.jobNo.trim(), keyless: "job_id" });
  if (query.customerId) matches.push({ column: "customer_id", value: query.customerId });
  if (query.customerName?.trim()) matches.push({ column: "customer", value: query.customerName.trim(), keyless: "customer_id" });
  const found = new Map<string, Row>();
  let more = false;
  for (const match of matches) {
    let builder = (db.from("delivery_notes") as Builder).select(COLUMNS).eq(match.column, match.value);
    if (match.keyless) builder = builder.is(match.keyless, null);
    // One more than shown, so a cut list is known to be cut.
    const { data, error } = await builder.order("created_at", { ascending: false }).limit(DELIVERY_NOTE_LIST_LIMIT + 1);
    if (error) throw new Error(error.message || "Couldn't load delivery notes.");
    const rows = (data ?? []) as Row[];
    if (rows.length > DELIVERY_NOTE_LIST_LIMIT) more = true;
    for (const row of rows) found.set(String(row.id), row);
  }
  const sorted = [...found.values()]
    .map((row) => ({ row, date: String(row.delivery_date || row.ship_date || row.created_at || "") }))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (sorted.length > DELIVERY_NOTE_LIST_LIMIT) more = true;
  return {
    more,
    rows: sorted.slice(0, DELIVERY_NOTE_LIST_LIMIT).map(({ row, date }) => ({
      id: String(row.id),
      ref: String(row.dn_number || `DN-${String(row.id).slice(0, 8)}`),
      status: String(row.status || ""),
      date,
    })),
  };
}
