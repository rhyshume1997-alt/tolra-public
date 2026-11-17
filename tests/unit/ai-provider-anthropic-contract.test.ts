/**
 * BOUNDARY (Integrations module, AI-1): the shared adapter contract (tests/support/ai-provider-contract.ts) run against the UNCHANGED
 * Anthropic adapter, anthropicProvider(stand-in client). No network. Inputs: scenarios mapped onto the SDK's own message and error
 * types. Must not change without review: an exemption needs its reason, and is removed once lib/ai-helper/anthropic.ts meets the case.
 */
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import Anthropic from "@anthropic-ai/sdk";

import { anthropicProvider } from "@/lib/ai-helper/anthropic";
import { type ContractRecord, type ContractScenario, runAiProviderContract } from "@/tests/support/ai-provider-contract";

const MODEL = "claude-sonnet-5-5";

function message(scenario: Exclude<ContractScenario, { kind: "status" | "timeout" | "network" | "non_json_200" }>): Anthropic.Message {
  const text = scenario.kind === "ok" || scenario.kind === "missing_usage" ? JSON.stringify(scenario.json) : scenario.kind === "malformed" ? "not json {" : "";
  const stop = scenario.kind === "refusal" ? "refusal" : scenario.kind === "truncated" ? "max_tokens" : "end_turn";
  // Input split over fresh, cache-write and cache-read tokens: the adapter must count all three.
  const usage = scenario.kind === "missing_usage" ? undefined
    : { input_tokens: scenario.usage.inputTokens - 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: scenario.usage.outputTokens };
  return {
    id: "msg_contract", type: "message", role: "assistant", model: scenario.kind === "ok" || scenario.kind === "missing_usage" ? scenario.model : MODEL,
    stop_reason: stop, stop_sequence: null, content: [{ type: "text", text, citations: null }], usage,
  } as unknown as Anthropic.Message;
}

function failure(scenario: Extract<ContractScenario, { kind: "status" | "timeout" | "network" }>): unknown {
  if (scenario.kind === "timeout") return new Anthropic.APIConnectionTimeoutError();
  if (scenario.kind === "network") return new Anthropic.APIConnectionError({ message: "fetch failed" });
  return Anthropic.APIError.generate(scenario.status, { type: "error", error: { type: "x", message: scenario.body } }, scenario.body, new Headers());
}

runAiProviderContract({
  name: "anthropic (lib/ai-helper/anthropic.ts, stand-in SDK client)",
  id: "anthropic",
  model: MODEL,
  expectedUrl: null,
  build(scenario) {
    const rec: ContractRecord = { calls: 0, credential: null, sentOutsideAuth: "", request: null, url: null, timeoutMs: null };
    const provider = anthropicProvider((apiKey, timeoutMs) => {
      rec.credential = apiKey;
      rec.timeoutMs = timeoutMs;
      return {
        messages: {
          create: (async (body: Anthropic.MessageCreateParamsNonStreaming) => {
            rec.calls += 1;
            rec.sentOutsideAuth = JSON.stringify(body);
            const format = (body as { output_config?: { format?: { schema?: unknown } } }).output_config?.format;
            rec.request = {
              model: body.model, system: String(body.system), hasTools: "tools" in body || "tool_choice" in body, outputBound: body.max_tokens, schema: format?.schema,
              userMessages: body.messages.filter((m) => m.role === "user").map((m) => String(m.content)),
            };
            // A 200 whose body is not JSON reaches the SDK caller as a plain string, not a Message.
            if (scenario.kind === "non_json_200") return "<html>502 gateway page, not JSON</html>";
            if (scenario.kind === "status" || scenario.kind === "timeout" || scenario.kind === "network") throw failure(scenario);
            return message(scenario);
          }) as never,
        },
      };
    });
    return { provider, record: () => rec };
  },
  exemptions: {
    exact_url: "SDK transport: the base URL is the SDK's own (the SDK honours ANTHROPIC_BASE_URL); anthropic.ts is not changed in AI-1",
    non_json_200: "anthropic.ts treats a 200 body that is not a Message as invalid with usage 0, which the caller settles at 0 (anthropic.ts:51-53); not changed in AI-1 (Anthropic preserved); PM to rule",
    missing_usage: "anthropic.ts reads absent usage as 0 (anthropic.ts:44-47); not changed in AI-1 (Anthropic preserved); PM to rule",
  },
});
