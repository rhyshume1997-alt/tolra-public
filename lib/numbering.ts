/**
 * Document numbering.
 *
 *  - Quotes:          QUO-####   allocated by the next_doc_number RPC
 *  - Invoices:        INV-####   allocated by the next_doc_number RPC
 *  - Purchase orders: PO-####    allocated by the next_doc_number RPC
 *  - Delivery notes:  DLN-####   (same number as the invoice: INV-0456 <-> DLN-0456)
 *  - Jobs:            J-####     (carries the quote number: QUO-0123 -> J-0123; otherwise next_doc_number('J'))
 *
 * Numbers are allocated in Postgres (atomic per organisation), never by scanning rows in the browser.
 * The pure helpers below (nextNumber, deliveryNoteNumberForInvoice, jobNumberForQuote) are for tests and demo data.
 *
 * Customer purchase order numbers are the customer's own and are never generated here.
 */

import { supabase } from "@/lib/supabase";

export const QUOTE_PREFIX = "QUO";
export const INVOICE_PREFIX = "INV";
export const DELIVERY_NOTE_PREFIX = "DLN";
export const JOB_PREFIX = "J";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cleanPrefix = (prefix: string) => prefix.trim().replace(/-+$/, "");
const pad = (value: number) => String(value).padStart(4, "0");

/** Reads the numeric part of a reference such as "QUO-0123" (hyphen variants tolerated). Null when it does not match. */
export function parseNumber(prefix: string, ref: string | null | undefined): number | null {
  const match = new RegExp(`^${escapeRegExp(cleanPrefix(prefix))}[-\\u2010-\\u2013\\u00ad\\s]?(\\d+)$`, "i").exec((ref ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** Highest existing number + 1, zero padded to 4 digits. nextNumber("QUO", ["QUO-0123"]) -> "QUO-0124". */
export function nextNumber(prefix: string, existingRefs: ReadonlyArray<string | null | undefined>): string {
  const base = cleanPrefix(prefix);
  const highest = existingRefs.reduce<number>((max, ref) => Math.max(max, parseNumber(base, ref) ?? 0), 0);
  return `${base}-${pad(highest + 1)}`;
}

/** Delivery notes reuse the number of their invoice. deliveryNoteNumberForInvoice("INV-0456") -> "DLN-0456". */
export function deliveryNoteNumberForInvoice(invoiceRef: string): string {
  const n = parseNumber(INVOICE_PREFIX, invoiceRef);
  if (n === null) throw new Error(`"${invoiceRef}" is not an invoice number like INV-0456.`);
  return `${DELIVERY_NOTE_PREFIX}-${pad(n)}`;
}

/** Jobs carry the quote number so the worksheet and the quote correlate. jobNumberForQuote("QUO-0123") -> "J-0123". */
export function jobNumberForQuote(quoteRef: string): string {
  const n = parseNumber(QUOTE_PREFIX, quoteRef);
  if (n === null) throw new Error(`"${quoteRef}" is not a quote number like QUO-0123.`);
  return `${JOB_PREFIX}-${pad(n)}`;
}

/** Inverse of jobNumberForQuote, used to show the quote number on a worksheet. Null when the job number is not J-####. */
export function quoteNumberForJob(jobNo: string | null | undefined): string | null {
  const n = parseNumber(JOB_PREFIX, jobNo);
  return n === null ? null : `${QUOTE_PREFIX}-${pad(n)}`;
}

/** Allocates the next number for a prefix ("QUO" | "INV" | "J" | "PO" | "SO") atomically in Postgres. Throws when it can't. */
export async function allocateNumber(prefix: "QUO" | "INV" | "J" | "PO" | "SO"): Promise<string> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("next_doc_number", { p_prefix: prefix });
  if (error) throw error;
  if (typeof data !== "string" || !data) throw new Error("next_doc_number returned no number.");
  return data;
}

/**
 * Job number for a sales order. Uses the linked quote's number (QUO-0123 -> J-0123) when there is one and that
 * job number is not already taken, so the worksheet and the quote correlate. Otherwise takes next_doc_number('J').
 */
export async function jobNumberForOrder(quoteRef: string | null | undefined): Promise<string> {
  if (!supabase) throw new Error("Supabase is not configured.");
  if (quoteRef && parseNumber(QUOTE_PREFIX, quoteRef) !== null) {
    const candidate = jobNumberForQuote(quoteRef);
    const { count, error } = await supabase.from("jobs").select("id", { count: "exact", head: true }).eq("job_no", candidate);
    if (error) throw error;
    if (!count) return candidate;
  }
  return allocateNumber("J");
}
