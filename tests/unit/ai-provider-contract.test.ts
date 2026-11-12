/**
 * BOUNDARY (Integrations module, AI-1): self-test of the shared adapter contract helper (tests/support/ai-provider-contract.ts). No
 * real adapter uses fetch yet, so a minimal REFERENCE fetch adapter (test-only, a fake host, never shipped) proves the fetch cases
 * pass for a correct adapter, and that broken adapters (follows redirects, unbounded body, no timeout on the body, usage read as 0,
 * a retry) are caught. Must not change without review: the broken-adapter proofs stay.
 */
import { describe, expect, it } from "vitest";

import { type AiCompletion, type AiCompletionRequest, type AiHelperProvider, AiProviderError } from "@/lib/ai-helper/provider";
import { type AnswerScenario, BODY_CAP_BYTES, type ContractCase, aiProviderContractChecks, fetchHarness, runAiProviderContract } from "@/tests/support/ai-provider-contract";

const URL_ = "https://reference-provider.invalid/v1/chat";
type Flaws = { followRedirects?: boolean; noBodyCap?: boolean; noSignal?: boolean; zeroUsage?: boolean; retry?: boolean };

/** A correct fetch adapter, by the contract; `flaws` switch one property off at a time. */
function referenceProvider(fetchFn: typeof fetch, flaws: Flaws = {}): AiHelperProvider {
  return {
    id: "openai",
    async complete(req: AiCompletionRequest): Promise<AiCompletion> {
      const signal = flaws.noSignal ? undefined : AbortSignal.timeout(req.timeoutMs);
      const init: RequestInit = {
        method: "POST", redirect: flaws.followRedirects ? "follow" : "error", signal,
        headers: { authorization: `Bearer ${req.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: req.model, max_completion_tokens: req.maxOutputTokens, messages: [{ role: "system", content: req.system }, { role: "user", content: req.data }], response_format: { type: "json_schema", json_schema: { schema: req.schema } } }),
      };
      let text: string;
      try {
        let res = await fetchFn(URL_, init);
        if (flaws.retry && res.status >= 500) res = await fetchFn(URL_, init);
        if (!res.ok) {
          const s = res.status;
          throw new AiProviderError("unavailable", undefined, s === 401 || s === 403 ? "auth" : s === 429 ? "rate" : undefined, [400, 401, 403, 404, 413, 429].includes(s));
        }
        const reader = res.body!.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (!flaws.noBodyCap && size > BODY_CAP_BYTES) { await reader.cancel(); throw new AiProviderError("unavailable"); }
          chunks.push(value);
        }
        text = Buffer.concat(chunks).toString("utf8");
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        throw new AiProviderError("unavailable");
      }
      let body: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { finish_reason?: string; message?: { content?: string; refusal?: string | null } }[] };
      try { body = JSON.parse(text); } catch { throw new AiProviderError("unavailable"); }
      if (!body.usage && !flaws.zeroUsage) throw new AiProviderError("unavailable");
      const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
      const choice = body.choices?.[0];
      if (choice?.message?.refusal) throw new AiProviderError("refused", usage);
      if (choice?.finish_reason !== "stop") throw new AiProviderError("invalid", usage);
      try { return { json: JSON.parse(choice.message?.content ?? ""), usage, model: String(body.model) }; } catch { throw new AiProviderError("invalid", usage); }
    },
  };
}

const encode = (s: AnswerScenario) => {
  const usage = "usage" in s ? { prompt_tokens: s.usage.inputTokens, completion_tokens: s.usage.outputTokens } : undefined;
  const content = s.kind === "ok" || s.kind === "missing_usage" ? JSON.stringify(s.json) : s.kind === "malformed" ? "not json {" : "";
  return { model: "model" in s ? s.model : "ref-model", usage, choices: [{ finish_reason: s.kind === "truncated" ? "length" : "stop", message: { content, refusal: s.kind === "refusal" ? "no" : null } }] };
};

const spec = (flaws: Flaws = {}) => fetchHarness({
  name: "reference fetch adapter (test-only)", id: "openai", model: "ref-model", url: URL_, authHeader: "authorization",
  credentialFromHeader: (v) => v.replace(/^Bearer /, ""), make: (f) => referenceProvider(f, flaws), encode,
  readRequest: (raw) => {
    const b = raw as { model: string; max_completion_tokens: number; messages: { role: string; content: string }[]; response_format: { json_schema: { schema: unknown } }; tools?: unknown };
    return { model: b.model, system: b.messages.find((m) => m.role === "system")?.content ?? "", userMessages: b.messages.filter((m) => m.role === "user").map((m) => m.content), hasTools: "tools" in b, outputBound: b.max_completion_tokens, schema: b.response_format.json_schema.schema };
  },
});

runAiProviderContract(spec());

describe("the contract catches a broken adapter", () => {
  const check = (flaws: Flaws, name: ContractCase) => aiProviderContractChecks(spec(flaws)).find((c) => c.name === name)!.run();
  it("follows redirects -> redirect_not_followed fails", async () => { await expect(check({ followRedirects: true }, "redirect_not_followed")).rejects.toThrow(); });
  it("reads an unbounded body -> body_over_cap fails", async () => { await expect(check({ noBodyCap: true }, "body_over_cap")).rejects.toThrow(); });
  it("no timeout on the body read -> timeout_covers_body_read fails", async () => { await expect(check({ noSignal: true }, "timeout_covers_body_read")).rejects.toThrow(); });
  it("reads missing usage as 0 -> missing_usage fails", async () => { await expect(check({ zeroUsage: true }, "missing_usage")).rejects.toThrow(); });
  it("retries a 5xx -> one-request check fails", async () => { await expect(check({ retry: true }, "status_500")).rejects.toThrow(); });
});
