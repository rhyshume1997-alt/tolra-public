/**
 * The filter a list page applies on load from its URL (?filter=...), so the dashboard's "View all" opens exactly the rows its
 * count covered, and the link can be shared. Unknown pages or values mean no filter (the page opens as normal).
 * The tests here match the "Needs attention" rules in lib/attention-items (same days, same dates), applied to the rows the
 * list pages already hold.
 */
import { calendarDate } from "@/lib/dates";
import { daysBetween, DELIVERY_AWAITING_DAYS, DRAFT_INVOICE_DAYS, QUOTE_NO_DECISION_DAYS } from "@/lib/attention-items";
import { requiredDate } from "@/lib/job-status";
import { isOpenDraft } from "@/lib/open-drafts";
import { statusCounts, type QuoteStatus } from "@/lib/quote-status";

export const LIST_FILTERS = {
  quotes: ["expired", "no-decision"],
  invoices: ["overdue", "draft-old"],
  "purchase-orders": ["late"],
  jobs: ["overdue", "awaiting-inspection"],
  "delivery-notes": ["awaiting-old", "not-invoiced"],
  rfq: ["clarification"],
} as const;

export type ListFilterPage = keyof typeof LIST_FILTERS;

/** The known filter named by a query string ("?filter=expired") for this page, or null (missing, unknown, or for another page). */
export function parseListFilter(page: ListFilterPage, search: string | URLSearchParams | null | undefined): string | null {
  if (search == null) return null;
  const value = (typeof search === "string" ? new URLSearchParams(search) : search).get("filter");
  if (!value) return null;
  const known: readonly string[] = LIST_FILTERS[page] ?? [];
  return known.includes(value) ? value : null;
}

const day = (value: unknown) => calendarDate(typeof value === "string" ? value : "");

/** `rawStatus` is the STORED status; `validUntil` a date; `sentAt` a timestamp. */
export function quoteMatchesFilter(filter: string, q: { rawStatus: string; validUntil?: string; sentAt?: string }, today: string): boolean {
  const until = day(q.validUntil);
  const expired = (q.rawStatus === "draft" || q.rawStatus === "sent") && Boolean(until) && until < today;
  if (filter === "expired") return expired;
  if (filter === "no-decision") {
    const sent = day(q.sentAt);
    return q.rawStatus === "sent" && !expired && Boolean(sent) && daysBetween(sent, today) > QUOTE_NO_DECISION_DAYS;
  }
  return true;
}

/** What each Quotes dashboard link means, in words: the dashboard rule counts the same quotes (lib/attention-items "quotes-expired"). */
export const QUOTE_FILTER_LABELS: Record<string, string> = { expired: "Draft or sent quotes past their valid-until date", "no-decision": "Sent quotes with no decision" };

/**
 * The Quotes status legend (Draft / Sent / ... Expired counts). With a dashboard link's filter it counts exactly the quotes that
 * filter lists, so "Expired (4)" matches the dashboard's 4; otherwise it counts the Show tab (Open / Done / Archived / All).
 * `status` is the displayed status; an expired quote is final, so it sits under Done (or Archived), never Open.
 */
export function quoteLegend<Q extends { status: QuoteStatus; rawStatus: string; validUntil?: string; sentAt?: string }>(
  quotes: readonly Q[], listFilter: string | null, today: string, inShowTab: (quote: Q) => boolean, showTabLabel: string,
): { counts: Record<QuoteStatus, number>; scope: string } {
  if (listFilter) return { counts: statusCounts(quotes.filter((quote) => quoteMatchesFilter(listFilter, quote, today))), scope: QUOTE_FILTER_LABELS[listFilter] ?? listFilter };
  return { counts: statusCounts(quotes.filter(inShowTab)), scope: `In ${showTabLabel}` };
}

/** `status` is the displayed status (lib/receivables: "overdue" already means collectible, confirmed, owing and past due). */
export function invoiceMatchesFilter(filter: string, i: { status: string; rawStatus: string; createdAt?: string }, today: string, archived = false): boolean {
  if (filter === "overdue") return i.status === "overdue";
  if (filter === "draft-old") {
    const created = day(i.createdAt);
    return isOpenDraft(i.rawStatus, archived) && Boolean(created) && daysBetween(created, today) > DRAFT_INVOICE_DAYS;
  }
  return true;
}

/** Invoicing's drafts line: every open draft (lib/open-drafts: archived ones, per record_archive_state, are left out), and how many of them are over DRAFT_INVOICE_DAYS old (the ones the dashboard counts). */
export function draftInvoiceCounts<I extends { status: string; rawStatus: string; createdAt?: string }>(invoices: ReadonlyArray<I>, today: string, isArchived: (invoice: I) => boolean = () => false): { total: number; old: number } {
  const drafts = invoices.filter((invoice) => isOpenDraft(invoice.rawStatus, isArchived(invoice)));
  return { total: drafts.length, old: drafts.filter((invoice) => invoiceMatchesFilter("draft-old", invoice, today, false)).length };
}

export function purchaseOrderMatchesFilter(filter: string, po: { status: string; delivery?: string; receivedAt?: string }, today: string): boolean {
  if (filter !== "late") return true;
  const due = day(po.delivery);
  return Boolean(due) && due < today && !po.receivedAt && !["draft", "received", "cancelled"].includes(po.status.toLowerCase());
}

export function jobMatchesFilter(filter: string, job: { finished_at?: string | null; inspected_at?: string | null; stage?: string | null; date_required?: string | null; due_date?: string | null }, today: string): boolean {
  if (filter === "overdue") {
    const due = requiredDate({ date_required: job.date_required, due_date: job.due_date });
    return !job.finished_at && Boolean(due) && due < today;
  }
  if (filter === "awaiting-inspection") return Boolean(job.finished_at) && !job.inspected_at && job.stage !== "rework";
  return true;
}

/** Awaiting is counted from its last change (when it was set awaiting), else from creation. */
export function deliveryNoteMatchesFilter(filter: string, n: { status: string; invoiceId?: string | null; updatedAt?: string; createdAt?: string }, today: string): boolean {
  if (filter === "awaiting-old") {
    const since = day(n.updatedAt) || day(n.createdAt);
    return n.status === "awaiting" && Boolean(since) && daysBetween(since, today) > DELIVERY_AWAITING_DAYS;
  }
  if (filter === "not-invoiced") return ["despatched", "delivered", "signed"].includes(n.status) && !n.invoiceId;
  return true;
}
