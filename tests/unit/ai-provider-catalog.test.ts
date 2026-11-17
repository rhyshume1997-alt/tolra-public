/**
 * BOUNDARY (Integrations module, AI provider catalogue): tests for lib/ai-helper/provider-catalog.ts. Pure functions only, fake key samples
 * only (nothing resembling a real key), no network. Must not change without review: the cross-provider rejection cases stay.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AiProviderId } from "@/lib/ai-helper/provider";
import { AI_KEY_PROVIDERS, AI_PROVIDER_INFO, isAiProviderId, keyLooksRightFor } from "@/lib/ai-helper/provider-catalog";

const SAMPLE: Record<AiProviderId, string> = {
  anthropic: "sk-ant-" + "a".repeat(30),
  openai: "sk-" + "b".repeat(30),
  xai: "xai-" + "c".repeat(30),
};
const PREFIX: Record<AiProviderId, string> = { anthropic: "sk-ant-", openai: "sk-", xai: "xai-" };

describe("provider list", () => {
  it("is fixed and in order", () => {
    expect([...AI_KEY_PROVIDERS]).toEqual(["anthropic", "openai", "xai"]);
    expect(Object.keys(AI_PROVIDER_INFO)).toEqual(["anthropic", "openai", "xai"]);
  });
  it("has the agreed labels, placeholders and urls", () => {
    expect(AI_PROVIDER_INFO.anthropic.label).toBe("Anthropic");
    expect(AI_PROVIDER_INFO.openai.label).toBe("OpenAI");
    expect(AI_PROVIDER_INFO.xai.label).toBe("xAI (Grok)");
    expect(AI_KEY_PROVIDERS.map((id) => AI_PROVIDER_INFO[id].keyPlaceholder)).toEqual(["sk-ant-...", "sk-...", "xai-..."]);
    expect(AI_PROVIDER_INFO.anthropic.keysUrl).toBe("https://console.anthropic.com/settings/keys");
    expect(AI_PROVIDER_INFO.openai.keysUrl).toBe("https://platform.openai.com/api-keys");
    expect(AI_PROVIDER_INFO.xai.keysUrl).toBe("https://console.x.ai");
    for (const id of AI_KEY_PROVIDERS) {
      expect(AI_PROVIDER_INFO[id].id).toBe(id);
      expect(AI_PROVIDER_INFO[id].keyShapeMessage).toMatch(/^That doesn't look like an .* API key/);
    }
  });
});

describe("isAiProviderId", () => {
  it("accepts the three ids", () => {
    for (const id of AI_KEY_PROVIDERS) expect(isAiProviderId(id)).toBe(true);
  });
  it.each(["mock", "tolra", "Anthropic", "OPENAI", "__proto__", "constructor", "toString", "", " openai", 1, 0, null, undefined, {}, ["openai"]])(
    "rejects %j",
    (v) => expect(isAiProviderId(v)).toBe(false),
  );
});

describe("keyLooksRightFor", () => {
  for (const id of AI_KEY_PROVIDERS) {
    describe(id, () => {
      it("accepts a well-formed sample, trimmed", () => {
        expect(keyLooksRightFor(id, SAMPLE[id])).toBe(true);
        expect(keyLooksRightFor(id, `  ${SAMPLE[id]}\n`)).toBe(true);
      });
      it("rejects the other providers' samples", () => {
        for (const other of AI_KEY_PROVIDERS) if (other !== id) expect(keyLooksRightFor(id, SAMPLE[other])).toBe(false);
      });
      it("rejects too short, too long, inner whitespace and empty", () => {
        expect(keyLooksRightFor(id, PREFIX[id] + "a".repeat(19))).toBe(false);
        expect(keyLooksRightFor(id, PREFIX[id] + "a".repeat(20))).toBe(true);
        expect(keyLooksRightFor(id, PREFIX[id] + "a".repeat(200))).toBe(true);
        expect(keyLooksRightFor(id, PREFIX[id] + "a".repeat(201))).toBe(false);
        expect(keyLooksRightFor(id, PREFIX[id] + "a".repeat(15) + " " + "a".repeat(15))).toBe(false);
        expect(keyLooksRightFor(id, "")).toBe(false);
        expect(keyLooksRightFor(id, "   ")).toBe(false);
      });
    });
  }
  it("never accepts an sk-ant- key for openai", () => {
    expect(keyLooksRightFor("openai", "sk-ant-" + "a".repeat(30))).toBe(false);
    expect(keyLooksRightFor("openai", "sk-ant-" + "a".repeat(20))).toBe(false);
  });
  it("accepts newer openai style keys with dashes and underscores", () => {
    expect(keyLooksRightFor("openai", "sk-proj-" + "a_b-".repeat(10))).toBe(true);
  });
  it("each sample passes exactly one provider", () => {
    for (const id of AI_KEY_PROVIDERS) expect(AI_KEY_PROVIDERS.filter((p) => keyLooksRightFor(p, SAMPLE[id]))).toEqual([id]);
  });
});

describe("source", () => {
  const src = readFileSync(path.resolve(__dirname, "../../lib/ai-helper/provider-catalog.ts"), "utf8");
  it("has no process.env", () => expect(src).not.toContain("process.env"));
  it("has no import other than the provider type import", () => {
    const imports = src.split("\n").filter((l) => /^\s*(import|export\s.*\sfrom)\b/.test(l));
    expect(imports).toEqual(['import type { AiProviderId } from "@/lib/ai-helper/provider";']);
    expect(src).not.toMatch(/require\(|import\(/);
  });
});
