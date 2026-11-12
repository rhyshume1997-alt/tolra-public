/**
 * BOUNDARY (tests only). Input: none. Output: pinClock() / unpinClock() fix ONLY Date (timers stay real) at PRICE_TEST_NOW, and importing
 * this file replaces the shipped (EMPTY) USD_GBP_RATES with ONE TEST-ONLY row (TEST_RATE, GBP 0.80 per USD 1, effective at
 * PRICE_TEST_NOW), so suites that reach estimatePence through server.ts do not depend on today's date or on a recorded production rate.
 * The row is a test stand-in, never a real rate. Must not be used to hide staleness behaviour: ai-provider-pricing.test.ts and
 * ai-fx.test.ts pass their own `now` and tables and cover every refusal, and ai-provider-pricing.test.ts proves the shipped table is empty.
 */
import { vi } from "vitest";

vi.mock("@/lib/ai-helper/fx", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai-helper/fx")>();
  return { ...real, USD_GBP_RATES: [{ microGbpPerUsd: BigInt(800_000), source: "test-only stand-in (not a real rate)", effectiveAt: "2026-11-12T00:00:00Z" }] };
});

export const PRICE_TEST_NOW = new Date("2026-11-12T00:00:00Z");
/** The stand-in rate the mock installs (same value as in the factory above). */
export const TEST_RATE = { microGbpPerUsd: BigInt(800_000), source: "test-only stand-in (not a real rate)", effectiveAt: "2026-11-12T00:00:00Z" } as const;

export function pinClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PRICE_TEST_NOW);
}

export function unpinClock(): void {
  vi.useRealTimers();
}
