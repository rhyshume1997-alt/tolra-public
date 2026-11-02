/**
 * Direct links to one record, by id, for the pages that open it from the address (the same way /invoices?invoice=<id> and
 * /jobs?job=<id> do; see lib/invoice-link.ts and lib/job-link.ts). Used by the global search. Each id is only looked up among the
 * rows the signed-in person can already read (row level security), so a link never reveals anything new.
 */

/** /quotes?quote=<id>: the Quotes page opens that quote once its list has loaded. */
export function quoteHref(id: string): string {
  return `/quotes?quote=${encodeURIComponent(id)}`;
}

/** /purchase-orders?po=<id>: the Purchase Orders page opens that order's detail once its list has loaded. */
export function purchaseOrderHref(id: string): string {
  return `/purchase-orders?po=${encodeURIComponent(id)}`;
}

/** /customers?customer=<id>: the Customers page opens that customer once its list has loaded. */
export function customerHref(id: string): string {
  return `/customers?customer=${encodeURIComponent(id)}`;
}

/** The id a page's query string (window.location.search) names under `param`, or null. */
export function linkedRecordId(search: string, param: string): string | null {
  const id = new URLSearchParams(search).get(param)?.trim();
  return id ? id : null;
}
