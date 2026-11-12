/**
 * Fixed limits for the AI admin helper: models, sizes, output caps and the price table the monthly cap is reserved from.
 *
 * COST. The cap (migration 101, pence) is reserved BEFORE each request from an upper bound: every byte of the system prompt, the
 * data and the answer's JSON schema (sent with the request, E9 Q4) counted as one input token (a token always covers at least one byte), plus framing, plus the full output cap (thinking included:
 * max_tokens bounds all output). The request is sent with that output cap, so the provider's own usage can never exceed the estimate,
 * and the database never settles above the reservation either.
 *
 * CURRENCY. Caps and accounting are integer GBP pence. A request's cost is the provider's USD list price (integer micro-USD per million
 * tokens, below) times the recorded USD to GBP rate (lib/ai-helper/fx.ts, at most 24 hours old), in BigInt arithmetic only, always rounded
 * UP, and never above MAX_REQUEST_PENCE. A missing, stale or unusable price or rate refuses the request before anything is reserved or
 * sent (fail closed). No floats touch money.
 */
import { type UsdGbpRate, USD_GBP_RATES, rateFor } from "@/lib/ai-helper/fx";
import type { AiProviderId } from "@/lib/ai-helper/provider";

export type AiHelperFeature = "roundup" | "rfq" | "assistant";

export const AI_HELPER_MODELS: Record<AiHelperFeature, string> = {
  // Reading an RFQ email into spec lines: the stronger model.
  rfq: "claude-opus-5-5",
  // Wording a short summary of facts the code already worked out.
  roundup: "claude-sonnet-5-5",
  // G3: answering one question about the company's own records, and drafting text (PLAN.md section 5: Sonnet for the assistant).
  assistant: "claude-sonnet-5-5",
};

export const AI_HELPER_EFFORT: Record<AiHelperFeature, "low" | "medium"> = { rfq: "medium", roundup: "low", assistant: "low" };

export const MAX_OUTPUT_TOKENS: Record<AiHelperFeature, number> = { rfq: 8000, roundup: 2000, assistant: 2000 };

/** The assistant (G3): the question's length (at most 3,000 bytes), the request body, and how many records one question may see. */
export const ASSISTANT_QUESTION_MAX_CHARS = 1000;
export const ASSISTANT_BODY_MAX_BYTES = 8 * 1024;
export const ASSISTANT_MAX_RECORDS = 50;

/** Pasted RFQ text: characters (and bytes, for multi-byte text) the route accepts. */
export const RFQ_MAX_CHARS = 20_000;
export const RFQ_MAX_BYTES = 40_000;
/** Request bodies: a little over the text limit for the JSON around it. */
export const RFQ_BODY_MAX_BYTES = 48 * 1024;
/** Lines a suggestion may hold; more are dropped and the person is told. */
export const RFQ_MAX_LINES = 20;
/** Past quote lines sent as examples (this company's own, read with the person's session). */
export const RFQ_PAST_LINES = 20;

/** One model request, end to end. The SDK makes ONE attempt (maxRetries 0, E9 Q4): one reservation never pays for two billed calls. */
export const AI_REQUEST_TIMEOUT_MS = 30_000;

/** The models per provider, for the wiring PR. Anthropic only until another provider's models are confirmed. */
export const AI_HELPER_MODELS_BY_PROVIDER: Partial<Record<AiProviderId, Record<AiHelperFeature, string>>> = { anthropic: AI_HELPER_MODELS };

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
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { provider: "anthropic", inputMicroUsdPerMTok: BigInt(4_000_000), outputMicroUsdPerMTok: BigInt(20_000_000), source: "https://platform.claude.com/docs/en/about-claude/pricing", asOf: "2026-11-11" },
  "claude-sonnet-5-5": { provider: "anthropic", inputMicroUsdPerMTok: BigInt(2_000_000), outputMicroUsdPerMTok: BigInt(10_000_000), source: "https://platform.claude.com/docs/en/about-claude/pricing", asOf: "2026-11-11" },
};

/** A price older than this is stale and refused (PM value; PROPOSED 180, to be confirmed). */
export const PRICE_MAX_AGE_DAYS = 180;

/** The most one request may reserve, in pence: mirrors the database bound (133:67, 134:119 `NOT BETWEEN 1 AND 1000`). */
export const MAX_REQUEST_PENCE = 1000;

/** Message framing and role markers, on top of the bytes. */
const FRAMING_TOKENS = 200;
const DAY_MS = 86_400_000;
/** 10^6 (per million tokens) x 10^6 (micro-USD) x 10^6 (micro-GBP). */
const SCALE = BigInt(10) ** BigInt(18);

export type PriceRefusal = "unknown" | "provider_mismatch" | "bad_date" | "stale" | "not_yet_effective" | "bad_price";

const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : Number.NaN);

/** The usable price of one provider's model at `now`, or why there is none. Never another model's or provider's price. */
export function priceFor(provider: AiProviderId, model: string, now: Date, table: Readonly<Record<string, ModelPrice>> = MODEL_PRICES): { ok: true; price: ModelPrice } | { ok: false; reason: PriceRefusal } {
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
 * price or no usable USD to GBP rate (missing, stale, not yet in effect), or when the estimate is above MAX_REQUEST_PENCE.
 */
export function estimatePence(model: string, inputBytes: number, maxOutputTokens: number, provider: AiProviderId = "anthropic", now: Date = new Date(), rates: readonly UsdGbpRate[] = USD_GBP_RATES): number {
  const found = priceFor(provider, model, now);
  if (!found.ok) throw new Error(`No usable price for ${provider} model ${model} (${found.reason})`);
  const fx = rateFor(now, rates);
  if (!fx.ok) throw new Error(`No usable USD to GBP rate for ${provider} model ${model} (${fx.reason})`);
  const raw = pence(count(inputBytes, "input size") + BigInt(FRAMING_TOKENS), count(maxOutputTokens, "output cap"), found.price, fx.rate);
  const result = raw < BigInt(1) ? BigInt(1) : raw;
  if (result > BigInt(MAX_REQUEST_PENCE)) throw new Error(`Estimate for ${provider} model ${model} is above the ${MAX_REQUEST_PENCE}p request limit`);
  return Number(result);
}

/**
 * What a request actually cost from the provider's usage, in pence (rounded up). The database also caps it at the reservation. No
 * fallback to another model's price: a model with no price, or no usable rate, is charged MAX_REQUEST_PENCE (settle caps it at the
 * reservation, so it is charged in full). Staleness is not re-checked mid-request: estimatePence already refused before the call.
 */
export function actualPence(model: string, usage: { inputTokens: number; outputTokens: number }, provider: AiProviderId = "anthropic", now: Date = new Date(), rates: readonly UsdGbpRate[] = USD_GBP_RATES): number {
  const p = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  const fx = rateFor(now, rates);
  if (!p || p.provider !== provider || !fx.ok) return MAX_REQUEST_PENCE;
  const clamp = (n: number) => (Number.isSafeInteger(n) && n > 0 ? BigInt(n) : BigInt(0));
  const result = pence(clamp(usage.inputTokens), clamp(usage.outputTokens), p, fx.rate);
  return result > BigInt(MAX_REQUEST_PENCE) ? MAX_REQUEST_PENCE : Number(result);
}
