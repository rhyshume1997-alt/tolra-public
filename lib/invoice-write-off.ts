/**
 * Writing off what is still owed on an issued invoice, and reversing a write-off (migration 105, write_off_invoice / reverse_write_off):
 * one server step each that asks for a reason (10 to 500 characters), checks the invoice, changes its status and writes the audit row,
 * all in one transaction. A direct status change to or from written off is refused by the database, so these are the only ways. The
 * checks here only decide whether to OFFER the action; the database decides. Before 105 is applied the call answers "Available after
 * database update 105" and nothing changes.
 */
import { missingDbObject } from "@/lib/db-features";
import { friendlyError } from "@/lib/friendly-error";
import { balanceDue, invoiceStatus } from "@/lib/receivables";

export const WRITE_OFF_REASON_MIN = 10;
export const WRITE_OFF_REASON_MAX = 500;

/** Shown when the database doesn't have 105 yet. */
export const WRITE_OFF_NEEDS_UPDATE = "Available after database update 105. Nothing was changed.";

/** write_off_invoice writes off exactly these statuses (it compares exactly; an older odd spelling is refused, not guessed). */
const WRITE_OFFABLE = new Set(["issued", "sent", "partial"]);

export type WriteOffMode = "write_off" | "reverse";

/** The invoice as the list holds it (only what decides whether the action is offered). */
export type WriteOffCandidate = { rawStatus: string; amount: number; amountPaid: number; credited: number; refunded: number; paymentUnverified?: boolean };

/** Whether the invoice is written off. */
export function isWrittenOff(rawStatus: string | null | undefined): boolean {
  return invoiceStatus(rawStatus) === "written_off";
}

/** Whether to offer Write off: issued, sent or part paid, something still to pay, payments not waiting to be confirmed. */
export function writeOffOffered(invoice: WriteOffCandidate): boolean {
  if (!WRITE_OFFABLE.has(invoiceStatus(invoice.rawStatus)) || invoice.paymentUnverified) return false;
  return balanceDue(invoice.amount, invoice.amountPaid, invoice.credited, invoice.refunded) > 0;
}

/** Why the reason can't be sent yet, or null. */
export function writeOffReasonProblem(reason: string, mode: WriteOffMode = "write_off"): string | null {
  const trimmed = reason.trim();
  if (trimmed.length < WRITE_OFF_REASON_MIN || trimmed.length > WRITE_OFF_REASON_MAX) {
    return mode === "reverse"
      ? `Give the reason the write-off is being reversed (${WRITE_OFF_REASON_MIN} to ${WRITE_OFF_REASON_MAX} characters).`
      : `Give the reason the invoice is being written off (${WRITE_OFF_REASON_MIN} to ${WRITE_OFF_REASON_MAX} characters).`;
  }
  return null;
}

/** Plain-English refusals by the database's hint. */
const REFUSALS: Record<string, string> = {
  invoice_already_written_off: "This invoice has already been written off.",
  invoice_draft: "A draft invoice isn't owed yet, so there is nothing to write off: delete the draft instead.",
  invoice_void: "This invoice is void, so there is nothing to write off.",
  invoice_payments_unconfirmed: "This invoice has imported payments still to be confirmed, so it can't be written off yet.",
  invoice_payments_mismatch: "This invoice shows a different amount paid from its payments, so it can't be written off. Ask for the payments to be checked.",
  invoice_nothing_owed: "This invoice has nothing left to pay, so there is nothing to write off.",
  invoice_status_not_write_offable: "This invoice's status can't be written off here. Ask for the record to be checked. Nothing was changed.",
  invoice_not_written_off: "This invoice hasn't been written off, so there is nothing to reverse.",
  invoice_write_off_direct: "An invoice is written off with Write off, and brought back with Reverse write-off, which ask for a reason.",
  mfa_required: "Confirm your authenticator code first (second step of sign-in).",
};

type DbError = { code?: string | null; message?: string | null; hint?: string | null };

/** What to tell the person when write_off_invoice or reverse_write_off refused or failed. */
export function writeOffRefusalMessage(error: DbError, mode: WriteOffMode = "write_off"): string {
  if (missingDbObject(error)) return WRITE_OFF_NEEDS_UPDATE;
  const hint = error.hint ?? "";
  if (hint === "write_off_reason_required") return writeOffReasonProblem("", mode)!;
  if (hint && Object.prototype.hasOwnProperty.call(REFUSALS, hint)) return REFUSALS[hint];
  if (error.code === "P0002") return "That invoice wasn't found. Reload the page and try again.";
  if (error.code === "42501") return mode === "reverse" ? "Only admin and office staff can reverse a write-off." : "Only admin and office staff can write off invoices.";
  return friendlyError(error, mode === "reverse" ? "Couldn't reverse the write-off. Nothing was changed." : "Couldn't write off the invoice. Nothing was changed.");
}

/** The database calls (an injected client keeps them testable). */
export type WriteOffClient = {
  rpc: (fn: "write_off_invoice" | "reverse_write_off", args: { p_invoice_id: string; p_reason: string }) => PromiseLike<{ data: unknown; error: DbError | null }>;
};

async function call(client: WriteOffClient, mode: WriteOffMode, invoiceId: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const problem = writeOffReasonProblem(reason, mode);
  if (problem) return { ok: false, error: problem };
  try {
    const { error } = await client.rpc(mode === "reverse" ? "reverse_write_off" : "write_off_invoice", { p_invoice_id: invoiceId, p_reason: reason.trim() });
    if (error) return { ok: false, error: writeOffRefusalMessage(error, mode) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err, mode === "reverse" ? "Couldn't reverse the write-off. Nothing was changed." : "Couldn't write off the invoice. Nothing was changed.") };
  }
}

export function writeOffInvoice(client: WriteOffClient, invoiceId: string, reason: string) {
  return call(client, "write_off", invoiceId, reason);
}

export function reverseWriteOff(client: WriteOffClient, invoiceId: string, reason: string) {
  return call(client, "reverse", invoiceId, reason);
}
