import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { type AiCompletion, type AiCompletionRequest, type AiHelperProvider, AiProviderError, type AiUsage } from "@/lib/ai-helper/provider";

/** What this file needs from the SDK client (the tests pass a stand-in; nothing here ever runs in a test against the real API). */
export type MessagesClient = { messages: Pick<Anthropic["messages"], "create"> };
export type MakeClient = (apiKey: string, timeoutMs: number) => MessagesClient;

// No SDK retries (E9 Q4): one reservation pays for one attempt. A retry after a timeout or a 5xx could be a second billed request.
const makeClient: MakeClient = (apiKey, timeoutMs) => new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });

/** Statuses that mean the provider refused the request before any work (nothing billed): bad request, key, permission, not found, too large, rate. */
const REJECTED_BEFORE_WORK = new Set([400, 401, 403, 404, 413, 429]);

/**
 * The company's own Anthropic account, through the official SDK. One Messages request: no tools, a fixed system prompt, the data as the
 * only user message, and structured output (output_config.format, a JSON schema). Every failure becomes an AiProviderError whose text
 * never carries the key, the prompt or the provider's own message.
 */
export function anthropicProvider(make: MakeClient = makeClient): AiHelperProvider {
  return {
    id: "anthropic",
    async complete(req: AiCompletionRequest): Promise<AiCompletion> {
      let response: Anthropic.Message;
      try {
        response = await make(req.apiKey, req.timeoutMs).messages.create({
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: [{ role: "user", content: req.data }],
          output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
        });
      } catch (error) {
        // A connection error or timeout has no status: never a certain rejection.
        const status = error instanceof Anthropic.APIError && !(error instanceof Anthropic.APIConnectionError) ? error.status : undefined;
        const rejected = typeof status === "number" && REJECTED_BEFORE_WORK.has(status);
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new AiProviderError("unavailable", undefined, "auth", rejected);
        if (error instanceof Anthropic.RateLimitError) throw new AiProviderError("unavailable", undefined, "rate", rejected);
        // Server errors, timeouts, connection failures and anything else: the model is not available right now.
        throw new AiProviderError("unavailable", undefined, undefined, rejected);
      }
      const usage: AiUsage = {
        inputTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0),
        outputTokens: response.usage?.output_tokens ?? 0,
      };
      // The model declined: its content may not match the schema, so none of it is read.
      if (response.stop_reason === "refusal") throw new AiProviderError("refused", usage);
      // Cut short (max_tokens) or anything but a finished answer: not trusted.
      if (response.stop_reason !== "end_turn") throw new AiProviderError("invalid", usage);
      const text = response.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("");
      try {
        return { json: JSON.parse(text), usage, model: response.model };
      } catch {
        throw new AiProviderError("invalid", usage);
      }
    },
  };
}
