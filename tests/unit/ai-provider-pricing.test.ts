/**
 * BOUNDARY (Integrations module, AI-1): pricing in lib/ai-helper/pricing-gbp.ts. Inputs: injected clocks, price tables and rate tables (the
 * TEST rate below, GBP 0.80 per USD 1, is a stand-in and never a real rate). Proves: integer GBP pence = ceil(tokens x USD list price x
 * USD->GBP rate) in BigInt only, never below the exact value and at most 1p above, round up at a penny boundary, an estimate over 1000p
 * is refused, and a missing, stale or unusable price or rate refuses before anything is reserved or sent. Must not be loosened.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { USD_GBP_RATES, type UsdGbpRate } from "@/lib/ai-helper/fx";
import { AI_HELPER_MODELS } from "@/lib/ai-helper/limits";
import { MAX_REQUEST_PENCE_GBP as MAX_REQUEST_PENCE, MODEL_PRICES_GBP as MODEL_PRICES, type ModelPrice, PRICE_MAX_AGE_DAYS, actualPenceGbp as actualPence, estimatePenceGbp as estimatePence, priceForGbp as priceFor } from "@/lib/ai-helper/pricing-gbp";

const NOW = new Date("2026-11-12T00:00:00Z");
const RATES: readonly UsdGbpRate[] = [{ microGbpPerUsd: BigInt(800_000), source: "test stand-in", effectiveAt: "2026-11-12T00:00:00Z" }]; // GBP 0.80 per USD 1
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const est = (model: string, bytes: number, maxOut: number, now = NOW, rates = RATES) => estimatePence(model, bytes, maxOut, "anthropic", now, rates);
const act = (model: string, i: number, o: number, now = NOW, rates = RATES) => actualPence(model, { inputTokens: i, outputTokens: o }, "anthropic", now, rates);


describe("known values (hand-calculated at GBP 0.80 per USD 1)", () => {
  it("1M Opus input tokens: $4 x 0.80 = GBP 3.20 = 320p; 1M Sonnet output tokens: $10 x 0.80 = GBP 8.00 = 800p", () => {
    expect(act(OPUS, 1_000_000, 0)).toBe(320);
    expect(act(SONNET, 0, 1_000_000)).toBe(800);
    expect(act(OPUS, 0, 1_000_000)).toBe(1000); // $20 x 0.80 = GBP 16 = 1600p, capped at 1000p
    expect(act(SONNET, 1_000_000, 0)).toBe(160);
  });

  it("estimate, Opus, 40,000 bytes + 200 framing in, 8,000 out: 40,200 x 0.00032p + 8,000 x 0.0016p = 12.864 + 12.8 = 25.664 -> 26p", () => {
    expect(est(OPUS, 40_000, 8000)).toBe(26);
  });

  it("estimate, Sonnet, 0 bytes + 200 framing in, 2,000 out: 200 x 0.00016p + 2,000 x 0.0008p = 0.032 + 1.6 = 1.632 -> 2p", () => {
    expect(est(SONNET, 0, 2000)).toBe(2);
  });

  it("input and output are summed before the one ceiling: 0.4 + 0.4 -> 1p (not 1 + 1)", () => {
    // Opus input 1,250 tokens = 0.4p; output 250 tokens x 0.0016p = 0.4p; total 0.8p -> 1p.
    expect(act(OPUS, 1250, 250)).toBe(1);
    expect(act(OPUS, 3126, 0)).toBe(2); // 3,126 x 0.00032p = 1.00032p -> 2p
  });

  it("the minimum estimate is 1p (the smallest request), and actual usage of zero is 0p", () => {
    expect(est(SONNET, 0, 0)).toBe(1);
    expect(act(OPUS, 0, 0)).toBe(0);
    expect(act(OPUS, -5, -1)).toBe(0);
  });

  it("old vs new (cent = penny removed): at GBP 0.80 per USD 1 the estimate is lower than the old formula's", () => {
    const old = (p: { i: number; o: number }, bytes: number, maxOut: number) => Math.max(1, Math.ceil(((bytes + 200) * p.i + maxOut * p.o) / 1_000_000 * 100));
    expect(old({ i: 4, o: 20 }, 40_000, 8000)).toBe(33);
    expect(est(OPUS, 40_000, 8000)).toBe(26);
    expect(old({ i: 2, o: 10 }, 0, 2000)).toBe(3);
    expect(est(SONNET, 0, 2000)).toBe(2);
  });
});

describe("rounds up, never down", () => {
  it("exactly on a penny boundary is not bumped: 3,125 Opus input tokens x 0.00032p = exactly 1p; one more token gives 2p", () => {
    expect(act(OPUS, 3125, 0)).toBe(1);
    expect(act(OPUS, 3126, 0)).toBe(2);
    expect(act(OPUS, 6250, 0)).toBe(2);
    expect(act(OPUS, 6251, 0)).toBe(3);
  });
});

describe("property: against an independent BigInt reference", () => {
  // Reference: smallest whole p with p x 10^18 >= tokens-weighted numerator (compared by the definition, not by ceilDiv).
  const numerator = (i: number, o: number, price: ModelPrice, rate: bigint) => (BigInt(i) * price.inputMicroUsdPerMTok + BigInt(o) * price.outputMicroUsdPerMTok) * rate * BigInt(100);
  it("never below the exact value, and at most 1p above it (2,000 random cases, both models, varied rates)", () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let k = 0; k < 2000; k += 1) {
      const model = k % 2 ? OPUS : SONNET;
      const price = MODEL_PRICES[model];
      const rate = BigInt(100_000 + rnd(2_000_000));
      const i = rnd(1_000_000);
      const o = rnd(40_000);
      const n = numerator(i, o, price, rate);
      const tbl: readonly UsdGbpRate[] = [{ microGbpPerUsd: rate, source: "t", effectiveAt: "2026-11-12T00:00:00Z" }];
      const got = BigInt(act(model, i, o, NOW, tbl));
      const capped = got === BigInt(MAX_REQUEST_PENCE);
      if (!capped) {
        expect(got * BigInt(10) ** BigInt(18) >= n, `never below: ${model} ${i} ${o} ${rate}`).toBe(true);
        expect((got - BigInt(1)) * BigInt(10) ** BigInt(18) < n || got === BigInt(0), `at most 1p above: ${model} ${i} ${o} ${rate}`).toBe(true);
      } else {
        expect(n >= BigInt(999) * BigInt(10) ** BigInt(18)).toBe(true);
      }
    }
  });
});

describe("no floats on money paths", () => {
  it("prices and the rate are bigint; the money functions use no Math.ceil / Math.round / floating division", () => {
    for (const p of Object.values(MODEL_PRICES)) { expect(typeof p.inputMicroUsdPerMTok).toBe("bigint"); expect(typeof p.outputMicroUsdPerMTok).toBe("bigint"); }
    const limits = readFileSync(path.join(process.cwd(), "lib/ai-helper/pricing-gbp.ts"), "utf8");
    const fx = readFileSync(path.join(process.cwd(), "lib/ai-helper/fx.ts"), "utf8");
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const money = code(limits).slice(code(limits).indexOf("const ceilDiv"));
    expect(money).not.toMatch(/Math\.(ceil|floor|round|trunc)/);
    expect(code(fx)).not.toMatch(/Math\.|parseFloat|toFixed/);
    expect(money).not.toMatch(/\)\s*\/\s*1_?000_?000/);
  });

  it("a fractional, NaN, infinite or negative size or output cap is refused, not rounded", () => {
    for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, -1, 2 ** 60]) {
      expect(() => est(OPUS, bad, 1), `bytes ${bad}`).toThrow(/Invalid/);
      expect(() => est(OPUS, 1, bad), `out ${bad}`).toThrow(/Invalid/);
    }
  });
});

describe("one table, no invented prices", () => {
  it("the live features still use the same Anthropic models and the recorded list prices ($4/$20 and $2/$10 per million)", () => {
    expect(AI_HELPER_MODELS).toEqual({ rfq: OPUS, roundup: SONNET, assistant: SONNET });
    expect(MODEL_PRICES[OPUS]).toMatchObject({ provider: "anthropic", inputMicroUsdPerMTok: BigInt(4_000_000), outputMicroUsdPerMTok: BigInt(20_000_000), asOf: "2026-11-11" });
    expect(MODEL_PRICES[SONNET]).toMatchObject({ provider: "anthropic", inputMicroUsdPerMTok: BigInt(2_000_000), outputMicroUsdPerMTok: BigInt(10_000_000), asOf: "2026-11-11" });
    for (const p of Object.values(MODEL_PRICES)) { expect(p.source.length).toBeGreaterThan(0); expect(p.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
  });

  it("no OpenAI or xAI price exists, so any of their models is refused", () => {
    expect(Object.values(MODEL_PRICES).filter((p) => p.provider !== "anthropic")).toEqual([]);
    for (const provider of ["openai", "xai"] as const) for (const model of ["gpt-anything", "grok-anything", OPUS]) {
      expect(priceFor(provider, model, NOW).ok).toBe(false);
      expect(() => estimatePence(model, 1, 1, provider, NOW, RATES)).toThrow();
    }
  });

  it("MAX_REQUEST_PENCE mirrors the database's per-request bound (133:67, 134:119)", () => {
    expect(MAX_REQUEST_PENCE).toBe(1000);
    for (const file of ["133_ai_helper_pre_enable.sql", "134_ai_assistant.sql"]) {
      expect(readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8")).toContain("p_estimate_pence NOT BETWEEN 1 AND 1000");
    }
  });
});

describe("fail closed: price", () => {
  const row = (over: Partial<ModelPrice>): Record<string, ModelPrice> => ({ m: { provider: "anthropic", inputMicroUsdPerMTok: BigInt(1), outputMicroUsdPerMTok: BigInt(1), source: "test", asOf: "2026-11-11", ...over } });
  const day = (n: number) => new Date(Date.parse("2026-11-11T00:00:00Z") + n * 86_400_000);

  it("unknown model, another provider's model and prototype keys are refused", () => {
    expect(priceFor("anthropic", "unknown-model", NOW)).toEqual({ ok: false, reason: "unknown" });
    expect(priceFor("anthropic", "constructor", NOW)).toEqual({ ok: false, reason: "unknown" });
    expect(priceFor("openai", OPUS, NOW)).toEqual({ ok: false, reason: "provider_mismatch" });
    expect(() => est("unknown-model", 1, 1)).toThrow(/unknown/);
  });

  it("stale: refused once older than PRICE_MAX_AGE_DAYS, usable up to that day", () => {
    expect(priceFor("anthropic", OPUS, day(PRICE_MAX_AGE_DAYS)).ok).toBe(true);
    expect(priceFor("anthropic", OPUS, day(PRICE_MAX_AGE_DAYS + 1))).toEqual({ ok: false, reason: "stale" });
  });

  it("PM ruling 12 Nov: 90 days. A price exactly 90 days old is accepted; 90 days + 1 ms is stale", () => {
    expect(PRICE_MAX_AGE_DAYS).toBe(90);
    const exact = new Date(Date.parse("2026-11-11T00:00:00Z") + 90 * 86_400_000);
    expect(priceFor("anthropic", OPUS, exact).ok).toBe(true);
    expect(priceFor("anthropic", OPUS, new Date(exact.getTime() + 1))).toEqual({ ok: false, reason: "stale" });
  });

  it("the Anthropic rows (asOf 2026-11-11) are usable at the fixed test clock", () => {
    for (const model of [OPUS, SONNET]) expect(priceFor("anthropic", model, NOW).ok).toBe(true);
  });

  it("not yet effective, bad dates and unusable prices are refused", () => {
    expect(priceFor("anthropic", "m", day(1), row({ effectiveFrom: "2026-11-20" }))).toEqual({ ok: false, reason: "not_yet_effective" });
    expect(priceFor("anthropic", "m", day(10), row({ effectiveFrom: "2026-11-20" })).ok).toBe(true);
    expect(priceFor("anthropic", "m", day(-1), row({}))).toEqual({ ok: false, reason: "not_yet_effective" });
    expect(priceFor("anthropic", "m", day(1), row({ asOf: "11/11/2026" }))).toEqual({ ok: false, reason: "bad_date" });
    expect(priceFor("anthropic", "m", new Date(Number.NaN), row({}))).toEqual({ ok: false, reason: "bad_date" });
    for (const bad of [BigInt(0), -BigInt(1), 1.5 as never, "4" as never]) {
      expect(priceFor("anthropic", "m", day(1), row({ inputMicroUsdPerMTok: bad }))).toEqual({ ok: false, reason: "bad_price" });
      expect(priceFor("anthropic", "m", day(1), row({ outputMicroUsdPerMTok: bad }))).toEqual({ ok: false, reason: "bad_price" });
    }
  });
});

describe("fail closed: rate", () => {
  const H = 3_600_000;
  it("missing (the shipped table is empty): estimate throws, actual is charged the 1000p maximum", () => {
    expect(USD_GBP_RATES).toEqual([]);
    expect(() => estimatePence(OPUS, 1, 1, "anthropic", NOW)).toThrow(/missing/);
    expect(actualPence(OPUS, { inputTokens: 1, outputTokens: 1 }, "anthropic", NOW)).toBe(MAX_REQUEST_PENCE);
  });

  it("stale (over 24h), not yet in effect and bad rates are refused", () => {
    expect(est(OPUS, 1, 1, new Date(NOW.getTime() + 24 * H))).toBeGreaterThan(0);
    expect(() => est(OPUS, 1, 1, new Date(NOW.getTime() + 24 * H + 1))).toThrow(/stale/);
    expect(() => est(OPUS, 1, 1, new Date(NOW.getTime() - 1))).toThrow(/not_yet_effective/);
    for (const bad of [BigInt(0), -BigInt(1)]) expect(() => est(OPUS, 1, 1, NOW, [{ ...RATES[0], microGbpPerUsd: bad }])).toThrow(/bad_rate/);
    expect(() => est(OPUS, 1, 1, NOW, [{ ...RATES[0], effectiveAt: "yesterday" }])).toThrow(/bad_date/);
    expect(act(OPUS, 1, 1, new Date(NOW.getTime() + 25 * H))).toBe(MAX_REQUEST_PENCE);
  });
});

describe("1000p maximum", () => {
  it("an estimate of exactly 1000p is allowed; one more byte (1001p) is refused, not clamped", () => {
    // 3,124,800 bytes + 200 framing = 3,125,000 tokens x 0.00032p = exactly 1000p.
    expect(est(OPUS, 3_124_800, 0)).toBe(1000);
    expect(() => est(OPUS, 3_124_801, 0)).toThrow(/1000p/);
  });

  it("actualPence never exceeds 1000p and never borrows another model's price", () => {
    expect(act(OPUS, 10_000_000, 0)).toBe(1000);
    expect(act("unknown-model", 1, 1)).toBe(MAX_REQUEST_PENCE);
    expect(actualPence(OPUS, { inputTokens: 1, outputTokens: 1 }, "openai", NOW, RATES)).toBe(MAX_REQUEST_PENCE);
    expect(readFileSync(path.join(process.cwd(), "lib/ai-helper/pricing-gbp.ts"), "utf8")).not.toMatch(/\?\?\s*(PRICES_USD_PER_MTOK|MODEL_PRICES)\[/);
  });
});
