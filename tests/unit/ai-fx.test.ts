/**
 * BOUNDARY (Integrations module, AI-1): lib/ai-helper/fx.ts. Inputs: injected clocks and rate tables. Proves: the shipped table is
 * empty (no rate is invented), every refusal reason, the 24-hour limit to the millisecond, and which row is chosen. Must not be loosened.
 */
import { describe, expect, it } from "vitest";

import { RATE_MAX_AGE_HOURS, USD_GBP_RATES, type UsdGbpRate, rateFor } from "@/lib/ai-helper/fx";

const AT = "2026-11-12T09:00:00Z";
const t0 = Date.parse(AT);
const row = (over: Partial<UsdGbpRate> = {}): UsdGbpRate => ({ microGbpPerUsd: BigInt(790_000), source: "test", effectiveAt: AT, ...over });
const at = (ms: number) => new Date(t0 + ms);
const H = 3_600_000;

describe("rateFor fails closed", () => {
  it("ships empty: no rate value is invented, so production refuses until one is recorded", () => {
    expect(USD_GBP_RATES).toEqual([]);
    expect(rateFor(new Date())).toEqual({ ok: false, reason: "missing" });
  });

  it("the maximum age is 24 hours: usable at exactly 24h, stale 1ms later", () => {
    expect(RATE_MAX_AGE_HOURS).toBe(24);
    expect(rateFor(at(0), [row()]).ok).toBe(true);
    expect(rateFor(at(24 * H), [row()]).ok).toBe(true);
    expect(rateFor(at(24 * H + 1), [row()])).toEqual({ ok: false, reason: "stale" });
    expect(rateFor(at(30 * 24 * H), [row()])).toEqual({ ok: false, reason: "stale" });
  });

  it("not yet effective: before the effective timestamp", () => {
    expect(rateFor(at(-1), [row()])).toEqual({ ok: false, reason: "not_yet_effective" });
  });

  it("bad rate: zero, negative and non-bigint values, and a missing source", () => {
    for (const bad of [BigInt(0), -BigInt(1)]) expect(rateFor(at(0), [row({ microGbpPerUsd: bad })])).toEqual({ ok: false, reason: "bad_rate" });
    for (const bad of [0.79, Number.NaN, "790000", undefined, null]) expect(rateFor(at(0), [row({ microGbpPerUsd: bad as never })])).toEqual({ ok: false, reason: "bad_rate" });
    expect(rateFor(at(0), [row({ source: "" })])).toEqual({ ok: false, reason: "bad_rate" });
  });

  it("bad date: a non-ISO or non-UTC timestamp, a date only, an invalid clock", () => {
    for (const bad of ["", "2026-11-12", "12/11/2026", "2026-11-12T09:00:00", "2026-11-12T09:00:00+01:00", "2026-13-45T00:00:00Z", "not a date"]) {
      expect(rateFor(at(0), [row({ effectiveAt: bad })]), bad).toEqual({ ok: false, reason: "bad_date" });
    }
    expect(rateFor(new Date(Number.NaN), [row()])).toEqual({ ok: false, reason: "bad_date" });
  });

  it("one unusable row refuses the whole table", () => {
    expect(rateFor(at(0), [row(), row({ microGbpPerUsd: BigInt(0), effectiveAt: "2026-11-01T00:00:00Z" })])).toEqual({ ok: false, reason: "bad_rate" });
  });
});

describe("rateFor chooses the rate in force", () => {
  it("the latest row at or before now wins; a future row is ignored until it takes effect", () => {
    const older = row({ microGbpPerUsd: BigInt(780_000), effectiveAt: "2026-11-12T01:00:00Z" });
    const newer = row({ microGbpPerUsd: BigInt(790_000), effectiveAt: AT });
    const future = row({ microGbpPerUsd: BigInt(800_000), effectiveAt: "2026-11-12T12:00:00Z" });
    const table = [future, older, newer];
    expect(rateFor(at(0), table)).toEqual({ ok: true, rate: newer });
    expect(rateFor(at(-1 * H), table)).toEqual({ ok: true, rate: older });
    expect(rateFor(at(3 * H), table)).toEqual({ ok: true, rate: future });
  });

  it("the rate keeps its source and effective timestamp (recorded, not derived)", () => {
    const r = rateFor(at(H), [row({ source: "Bank of England daily spot (test)" })]);
    expect(r).toMatchObject({ ok: true, rate: { source: "Bank of England daily spot (test)", effectiveAt: AT } });
  });
});
