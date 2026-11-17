import type { AiProviderId } from "@/lib/ai-helper/provider";

/**
 * BOUNDARY (Integrations module, AI provider catalogue). Inputs: a provider id or a typed key string. Outputs: the fixed provider list,
 * per-provider display info and a form-only key shape check. Client-safe: pure data and pure functions, no server-only imports, no
 * environment access, no secrets, no network. The only import is a type. Must not change without review: the list and its order are fixed
 * (no id read from input, env or the database) and the key shapes (a key of one provider must never pass another provider's check).
 * Nothing imports this file yet. No pricing, no model names, no adapters, no env flag here.
 */


/** The providers a company can bring its own key for, in a fixed order. */
export const AI_KEY_PROVIDERS: readonly AiProviderId[] = ["anthropic", "openai", "xai"] as const;

export type AiProviderInfo = { id: AiProviderId; label: string; keyPlaceholder: string; keyShapeMessage: string; keysUrl: string };

/**
 * Where a key is made, shown as link text only. The Anthropic URL is the one already in lib/integrations/ai-setup.ts (ANTHROPIC_KEYS_URL).
 * The OpenAI and xAI URLs are to be confirmed by the reviewer: they could not be verified when this was written.
 */
export const AI_PROVIDER_INFO: Readonly<Record<AiProviderId, AiProviderInfo>> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyPlaceholder: "sk-ant-...",
    keyShapeMessage: "That doesn't look like an Anthropic API key (it starts with sk-ant-).",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyPlaceholder: "sk-...",
    keyShapeMessage: "That doesn't look like an OpenAI API key (it starts with sk-).",
    keysUrl: "https://platform.openai.com/api-keys", // to be confirmed by the reviewer
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    keyPlaceholder: "xai-...",
    keyShapeMessage: "That doesn't look like an xAI API key (it starts with xai-).",
    keysUrl: "https://console.x.ai", // to be confirmed by the reviewer
  },
};

/** True only for an exact id from the fixed list (no case folding, no prototype keys). */
export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && (AI_KEY_PROVIDERS as readonly string[]).includes(value);
}

/** Form only (the first request tells whether the provider accepts the key). The OpenAI shape refuses Anthropic keys. */
const KEY_SHAPES: Readonly<Record<AiProviderId, RegExp>> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,200}$/,
  openai: /^sk-(?!ant-)[A-Za-z0-9_-]{20,200}$/,
  xai: /^xai-[A-Za-z0-9_-]{20,200}$/,
};

export function keyLooksRightFor(provider: AiProviderId, value: string): boolean {
  return isAiProviderId(provider) && KEY_SHAPES[provider].test(value.trim());
}
