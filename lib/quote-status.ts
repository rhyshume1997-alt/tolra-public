/**
 * Quote lifecycle (audit D1). Stored statuses move forward only (migration 020): draft -> sent -> accepted |
 * rejected. "Expired" is derived: a draft or sent quote whose valid-until date has passed shows as expired (go-live polish item
 * 19b: a quote past its date and not decided is Expired, whether or not it went out). An accepted or rejected quote never expires,
 * and nothing is written when a quote expires: the stored status stays draft or sent (a draft past its date can still be edited and
 * given a new date, but not sent until it has one).
 */
import { baseQuoteRef } from "@/lib/quote-versions";

export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired" | "superseded";

/** "superseded": a sent quote revised as a newer version (migration 068). Final and read only; it counts in no figure but its own. */
const STATUSES: QuoteStatus[] = ["draft", "sent", "accepted", "rejected", "expired", "superseded"];

export function storedQuoteStatus(value: unknown): QuoteStatus {
  const status = String(value ?? "draft").toLowerCase() as QuoteStatus;
  return STATUSES.includes(status) ? status : "draft";
}

/** What to show: expired once valid-until is before today (valid on its last day) for a quote still undecided. */
export function effectiveQuoteStatus(stored: QuoteStatus, validUntil: string | null | undefined, today: string): QuoteStatus {
  if ((stored === "sent" || stored === "draft") && validUntil && validUntil.slice(0, 10) < today.slice(0, 10)) return "expired";
  return stored;
}

/** The customer's decision can be recorded while the stored status is draft or sent. */
export const canRecordDecision = (stored: QuoteStatus) => stored === "draft" || stored === "sent";

// ----- the figures --------------------------------------------------------------------------------------------------------------
/**
 * declined_value: what the lines the customer's PO didn't cover came to on the quote (068, lib/quote-versions declinedValueByQuote).
 * An accepted quote counts only what was ordered: its total less that.
 */
export type QuoteFigureRow = { status: unknown; valid_until?: unknown; total_value?: unknown; declined_value?: unknown };
export type Bucket = { count: number; value: number };
export type QuoteFigures = {
  byStatus: Record<QuoteStatus, Bucket>;
  /** Open: sent to the customer, still valid, no decision yet (the Quote Generator's "Open Quotes"; the dashboard's "Open Quotes",
   *  its pipeline value and the pipeline's "Quotes sent"). */
  open: Bucket;
  /** Drafts: not sent yet and still within their date. */
  drafts: Bucket;
  /** Expired quotes that had been sent (an expired draft never reached the customer). */
  expiredSent: Bucket;
  /**
   * Win rate = accepted / (accepted + rejected + expired-sent), in whole percent; null when that is 0. Only quotes the customer
   * received count: an expired draft was never sent, so it is in neither the numerator nor the denominator.
   */
  winRate: number | null;
};

const pence = (value: unknown) => Math.round((Number(value) || 0) * 100);

/** One definition of every quote figure, for the Quote Generator and the dashboard (go-live polish item 18). */
export function quoteFigures(rows: QuoteFigureRow[], today: string): QuoteFigures {
  const totals = Object.fromEntries(STATUSES.map((status) => [status, { count: 0, pence: 0 }])) as Record<QuoteStatus, { count: number; pence: number }>;
  const expiredSent = { count: 0, pence: 0 };
  for (const row of rows) {
    const stored = storedQuoteStatus(row.status);
    const status = effectiveQuoteStatus(stored, typeof row.valid_until === "string" ? row.valid_until : null, today);
    totals[status].count += 1;
    // Accepted for part of its lines (068): only the ordered lines are won.
    totals[status].pence += stored === "accepted" ? Math.max(0, pence(row.total_value) - pence(row.declined_value)) : pence(row.total_value);
    if (status === "expired" && stored === "sent") {
      expiredSent.count += 1;
      expiredSent.pence += pence(row.total_value);
    }
  }
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, { count: totals[status].count, value: totals[status].pence / 100 }])) as Record<QuoteStatus, Bucket>;
  const decided = byStatus.accepted.count + byStatus.rejected.count + expiredSent.count;
  return {
    byStatus, open: byStatus.sent, drafts: byStatus.draft, expiredSent: { count: expiredSent.count, value: expiredSent.pence / 100 },
    winRate: decided ? Math.round((byStatus.accepted.count / decided) * 100) : null,
  };
}

/** Quotes recorded as sent on or after `since` (YYYY-MM-DD, the first of the month): the dashboard's "Quotes Sent this month". */
export function sentSince(rows: Array<{ sent_at?: unknown; quote_ref?: unknown; version?: unknown }>, since: string): number {
  // Each quote once, however many of its versions (068: "QUO-0123", "QUO-0123 v2") were sent in the period.
  const quotes = new Set<string>();
  rows.forEach((row, index) => {
    if (typeof row.sent_at !== "string" || row.sent_at.slice(0, 10) < since) return;
    quotes.add(typeof row.quote_ref === "string" && row.quote_ref ? `ref:${baseQuoteRef(row.quote_ref, Number(row.version ?? 1) || 1)}` : `row:${index}`);
  });
  return quotes.size;
}

/** Newest first by date (created), then by reference so the order is the same on every load. */
export function newestFirst<T extends { date?: string; ref: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.ref.localeCompare(a.ref));
}

// ----- default validity ---------------------------------------------------------------------------------------------------------
/** Used when the company's quote terms don't say how long a quote is valid. */
export const DEFAULT_QUOTE_VALIDITY_DAYS = 30;

/** Days a quote is valid for, read from the company's default quote terms ("Valid for 30 days"), else 30. */
export function quoteValidityDays(defaultQuoteTerms: string | null | undefined): number {
  const match = /valid\s+(?:for\s+)?(\d{1,3})\s+days?/i.exec(defaultQuoteTerms ?? "");
  const days = match ? Number(match[1]) : NaN;
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_QUOTE_VALIDITY_DAYS;
}

/** The valid-until date for a quote issued on `issued` (YYYY-MM-DD) with no date of its own: issue date + the validity days. */
export function defaultValidUntil(issued: string, days: number): string {
  const [y, m, d] = issued.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Why a quote cannot be sent, or null when it can: a £0.00 quote has nothing to charge for, so prices must be added first. */
export function quoteSendBlock(ref: string, totalValue: unknown): string | null {
  return pence(totalValue) <= 0 ? `${ref} is £0.00, so it can't be sent. Add prices to its lines first.` : null;
}

/** How many quotes are in each (shown) status: the legend and the bar above the list, counted over the quotes in the current Show scope. */
export function statusCounts(rows: Array<{ status: QuoteStatus }>): Record<QuoteStatus, number> {
  const counts: Record<QuoteStatus, number> = { draft: 0, sent: 0, accepted: 0, rejected: 0, expired: 0, superseded: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** What to tell the person after an attachment upload: count what really went up, and name what was skipped for size. */
export function uploadSummary(uploaded: number, skippedTooBig: string[]): string {
  if (uploaded === 0) {
    return skippedTooBig.length ? `Nothing was uploaded: ${skippedTooBig.length === 1 ? `${skippedTooBig[0]} is` : `${skippedTooBig.length} files are`} larger than 20 MB.` : "Nothing was uploaded.";
  }
  return uploaded === 1 ? "1 attachment uploaded" : `${uploaded} attachments uploaded`;
}
