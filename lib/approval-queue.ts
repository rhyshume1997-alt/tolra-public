import { nowIso } from "@/lib/dates";

/**
 * What the approval queue shows: drafted e-mails that aren't snoozed (skipped_until empty or already passed).
 * Every count of "emails needing approval" uses this same rule, so the number matches the list (audit D28).
 */
type Filterable = { eq(column: string, value: string): Filterable; or(filters: string): Filterable };

export function awaitingApproval<T>(query: T, now: string = nowIso()): T {
  return (query as unknown as Filterable).eq("status", "drafted").or(`skipped_until.is.null,skipped_until.lt.${now}`) as unknown as T;
}
