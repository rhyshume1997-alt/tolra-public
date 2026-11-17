/**
 * BOUNDARY (Integrations module, AI-1). Inputs: none (types only). Outputs: the request, completion and error types, the fixed provider
 * id list and the AiHelperProvider interface every adapter implements. Must not change without review: the id list is fixed (no id
 * read from input, env or the database), AiProviderError's fields and their meaning (server.ts settles on them), and the contract below.
 *
 * The model behind the AI admin helper, behind one small interface (AGENTS-SPEC.md section 6). Two implementations: the Anthropic
 * one (lib/ai-helper/anthropic.ts, the official SDK, the company's own key) and a deterministic mock (lib/ai-helper/mock.ts) that every
 * test and CI run uses: no test ever calls the real API.
 *
 * The model is given NO tools. It gets a fixed system prompt, the data as one JSON document (the pasted text is a string value inside
 * it, never instructions), and a JSON schema its answer must follow. The caller then validates the answer itself.
 */
export type AiUsage = { inputTokens: number; outputTokens: number };

export type AiCompletionRequest = {
  model: string;
  system: string;
  data: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  effort: "low" | "medium";
  timeoutMs: number;
  /** The company's own key, decrypted on the server for this one request. Never logged, never returned. */
  apiKey: string;
};

export type AiCompletion = { json: unknown; usage: AiUsage; model: string };

/**
 * unavailable: the service did not answer (down, timeout, rate limit, network) or refused the key (detail "auth").
 * refused: the model declined (stop_reason "refusal").
 * invalid: an answer that is not the JSON asked for (cut short, unparseable).
 */
export type AiFailure = "unavailable" | "refused" | "invalid";

/**
 * rejectedBeforeWork: the provider CERTAINLY refused the request before doing any work (it answered 400, 401, 403, 404, 413 or 429), so
 * nothing was billed and the reservation may be given back (E9 Q4). Anything else that fails without usage (a timeout, a 5xx, a dropped
 * connection, an unknown error) may have been worked on and billed: it is settled at the full reservation.
 */
export class AiProviderError extends Error {
  constructor(readonly kind: AiFailure, readonly usage: AiUsage = { inputTokens: 0, outputTokens: 0 }, readonly detail?: "auth" | "rate", readonly rejectedBeforeWork = false) {
    super(`AI provider: ${kind}${detail ? ` (${detail})` : ""}`);
    this.name = "AiProviderError";
  }
}

/** The real providers an adapter may exist for (a fixed list). "mock" is the test provider only and has no price. */
export type AiProviderId = "anthropic" | "openai" | "xai";

/**
 * ADAPTER CONTRACT (every adapter; the shared test helper tests/support/ai-provider-contract.ts checks it):
 * 1. Exactly one request per complete() call: no retry loop, no SDK retries.
 * 2. Fixed endpoint only: the adapter's literal base URL plus a fixed path; nothing from input, env or the database reaches the URL;
 *    redirects are never followed (redirect: "error").
 * 3. The key is sent only as the credential (auth header / client key). Never in the URL, a log, an error message or a return value.
 * 4. Request: model = req.model, req.system as the system message, req.data as the single user message, NO tools or functions,
 *    the JSON schema as structured output where the model is confirmed to support it.
 * 5. Output bound: req.maxOutputTokens is sent with the provider parameter that bounds ALL billed output, reasoning included.
 * 6. Timeout = req.timeoutMs, covering the whole call including reading the body.
 * 7. Response: usage -> { inputTokens: all input incl. cached, outputTokens: all output incl. reasoning }. Only a normal finish is
 *    parsed. A refusal -> "refused" (with usage); cut short or any other finish -> "invalid" (with usage); answer text that is not
 *    JSON -> "invalid" (with usage). No usage reported, an unreadable body, or a body over 256 KB -> "unavailable", rejectedBeforeWork
 *    false: the caller then settles at the full reservation, never at 0.
 * 8. Status: 401/403 -> unavailable "auth" rejected; 429 -> unavailable "rate" rejected; 400/404/413 -> unavailable rejected;
 *    5xx, timeout, network, anything else -> unavailable, NOT rejected (it may have been billed).
 * 9. No pricing in adapters: prices live only in lib/ai-helper/limits.ts.
 */
export interface AiHelperProvider {
  readonly id: AiProviderId | "mock";
  complete(req: AiCompletionRequest): Promise<AiCompletion>;
}
