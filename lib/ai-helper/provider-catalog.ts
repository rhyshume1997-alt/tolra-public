import type { AiProviderId } from "@/lib/ai-helper/provider";

/**
 * BOUNDARY (Integrations module, AI provider catalogue). Inputs: a provider id, a typed key string, or an env-like object passed in by the
 * caller. Outputs: the fixed provider list, per-provider display info, a form-only key shape check and the list of providers offered.
 * Client-safe: pure data and pure functions, no server-only imports, no environment access, no secrets, no network. The only import is a
 * type. Must not change without review: the list and its order are fixed (no id read from input, env or the database), the key shapes
 * (a key of one provider must never pass another provider's check) and the off-by-default rule for OpenAI and xAI. Nothing imports this
 * file yet. No pricing, no model names, no adapters here.
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

/**
 * Providers offered to a company. Anthropic is always offered; OpenAI and xAI only when env.AI_HELPER_PROVIDERS lists them (comma
 * separated, trimmed, lowercase exact match). Unknown entries are ignored. The caller passes env in; this never reads the process environment.
 */
export function aiProvidersOffered(env: Readonly<Record<string, string | undefined>>): readonly AiProviderId[] {
  const listed = new Set((env.AI_HELPER_PROVIDERS ?? "").split(",").map((s) => s.trim()));
  return AI_KEY_PROVIDERS.filter((id) => id === "anthropic" || listed.has(id));
}
