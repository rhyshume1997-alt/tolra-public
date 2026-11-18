/**
 * BOUNDARY (AI-3 wiring). Inputs: aiHelperProvider's env argument. Outputs: which provider id is chosen. Must not change: xAI is opt-in
 * (AI_HELPER_PROVIDER=xai only), the default stays Anthropic, and with the empty allow-list no model reaches the network.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { aiHelperProvider } from "@/lib/ai-helper/server";
import { AiProviderError } from "@/lib/ai-helper/provider";

describe("xAI wiring in server.ts", () => {
  it("is off by default and for any other value", () => {
    expect(aiHelperProvider({})?.id).toBe("anthropic");
    expect(aiHelperProvider({ AI_HELPER_PROVIDER: "XAI" })?.id).toBe("anthropic");
    expect(aiHelperProvider({ AI_HELPER_PROVIDER: "openai" })?.id).toBe("anthropic");
  });
  it("is chosen only by AI_HELPER_PROVIDER=xai, and mock still wins its own value", () => {
    expect(aiHelperProvider({ AI_HELPER_PROVIDER: "xai" })?.id).toBe("xai");
    expect(aiHelperProvider({ AI_HELPER_PROVIDER: "mock" })?.id).toBe("mock");
  });
  it("refuses every model before any fetch while the allow-list is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const p = aiHelperProvider({ AI_HELPER_PROVIDER: "xai" })!;
    const err = await p.complete({ model: "anything", system: "s", data: "d", schema: {}, maxOutputTokens: 10, effort: "low", timeoutMs: 1000, apiKey: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.kind).toBe("unavailable");
    expect(err.rejectedBeforeWork).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
