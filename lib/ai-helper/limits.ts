/**
 * Fixed limits for the AI admin helper: models, sizes, output caps and the price table the monthly cap is reserved from.
 *
 * COST. The cap (migration 101, pence) is reserved BEFORE each request from an upper bound: every byte of the system prompt, the
 * data and the answer's JSON schema (sent with the request, E9 Q4) counted as one input token (a token always covers at least one byte), plus framing, plus the full output cap (thinking included:
 * max_tokens bounds all output). The request is sent with that output cap, so the provider's own usage can never exceed the estimate,
 * and the database never settles above the reservation either. Prices are the provider's list prices in US dollars per million tokens;
 * one US cent is counted as one penny, which over-counts while a pound is worth more than a dollar (the cap errs on the safe side).
 */
export type AiHelperFeature = "roundup" | "rfq";

export const AI_HELPER_MODELS: Record<AiHelperFeature, string> = {
  // Reading an RFQ email into spec lines: the stronger model.
  rfq: "claude-opus-5-5",
  // Wording a short summary of facts the code already worked out.
  roundup: "claude-sonnet-5-5",
};

export const AI_HELPER_EFFORT: Record<AiHelperFeature, "low" | "medium"> = { rfq: "medium", roundup: "low" };

export const MAX_OUTPUT_TOKENS: Record<AiHelperFeature, number> = { rfq: 8000, roundup: 2000 };

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

const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};
/** Message framing and role markers, on top of the bytes. */
const FRAMING_TOKENS = 200;

function price(model: string) {
  const p = PRICES_USD_PER_MTOK[model];
  if (!p) throw new Error(`No price for model ${model}`);
  return p;
}

/** The reservation for one request, in pence (whole, at least 1). */
export function estimatePence(model: string, inputBytes: number, maxOutputTokens: number): number {
  const p = price(model);
  const cents = ((inputBytes + FRAMING_TOKENS) * p.input + maxOutputTokens * p.output) / 1_000_000 * 100;
  return Math.max(1, Math.ceil(cents));
}

/** What a request actually cost from the provider's usage, in pence (rounded up). The database also caps it at the reservation. */
export function actualPence(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const p = PRICES_USD_PER_MTOK[model] ?? PRICES_USD_PER_MTOK["claude-opus-5-5"];
  const cents = (Math.max(0, usage.inputTokens) * p.input + Math.max(0, usage.outputTokens) * p.output) / 1_000_000 * 100;
  return Math.ceil(cents);
}
