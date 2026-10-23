/**
 * A direct link to one invoice: /invoices?invoice=<id> opens that invoice's details on the Invoices page (the same way the Job Board
 * opens /jobs?job=<id>). The id is only looked up among the invoices the signed-in person can already read (row level security), so
 * a link to anyone else's invoice, or one that no longer exists, opens nothing. No new permission.
 */
export function invoiceHref(id: string): string {
  return `/invoices?invoice=${encodeURIComponent(id)}`;
}

/** The invoice id named by a page's query string (window.location.search), or null. */
export function linkedInvoiceId(search: string): string | null {
  const id = new URLSearchParams(search).get("invoice")?.trim();
  return id ? id : null;
}

/**
 * The draft invoice that sending a delivery note out made (migration 059), from that note's invoice_queue_events rows (newest first):
 * the invoice of the latest "drafted" row. Null when nothing was drafted (internal job, manual items, a failure) or the rows
 * couldn't be read, so the caller shows nothing extra.
 */
export function draftedInvoiceId(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows as Array<Record<string, unknown> | null>) {
    if (row && row.outcome === "drafted" && row.invoice_id) return String(row.invoice_id);
  }
  return null;
}
