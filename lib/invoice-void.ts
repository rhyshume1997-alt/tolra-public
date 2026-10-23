/**
 * Voiding an issued invoice (migration 073, void_invoice): one server step that asks for a reason, checks the invoice has no payments
 * or credits against it, sets it void and writes the audit row, all in one transaction. A direct status change to void is refused by
 * the database, so this is the only way. The checks here only decide whether to OFFER Void; the database decides.
 */
import { missingDbObject } from "@/lib/db-features";
import { friendlyError } from "@/lib/friendly-error";
import { invoiceStatus } from "@/lib/receivables";

export const VOID_REASON_MAX = 500;

/** Shown if Void is used before 073 is applied (the button is normally hidden until then). */
export const VOID_NEEDS_UPDATE = "Voiding invoices isn't available yet: the database update that adds it hasn't been applied. Nothing was changed.";

const DEAD = new Set(["void", "voided", "cancelled", "canceled"]);
/** void_invoice voids exactly these statuses and no other (it compares exactly; an older odd spelling is refused, not guessed). */
const VOIDABLE = new Set(["issued", "sent"]);

/** The invoice as the list holds it (only what decides whether Void is offered). */
export type VoidCandidate = { rawStatus: string; amountPaid: number; credited: number; refunded: number; paymentUnverified?: boolean };

/** Whether to offer Void: issued or sent (the only statuses the database voids), nothing paid or credited, payments not waiting to be confirmed. */
export function voidOffered(invoice: VoidCandidate): boolean {
  if (!VOIDABLE.has(invoiceStatus(invoice.rawStatus))) return false;
  return invoice.amountPaid === 0 && invoice.credited === 0 && invoice.refunded === 0 && !invoice.paymentUnverified;
}

/** Whether the invoice is void (any of the spellings the database treats as void). */
export function isVoid(rawStatus: string | null | undefined): boolean {
  return DEAD.has(invoiceStatus(rawStatus));
}

/** Why the reason can't be sent yet, or null. */
export function voidReasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (!trimmed) return "Give the reason the invoice is being voided.";
  if (trimmed.length > VOID_REASON_MAX) return `The reason can be at most ${VOID_REASON_MAX} characters.`;
  return null;
}

/** Plain-English refusals by the database's hint (its own message is used when it is safe to show; this is the fallback). */
const REFUSALS: Record<string, string> = {
  invoice_draft: "A draft invoice has no number yet: delete the draft instead of voiding it.",
  invoice_already_void: "This invoice is already void.",
  invoice_paid: "This invoice has payments recorded against it, so it can't be voided. Reverse the payments first, or correct it with a credit note.",
  invoice_payments_unconfirmed: "This invoice has imported payments still to be confirmed, so it can't be voided yet.",
  invoice_credited: "This invoice has had a credit applied, so it can't be voided.",
  invoice_has_credit_notes: "This invoice has a credit note or a credit against it, so it can't be voided.",
  invoice_written_off: "This invoice has been written off, so it can't be voided.",
  void_reason_required: "Give the reason the invoice is being voided (at most 500 characters).",
  invoice_void_direct: "An invoice is voided with Void invoice, which asks for a reason.",
  invoice_void_final: "This invoice has been voided, so it stays void: make a new invoice instead.",
  invoice_status_not_voidable: "This invoice's status can't be voided here. Ask for the record to be checked. Nothing was changed.",
  invoice_status_not_allowed: "That isn't an invoice status Tolra uses. Nothing was changed.",
};

type DbError = { code?: string | null; message?: string | null; hint?: string | null };

/** What to tell the person when void_invoice refused or failed. */
export function voidRefusalMessage(error: DbError): string {
  if (missingDbObject(error)) return VOID_NEEDS_UPDATE;
  const hint = error.hint ?? "";
  if (hint && Object.prototype.hasOwnProperty.call(REFUSALS, hint)) return REFUSALS[hint];
  if (error.code === "P0002") return "That invoice wasn't found. Reload the page and try again.";
  if (error.code === "42501") return "Only admin and office staff can void invoices.";
  return friendlyError(error, "Couldn't void the invoice. Nothing was changed.");
}

/** The database call (an injected client keeps it testable). */
export type VoidClient = { rpc: (fn: "void_invoice", args: { p_invoice_id: string; p_reason: string }) => PromiseLike<{ data: unknown; error: DbError | null }> };

export async function voidInvoice(client: VoidClient, invoiceId: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const problem = voidReasonProblem(reason);
  if (problem) return { ok: false, error: problem };
  try {
    const { error } = await client.rpc("void_invoice", { p_invoice_id: invoiceId, p_reason: reason.trim() });
    if (error) return { ok: false, error: voidRefusalMessage(error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn't void the invoice. Nothing was changed.") };
  }
}
