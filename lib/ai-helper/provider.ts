/**
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

export class AiProviderError extends Error {
  constructor(readonly kind: AiFailure, readonly usage: AiUsage = { inputTokens: 0, outputTokens: 0 }, readonly detail?: "auth" | "rate") {
    super(`AI provider: ${kind}${detail ? ` (${detail})` : ""}`);
    this.name = "AiProviderError";
  }
}

export interface AiHelperProvider {
  readonly id: "anthropic" | "mock";
  complete(req: AiCompletionRequest): Promise<AiCompletion>;
}
