/**
 * BOUNDARY (Integrations module, AI-1). Inputs: a clock (`now`) and, in tests, an injected rate table. Outputs: the recorded USD->GBP
 * rate in force at `now`, or the reason there is none. Pure: no I/O, no env, no database. Must not change without review: it fails
 * CLOSED (missing, stale, not yet in effect, unusable rate or date all refuse), the maximum age is 24 hours, and no rate value is ever
 * invented, defaulted or read from input.
 *
 * WHO OWNS THE RATE. The platform admin owns the rate source; customers never set rates (PM ruling, 12 Nov). This file is only the typed
 * interface plus a code-level table of recorded rates. USD_GBP_RATES ships EMPTY, so until a verified rate (value, source and effective
 * timestamp) is recorded here every estimate refuses and the AI helper is inert. The platform-admin-configurable source (a DB-backed
 * store the admin writes, with the same recorded fields) is a documented boundary for a later DB-backed change; it needs SQL and is
 * NOT part of this change. Nothing here may be presented as an operational feature.
 */

/** One recorded rate. microGbpPerUsd: millionths of a pound per US dollar (e.g. 790_000 = GBP 0.79 per USD 1). */
export type UsdGbpRate = {
  microGbpPerUsd: bigint;
  /** Where the rate was read (for example a central-bank daily spot rate). */
  source: string;
  /** When the rate took effect: a full ISO-8601 UTC timestamp, e.g. 2026-11-12T09:00:00Z. */
  effectiveAt: string;
};

export type RateRefusal = "missing" | "stale" | "not_yet_effective" | "bad_rate" | "bad_date";

/** The oldest a rate may be at `now`: 24 hours (PM ruling, 12 Nov). */
export const RATE_MAX_AGE_HOURS = 24;
const HOUR_MS = 3_600_000;

/** The recorded rates. EMPTY on purpose: no rate value is invented. Add a row only with a verified value, source and timestamp. */
export const USD_GBP_RATES: readonly UsdGbpRate[] = [];

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const stamp = (iso: unknown): number => (typeof iso === "string" && ISO_UTC.test(iso) ? Date.parse(iso) : Number.NaN);

/** The rate in force at `now` (the latest one effective at or before it), or why there is none. */
export function rateFor(now: Date, table: readonly UsdGbpRate[] = USD_GBP_RATES): { ok: true; rate: UsdGbpRate } | { ok: false; reason: RateRefusal } {
  const t = now.getTime();
  if (!Number.isFinite(t)) return { ok: false, reason: "bad_date" };
  if (table.length === 0) return { ok: false, reason: "missing" };
  let best: { rate: UsdGbpRate; at: number } | undefined;
  let future = false;
  for (const rate of table) {
    const at = stamp(rate?.effectiveAt);
    if (!Number.isFinite(at)) return { ok: false, reason: "bad_date" };
    if (typeof rate.microGbpPerUsd !== "bigint" || rate.microGbpPerUsd <= BigInt(0)) return { ok: false, reason: "bad_rate" };
    if (typeof rate.source !== "string" || rate.source.length === 0) return { ok: false, reason: "bad_rate" };
    if (at > t) { future = true; continue; }
    if (!best || at > best.at) best = { rate, at };
  }
  if (!best) return { ok: false, reason: future ? "not_yet_effective" : "missing" };
  if (t - best.at > RATE_MAX_AGE_HOURS * HOUR_MS) return { ok: false, reason: "stale" };
  return { ok: true, rate: best.rate };
}
