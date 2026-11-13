/**
 * OpenAI adapter (AI-2), DORMANT: nothing imports it yet (no route, no server.ts). One Chat Completions request through an injectable
 * fetch (the tests pass a stand-in; no test ever calls the real API).
 *
 * Inputs: an AiCompletionRequest. Output: an AiCompletion, or an AiProviderError (the key, prompt and provider body are never in it).
 * Must not be changed: the fixed URL (literal, no parameter, nothing from input/env/DB), one request per call (no retries), no tools,
 * no prices (those live only in limits.ts), no streaming, no logging of requests, responses or headers.
 *
 * Models: an explicit ALLOW-LIST (OPENAI_MODEL_ALLOWLIST), EMPTY by default. A model not on it throws before any fetch (kind "unavailable",
 * rejectedBeforeWork true, no network call). Each entry records the output-limit parameter and structured-output mode that model takes.
 * Rhys/PM MUST confirm each model, its parameter and its structured mode from OpenAI's official docs before adding an entry. No model
 * names or prices are invented here (prices live only in limits.ts).
 *
 * Settlement contract (see server.ts): any failure where the provider may have worked but we have no trustworthy usage (no body, oversize
 * body, unparseable envelope, missing/partial usage, network/abort after send) is "unavailable" with rejectedBeforeWork false (settled at the
 * full reservation). "invalid"/"refused" are thrown ONLY with real usage attached. 400/401/403/404/413/429 are rejectedBeforeWork true.
 * Implements the AI-1 adapter contract (lib/ai-helper/provider.ts, ADAPTER CONTRACT; checked by tests/support/ai-provider-contract.ts).
 * No cost is computed here: cost comes only from the AI-1 fail-closed GBP pricing path, never from this file.
 * Usage: outputTokens = completion_tokens (OpenAI's figure already includes reasoning tokens).
 */
import "server-only";

import { type AiCompletion, type AiCompletionRequest, AiProviderError, type AiUsage } from "@/lib/ai-helper/provider";

const URL_CHAT = "https://api.openai.com/v1/chat/completions";
/** Response body byte cap, enforced while reading (before JSON.parse). Over it: "unavailable", not rejected (possibly billed, usage unknown: settled in full). */
const MAX_BODY_BYTES = 256 * 1024;
/** The provider certainly refused before any work (nothing billed): bad request, key, permission, not found, too large, rate. */
const REJECTED_BEFORE_WORK = new Set([400, 401, 403, 404, 413, 429]);

export type OpenAiModelSpec = { outputLimitParam: "max_completion_tokens" | "max_tokens"; structured: "json_schema" | "json_object" };
/** Allow-list of models. EMPTY until Rhys/PM confirm entries from OpenAI's official docs. */
export const OPENAI_MODEL_ALLOWLIST: Readonly<Record<string, OpenAiModelSpec>> = Object.freeze({});

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

type ChatResponse = {
  model?: unknown;
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Reads at most MAX_BODY_BYTES; null when over. The fetch signal (timeoutMs) covers this read too. Bodies are never logged. */
async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function openaiProvider(fetchImpl: FetchFn = fetch, allowlist: Readonly<Record<string, OpenAiModelSpec>> = OPENAI_MODEL_ALLOWLIST): { readonly id: "openai"; complete(req: AiCompletionRequest): Promise<AiCompletion> } {
  return {
    id: "openai",
    async complete(req: AiCompletionRequest): Promise<AiCompletion> {
      // Refused here, before any request: nothing is sent, so nothing is billed.
      const spec = Object.hasOwn(allowlist, req.model) ? allowlist[req.model] : undefined;
      if (!spec) throw new AiProviderError("unavailable", undefined, undefined, true);
      let response: Response;
      let text: string | null;
      try {
        response = await fetchImpl(URL_CHAT, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` },
          body: JSON.stringify({
            model: req.model,
            stream: false,
            [spec.outputLimitParam]: req.maxOutputTokens,
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.data },
            ],
            response_format: spec.structured === "json_schema" ? { type: "json_schema", json_schema: { name: "answer", schema: req.schema } } : { type: "json_object" },
          }),
          signal: AbortSignal.timeout(req.timeoutMs),
        });
        if (response.ok) text = await readCapped(response);
        else {
          void response.body?.cancel().catch(() => {});
          text = "";
        }
      } catch {
        // Timeout, dropped connection, redirect: no status, so never a certain rejection.
        throw new AiProviderError("unavailable");
      }
      if (!response.ok) {
        const rejected = REJECTED_BEFORE_WORK.has(response.status);
        const detail = response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "rate" : undefined;
        throw new AiProviderError("unavailable", undefined, detail, rejected);
      }
      // No body, oversize body or unparseable envelope: the provider may have billed, usage unknown -> full reservation.
      if (text === null || text === "") throw new AiProviderError("unavailable");
      let body: ChatResponse;
      try {
        body = JSON.parse(text) as ChatResponse;
      } catch {
        throw new AiProviderError("unavailable");
      }
      // Missing or partial usage is never read as 0: "unavailable" (not rejected) so the caller settles at the full reservation.
      const u = body?.usage;
      if (!isCount(u?.prompt_tokens) || !isCount(u?.completion_tokens)) throw new AiProviderError("unavailable");
      const usage: AiUsage = { inputTokens: Math.floor(u.prompt_tokens), outputTokens: Math.floor(u.completion_tokens) };
      const choice = body?.choices?.[0];
      // A refusal is the model declining: the content filter, or a non-empty message.refusal on a normal stop.
      if (choice?.finish_reason === "content_filter" || (typeof choice?.message?.refusal === "string" && choice.message.refusal !== "")) throw new AiProviderError("refused", usage);
      if (choice?.finish_reason !== "stop") throw new AiProviderError("invalid", usage);
      const content = choice.message?.content;
      if (typeof content !== "string") throw new AiProviderError("invalid", usage);
      try {
        return { json: JSON.parse(content), usage, model: typeof body.model === "string" ? body.model : req.model };
      } catch {
        throw new AiProviderError("invalid", usage);
      }
    },
  };
}
