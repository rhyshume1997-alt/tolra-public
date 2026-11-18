/**
 * Monthly AI request allowance (pure functions only).
 *
 * INPUTS: a tier name, a usage record { period, used } and a clock value (Date).
 * OUTPUTS: the tier's monthly request count, requests remaining, whether n more requests can be reserved, and the usage record
 * rolled to the current month. Counts are REQUESTS per company per month, not tokens. The month is the UTC calendar month ("YYYY-MM").
 *
 * MUST NOT CHANGE: tier sizes (small 100, medium 400, large 1500) without a product decision. No I/O, no database, no server
 * wiring, no keys, no flags here: this module only does arithmetic. AI itself stays off; nothing calls this yet.
 */
export type AllowanceTier = "small" | "medium" | "large";

export const ALLOWANCE_REQUESTS_PER_MONTH: Readonly<Record<AllowanceTier, number>> = {
  small: 100,
  medium: 400,
  large: 1500,
};

/** One company's usage in one month. `period` is the UTC month "YYYY-MM"; `used` is requests already reserved or made. */
export type AllowanceUsage = { period: string; used: number };

/** The monthly request count for a tier; null for an unknown tier (so a bad value never grants an allowance). */
export function tierAllowance(tier: string): number | null {
  return Object.prototype.hasOwnProperty.call(ALLOWANCE_REQUESTS_PER_MONTH, tier)
    ? ALLOWANCE_REQUESTS_PER_MONTH[tier as AllowanceTier]
    : null;
}

/** The UTC month key for a moment, e.g. "2026-11". */
export function allowancePeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A usage record for the month of `now`, with nothing used. */
export function emptyUsage(now: Date): AllowanceUsage {
  return { period: allowancePeriod(now), used: 0 };
}

/** Monthly reset: usage from an earlier (or any different) month counts as zero in the current month; same month is unchanged. */
export function resetIfNewMonth(usage: AllowanceUsage, now: Date): AllowanceUsage {
  return usage.period === allowancePeriod(now) ? usage : emptyUsage(now);
}

/** Requests left this month, never below zero. Unknown tier means none. */
export function remainingRequests(tier: string, usage: AllowanceUsage, now: Date): number {
  const limit = tierAllowance(tier);
  if (limit === null) return 0;
  const used = resetIfNewMonth(usage, now).used;
  return Math.max(0, limit - Math.max(0, used));
}

/** True when `count` (a positive whole number, default 1) more requests fit in this month's allowance. */
export function canReserve(tier: string, usage: AllowanceUsage, now: Date, count = 1): boolean {
  if (!Number.isInteger(count) || count < 1) return false;
  return remainingRequests(tier, usage, now) >= count;
}

/** The usage after reserving `count` requests, rolled to the current month; null when it does not fit (nothing is changed). */
export function reserve(tier: string, usage: AllowanceUsage, now: Date, count = 1): AllowanceUsage | null {
  if (!canReserve(tier, usage, now, count)) return null;
  const current = resetIfNewMonth(usage, now);
  return { period: current.period, used: current.used + count };
}
