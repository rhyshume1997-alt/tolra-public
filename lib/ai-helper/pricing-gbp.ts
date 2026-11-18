/**
 * BOUNDARY (Integrations module, AI-1). INACTIVE: nothing in the live path imports this file. lib/ai-helper/server.ts, lib/ai-helper/limits.ts
 * and every app/api/** route must not import or call it (tests/unit/ai-gbp-inactive.test.ts checks this by source). Inputs: provider, model,
 * sizes, a clock and (tests) injected tables. Outputs: integer GBP pence, or a thrown refusal.
 *
 * CURRENCY. Caps and accounting are integer GBP pence. Cost = the provider's USD list price (integer micro-USD per million tokens) times the
 * recorded USD to GBP rate (lib/ai-helper/fx.ts, at most 24 hours old), BigInt arithmetic only, always rounded UP, at most MAX_REQUEST_PENCE_GBP
 * per request. A missing, stale or unusable price or rate fails closed. The live Anthropic path keeps using estimatePence / actualPence in
 * limits.ts unchanged; wiring this path in is a later, separately reviewed change (it needs a server-side guard and a verified rate).
 */
import { type UsdGbpRate, USD_GBP_RATES, rateFor } from "@/lib/ai-helper/fx";
import type { AiProviderId } from "@/lib/ai-helper/provider";

export type ModelPrice = {
  provider: AiProviderId;
  /** List price in integer micro-US-dollars per million tokens (4_000_000 = USD 4.00 per million tokens). */
  inputMicroUsdPerMTok: bigint;
  outputMicroUsdPerMTok: bigint;
  /** Where the price was read. */
  source: string;
  /** The date (YYYY-MM-DD) the price was read; older than PRICE_MAX_AGE_DAYS is stale and refused. */
  asOf: string;
  /** Optional: the date (YYYY-MM-DD) the price starts to apply; refused before it. */
  effectiveFrom?: string;
};

/**
 * THE price table (one source for the server's reservation and settlement). OpenAI and xAI have no rows: their models are refused until
 * a price is supplied with its source and date. Anthropic: the values recorded for AI-1 on 2026-11-11 (PM ruling, 12 Nov).
 */
export const MODEL_PRICES_GBP: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { provider: "anthropic", inputMicroUsdPerMTok: BigInt(4_000_000), outputMicroUsdPerMTok: BigInt(20_000_000), source: "https://platform.claude.com/docs/en/about-claude/pricing", asOf: "2026-11-11" },
  "claude-sonnet-5-5": { provider: "anthropic", inputMicroUsdPerMTok: BigInt(2_000_000), outputMicroUsdPerMTok: BigInt(10_000_000), source: "https://platform.claude.com/docs/en/about-claude/pricing", asOf: "2026-11-11" },
};

/** A price older than this is stale and refused (PM ruling 12 Nov: 90 days). */
export const PRICE_MAX_AGE_DAYS = 90;

/** The most one request may reserve, in pence: mirrors the database bound (133:67, 134:119 `NOT BETWEEN 1 AND 1000`). */
export const MAX_REQUEST_PENCE_GBP = 1000;

/** Message framing (same as limits.ts) and role markers, on top of the bytes. */
const FRAMING_TOKENS = 200;
const DAY_MS = 86_400_000;
/** 10^6 (per million tokens) x 10^6 (micro-USD) x 10^6 (micro-GBP). */
const SCALE = BigInt(10) ** BigInt(18);

export type PriceRefusal = "unknown" | "provider_mismatch" | "bad_date" | "stale" | "not_yet_effective" | "bad_price";

const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : Number.NaN);

