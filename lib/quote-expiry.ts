/**
 * The warning shown before a quote past its valid-until date is sent or marked accepted, and the audit event written when the person
 * confirms it. "Past its date" is the app's one definition (effectiveQuoteStatus in lib/quote-status: a draft or sent quote whose
 * valid-until is before today, valid on its last day, today being the Europe/London date), and "N days ago" counts the same way the
 * dashboard's "expired N days ago" does. Pure, so the wording, the rule and the audit payload are tested once.
 */
import { daysBetween } from "@/lib/attention-items";
import type { AuditAction, AuditTable } from "@/lib/audit-contract";
import { fmtDate } from "@/lib/dates";
import { effectiveQuoteStatus, type QuoteStatus } from "@/lib/quote-status";

export type ExpiredQuoteAction = "send" | "accept";

export type ExpiredQuoteCheck = { message: string; validUntil: string; daysExpired: number };

/** The question to ask before the action (with the facts behind it), or null when the quote has not expired (then nothing is asked). */
export function expiredQuoteCheck(stored: QuoteStatus, validUntil: string | null | undefined, today: string, action: ExpiredQuoteAction): ExpiredQuoteCheck | null {
  if (effectiveQuoteStatus(stored, validUntil, today) !== "expired") return null;
  const until = String(validUntil).slice(0, 10);
  const days = daysBetween(until, today.slice(0, 10));
  const anyway = action === "send" ? "Send anyway?" : "Mark accepted anyway?";
  return { message: `This quote expired on ${fmtDate(until)} (${days} ${days === 1 ? "day" : "days"} ago). Prices may be out of date. ${anyway}`, validUntil: until, daysExpired: days };
}

/** Just the question, or null. */
export function expiredQuoteWarning(stored: QuoteStatus, validUntil: string | null | undefined, today: string, action: ExpiredQuoteAction): string | null {
  return expiredQuoteCheck(stored, validUntil, today, action)?.message ?? null;
}

/**
 * The audit event for a confirmed "anyway". The audit log accepts a fixed list of actions (lib/audit-contract, and the database's
 * audit_event_allowed the same), so no new action name is possible without SQL: it is recorded under the matching existing action
 * (SEND, ACCEPT) with metadata.event = "EXPIRED_QUOTE_CONFIRMED" so it reads as what it is: the person confirmed the expiry warning
 * (the send or the acceptance itself is recorded by its own, usual event).
 */
export function expiredQuoteAuditEvent(quoteRef: string, action: ExpiredQuoteAction, check: Pick<ExpiredQuoteCheck, "validUntil" | "daysExpired">): { action: AuditAction; entityTable: AuditTable; entityId: string; metadata: { event: "EXPIRED_QUOTE_CONFIRMED"; action: ExpiredQuoteAction; validUntil: string; daysExpired: number } } {
  return {
    action: action === "send" ? "SEND" : "ACCEPT",
    entityTable: "quotes",
    entityId: quoteRef,
    metadata: { event: "EXPIRED_QUOTE_CONFIRMED", action, validUntil: check.validUntil, daysExpired: check.daysExpired },
  };
}
