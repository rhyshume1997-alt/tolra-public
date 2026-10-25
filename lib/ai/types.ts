/**
 * Provider interface for a later model call (AGENTS-SPEC.md section 6). STUB ONLY: no provider is implemented, no SDK is installed,
 * no key is read. The pre-issue finance check is plain code today and calls no model.
 */
export type AiProviderId = "fake";

export interface AiProvider {
  readonly id: AiProviderId;
  complete(req: { system: string; data: string; schema: object; maxOutputTokens: number; timeoutMs: number }):
    Promise<{ json: unknown; usage: { inputTokens: number; outputTokens: number }; model: string }>;
}

/** The configured provider. Always null for now: every model-backed path stays off. */
export function aiProvider(): AiProvider | null {
  return null;
}