/** The usable price of one provider's model at `now`, or why there is none. Never another model's or provider's price. */
export function priceForGbp(provider: AiProviderId, model: string, now: Date, table: Readonly<Record<string, ModelPrice>> = MODEL_PRICES_GBP): { ok: true; price: ModelPrice } | { ok: false; reason: PriceRefusal } {
  const p = Object.hasOwn(table, model) ? table[model] : undefined;
  if (!p) return { ok: false, reason: "unknown" };
  if (p.provider !== provider) return { ok: false, reason: "provider_mismatch" };
  const t = now.getTime();
  const asOf = day(p.asOf);
  const from = p.effectiveFrom === undefined ? asOf : day(p.effectiveFrom);
  if (!Number.isFinite(t) || !Number.isFinite(asOf) || !Number.isFinite(from)) return { ok: false, reason: "bad_date" };
  if (t < from) return { ok: false, reason: "not_yet_effective" };
  if (t - asOf > PRICE_MAX_AGE_DAYS * DAY_MS) return { ok: false, reason: "stale" };
  for (const v of [p.inputMicroUsdPerMTok, p.outputMicroUsdPerMTok]) if (typeof v !== "bigint" || v <= BigInt(0)) return { ok: false, reason: "bad_price" };
  return { ok: true, price: p };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;

/** A whole, non-negative count, or a refusal (no float, NaN or negative reaches the money maths). */
function count(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${what}`);
  return BigInt(n);
}

/** pence = ceil((tokens x micro-USD per MTok x micro-GBP per USD x 100) / 10^18); input and output are summed before the one ceiling. */
function pence(inputTokens: bigint, outputTokens: bigint, price: ModelPrice, rate: UsdGbpRate): bigint {
  return ceilDiv((inputTokens * price.inputMicroUsdPerMTok + outputTokens * price.outputMicroUsdPerMTok) * rate.microGbpPerUsd * BigInt(100), SCALE);
}

/**
 * The reservation for one request, in pence (whole, at least 1). Throws (before anything is reserved or sent) when there is no usable
 * price or no usable USD to GBP rate (missing, stale, not yet in effect), or when the estimate is above MAX_REQUEST_PENCE_GBP.
 */
export function estimatePenceGbp(model: string, inputBytes: number, maxOutputTokens: number, provider: AiProviderId = "anthropic", now: Date = new Date(), rates: readonly UsdGbpRate[] = USD_GBP_RATES): number {
  const found = priceForGbp(provider, model, now);
  if (!found.ok) throw new Error(`No usable price for ${provider} model ${model} (${found.reason})`);
  const fx = rateFor(now, rates);
  if (!fx.ok) throw new Error(`No usable USD to GBP rate for ${provider} model ${model} (${fx.reason})`);
  const raw = pence(count(inputBytes, "input size") + BigInt(FRAMING_TOKENS), count(maxOutputTokens, "output cap"), found.price, fx.rate);
  const result = raw < BigInt(1) ? BigInt(1) : raw;
  if (result > BigInt(MAX_REQUEST_PENCE_GBP)) throw new Error(`Estimate for ${provider} model ${model} is above the ${MAX_REQUEST_PENCE_GBP}p request limit`);
  return Number(result);
}

/**
 * What a request actually cost from the provider's usage, in pence (rounded up). The database also caps it at the reservation. No
 * fallback to another model's price: a model with no price, or no usable rate, is charged MAX_REQUEST_PENCE_GBP (settle caps it at the
 * reservation, so it is charged in full). Staleness is not re-checked mid-request: estimatePenceGbp already refused before the call.
 */
export function actualPenceGbp(model: string, usage: { inputTokens: number; outputTokens: number }, provider: AiProviderId = "anthropic", now: Date = new Date(), rates: readonly UsdGbpRate[] = USD_GBP_RATES): number {
  const p = Object.hasOwn(MODEL_PRICES_GBP, model) ? MODEL_PRICES_GBP[model] : undefined;
  const fx = rateFor(now, rates);
  if (!p || p.provider !== provider || !fx.ok) return MAX_REQUEST_PENCE_GBP;
  const clamp = (n: number) => (Number.isSafeInteger(n) && n > 0 ? BigInt(n) : BigInt(0));
  const result = pence(clamp(usage.inputTokens), clamp(usage.outputTokens), p, fx.rate);
  return result > BigInt(MAX_REQUEST_PENCE_GBP) ? MAX_REQUEST_PENCE_GBP : Number(result);
}
