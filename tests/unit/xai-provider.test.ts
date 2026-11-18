/**
 * BOUNDARY (Integrations module, AI-3): the shared adapter contract (tests/support/ai-provider-contract.ts) run against the dormant
 * xAI adapter, xaiProvider(fake fetch, test-only allow-list). No network, dummy key only. Inputs: scenarios encoded as xAI Chat
 * Completions bodies. Must not change without review: one exemption (status_429, reason given in the harness: not confirmed unbilled); the shipped allow-list stays empty (that is not touched here).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AiProviderError } from "@/lib/ai-helper/provider";
import { XAI_MODEL_ALLOWLIST, xaiProvider } from "@/lib/ai-helper/providers/xai";
import { type AnswerScenario, contractRequest, fetchHarness, runAiProviderContract } from "@/tests/support/ai-provider-contract";

const MODEL = "grok-contract-test";
const ALLOW = { [MODEL]: { outputLimitParam: "max_completion_tokens", structured: "json_schema" } } as const;

const encode = (s: AnswerScenario) => {
  const usage = "usage" in s ? { prompt_tokens: s.usage.inputTokens, completion_tokens: s.usage.outputTokens } : undefined;
  const content = s.kind === "ok" || s.kind === "missing_usage" ? JSON.stringify(s.json) : s.kind === "malformed" ? "not json {" : "";
  return {
    model: "model" in s ? s.model : MODEL,
    usage,
    choices: [{ finish_reason: s.kind === "truncated" ? "length" : "stop", message: { content, refusal: s.kind === "refusal" ? "no" : null } }],
  };
};

runAiProviderContract(fetchHarness({
  name: "xai (lib/ai-helper/providers/xai.ts, fake fetch)",
  id: "xai",
  model: MODEL,
  url: "https://api.x.ai/v1/chat/completions",
  authHeader: "authorization",
  credentialFromHeader: (v) => v.replace(/^Bearer /, ""),
  make: (f) => xaiProvider(f, ALLOW),
  encode,
  exemptions: { status_429: "xAI's docs do not say a 429 request is never billed, so it is not classed rejectedBeforeWork; asserted by the explicit 429 test below" },
  readRequest: (raw) => {
    const b = raw as { model: string; max_completion_tokens: number; messages: { role: string; content: string }[]; response_format: { json_schema: { schema: unknown } }; tools?: unknown };
    return {
      model: b.model,
      system: b.messages.find((m) => m.role === "system")?.content ?? "",
      userMessages: b.messages.filter((m) => m.role === "user").map((m) => m.content),
      hasTools: "tools" in b,
      outputBound: b.max_completion_tokens,
      schema: b.response_format.json_schema.schema,
    };
  },
}));

describe("xai adapter shipped defaults", () => {
  it("the shipped allow-list is empty (no model confirmed yet)", () => expect(Object.keys(XAI_MODEL_ALLOWLIST)).toEqual([]));

  it("an unlisted model is refused before any fetch", async () => {
    const f = vi.fn();
    const e = await xaiProvider(f as never).complete(contractRequest(MODEL)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e).toMatchObject({ kind: "unavailable", rejectedBeforeWork: true });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("xai 429", () => {
  it("is unavailable with detail rate and NOT rejectedBeforeWork (not confirmed unbilled; settles at the full reservation)", async () => {
    const f = vi.fn(async () => new Response("slow down", { status: 429 }));
    const e = await xaiProvider(f as never, { [MODEL]: { outputLimitParam: "max_completion_tokens", structured: "json_schema" } }).complete(contractRequest(MODEL)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e).toMatchObject({ kind: "unavailable", detail: "rate", rejectedBeforeWork: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
