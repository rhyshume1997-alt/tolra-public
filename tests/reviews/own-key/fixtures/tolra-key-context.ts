/** A separate encryption slot: a company key cannot be substituted for Tolra's key. */
export const TOLRA_AI_KEY_CONTEXT = { organizationId: "tolra-provided-ai", provider: "anthropic", purpose: "api_key" as const };
