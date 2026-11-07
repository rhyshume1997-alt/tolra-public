import { nowIso } from "@/lib/dates";

/**
 * What the approval queue shows: drafted e-mails that aren't snoozed (skipped_until empty or already passed).
 * Every count of "emails needing approval" uses this same rule, so the number matches the list (audit D28).
 */
type Filterable = { eq(column: string, value: string): Filterable; or(filters: string): Filterable; in(column: string, values: string[]): Filterable };

export function awaitingApproval<T>(query: T, now: string = nowIso()): T {
  return (query as unknown as Filterable).eq("status", "drafted").or(`skipped_until.is.null,skipped_until.lt.${now}`) as unknown as T;
}

/**
 * Messages whose outcome is not known: 'unknown' (a timeout, an answer that could not be trusted) or 'sending' (claimed, and the app
 * stopped before it recorded an answer). They are NOT in the queue to approve: a person checks and settles them first, and nothing is
 * retried or sent another way until then.
 */
export function needsChecking<T>(query: T): T {
  return (query as unknown as Filterable).in("status", ["unknown", "sending"]) as unknown as T;
}
