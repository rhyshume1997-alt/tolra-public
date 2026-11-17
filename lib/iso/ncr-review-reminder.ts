/**
 * Internal reminder: confirmed NCRs that have been open longer than a number of calendar days (London dates). Inputs: the register's
 * rows (lib/jobs/ncr-register.ts buildNcrRows, imported, not copied), today's date and the number of days. Output: the overdue rows.
 * Must not change: it is a reminder only. Its output is never an input to lib/iso/gap-checklist.ts, so it can never move a clause
 * status (tests/unit/iso-ncr-reminder.test.ts). Legacy "Not linked" failed inspections are not confirmed NCRs and are never listed.
 *
 * Pure (no React, no browser, no I/O).
 */
import { toDateInput } from "@/lib/dates";
import { buildNcrRows, daysBetween, type NcrRow, type NcrSources } from "@/lib/jobs/ncr-register";

export const REVIEW_DAYS_DEFAULT = 7;

/** The typed override as a whole number of days (1 or more); anything else is the default. */
export function reviewDays(typed: string | number | null | undefined): number {
  const n = typeof typed === "number" ? typed : Number(String(typed ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : REVIEW_DAYS_DEFAULT;
}

export type OverdueNcr = { row: NcrRow; daysOpen: number };

/** Confirmed, open NCRs raised more than `days` calendar days before today (London dates), oldest first. */
export function overdueNcrs(rows: NcrRow[], now: Date | string = new Date(), days = REVIEW_DAYS_DEFAULT): OverdueNcr[] {
  const today = toDateInput(now);
  return rows
    .filter((r) => r.recordClass === "Confirmed NCR" && r.open && !r.notLinked && Boolean(r.raisedDate))
    .map((row) => ({ row, daysOpen: daysBetween(row.raisedDate, today) }))
    .filter((o) => o.daysOpen > days)
    .sort((a, b) => b.daysOpen - a.daysOpen || a.row.key.localeCompare(b.row.key));
}

/** The same, straight from the register's sources. */
export function overdueFromSources(sources: NcrSources, now: Date | string = new Date(), days = REVIEW_DAYS_DEFAULT): OverdueNcr[] {
  return overdueNcrs(buildNcrRows(sources, now), now, days);
}

/** How many confirmed NCRs are open (any age), for the "open nonconformance records" fact. */
export function openConfirmedCount(rows: NcrRow[]): number {
  return rows.filter((r) => r.recordClass === "Confirmed NCR" && r.open).length;
}
