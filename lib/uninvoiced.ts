/**
 * Sent out but not invoiced (migration 059): the rows of uninvoiced_delivery_notes(), their reasons in plain words, and the customer
 * comparison the database uses when notes are invoiced together.
 */
export type UninvoicedReason = "queued-failed" | "manual-items" | "customer-mismatch" | "internal-job" | "not-drafted";

export type UninvoicedNote = {
  id: string;
  ref: string;
  customer: string;
  status: string;
  /** When it was marked sent out (ISO), or its delivery date when that wasn't recorded. */
  sentAt: string;
  reason: UninvoicedReason;
  detail: string;
  /** The manual "Invoice from delivery notes" can take it (made from an order, not an internal job). */
  invoiceable: boolean;
  voidedInvoiceRef: string | null;
};

export const REASON_LABEL: Record<UninvoicedReason, string> = {
  "queued-failed": "Automatic draft failed",
  "manual-items": "Invoice by hand",
  "customer-mismatch": "Customer differs from the order",
  "internal-job": "Internal job: not invoiced",
  "not-drafted": "No draft yet",
};

const REASONS = new Set<string>(Object.keys(REASON_LABEL));

/** One row of the RPC, typed; an unknown reason (a newer database) reads as "not-drafted" so it is still shown. */
export function toUninvoiced(row: Record<string, unknown>): UninvoicedNote {
  const reason = String(row.reason ?? "");
  return {
    id: String(row.delivery_note_id),
    ref: String(row.dn_number ?? ""),
    customer: String(row.customer ?? ""),
    status: String(row.status ?? ""),
    sentAt: String(row.sent_at ?? row.delivery_date ?? ""),
    reason: (REASONS.has(reason) ? reason : "not-drafted") as UninvoicedReason,
    detail: String(row.detail ?? ""),
    invoiceable: row.invoiceable === true,
    voidedInvoiceRef: row.voided_invoice_ref ? String(row.voided_invoice_ref) : null,
  };
}

/** The customer as the database compares it for one invoice: case and repeated spaces ignored. */
export const customerKey = (name: string | null | undefined) => (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** PostgREST's answer when a function is not in the schema (the database is older than 059). */
export const isMissingFunction = (error: { code?: string } | null | undefined) => error?.code === "PGRST202" || error?.code === "42883";
