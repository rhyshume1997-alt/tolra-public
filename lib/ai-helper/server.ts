import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { anthropicProvider } from "@/lib/ai-helper/anthropic";
import { AI_HELPER_EFFORT, AI_HELPER_MODELS, AI_REQUEST_TIMEOUT_MS, type AiHelperFeature, MAX_OUTPUT_TOKENS, actualPence, estimatePence } from "@/lib/ai-helper/limits";
import { mockProvider } from "@/lib/ai-helper/mock";
import { type AiFailure, type AiHelperProvider, AiProviderError, type AiUsage } from "@/lib/ai-helper/provider";
import { decryptSecret } from "@/lib/integrations/crypto";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * The model provider this server uses: the company's own Anthropic account, or (AI_HELPER_PROVIDER=mock, tests and local runs only) the
 * deterministic mock. The mock is refused on any Vercel deployment (VERCEL_ENV set), so a stray setting can't fake answers in use.
 */
export function aiHelperProvider(env: Record<string, string | undefined> = process.env): AiHelperProvider | null {
  if (env.AI_HELPER_PROVIDER === "mock") return env.VERCEL_ENV ? null : mockProvider();
  if (env.AI_HELPER_PROVIDER && env.AI_HELPER_PROVIDER !== "anthropic") return null;
  return anthropicProvider();
}

export type RunOutcome<T> =
  | { kind: "ok"; requestId: string; value: T }
  | { kind: "off" }
  | { kind: "cap"; requestId: string }
  | { kind: "no_key"; requestId: string }
  | { kind: "failed"; failure: AiFailure; detail?: "auth" | "rate" | "key" }
  | { kind: "unavailable" };

/** The person-facing line for every outcome but ok. Nothing was changed in any of them. */
export function outcomeMessage(outcome: Exclude<RunOutcome<unknown>, { kind: "ok" }>): { status: number; error: string; code: string } {
  switch (outcome.kind) {
    case "off": return { status: 404, error: "The AI helper is off for this company.", code: "off" };
    case "cap": return { status: 429, error: "This company's AI limit for the month has been reached, so nothing was sent to the AI. An admin can raise the limit in the AI section.", code: "cap" };
    case "no_key": return { status: 409, error: "No AI key is set for this company. An admin can add the company's own key in the AI section.", code: "no_key" };
    case "failed":
      if (outcome.detail === "auth") return { status: 503, error: "The AI service refused this company's key. An admin can check it in the AI section. Nothing was changed.", code: "key_refused" };
      if (outcome.detail === "key") return { status: 503, error: "The company's AI key can't be read on this server. An admin can enter it again in the AI section. Nothing was changed.", code: "key_unreadable" };
      if (outcome.failure === "refused") return { status: 422, error: "The AI declined to read this. Nothing was changed: fill the quote in by hand.", code: "refused" };
      if (outcome.failure === "invalid") return { status: 502, error: "The AI's answer could not be used. Nothing was changed: try again or fill the quote in by hand.", code: "invalid" };
      return { status: 503, error: "The AI service is not answering right now. Nothing was changed: try again later or carry on by hand.", code: "model_down" };
    case "unavailable": return { status: 503, error: "The AI helper is not available right now. Nothing was changed.", code: "unavailable" };
  }
}

type RunInput<T> = {
  supabase: SupabaseClient;
  organizationId: string;
  feature: AiHelperFeature;
  system: string;
  data: string;
  schema: Record<string, unknown>;
  /** Turns the model's JSON into the suggestion (throws when it can't); `store` is what the database keeps. */
  validate: (json: unknown) => { value: T; store: Record<string, unknown> } | Promise<{ value: T; store: Record<string, unknown> }>;
  provider?: AiHelperProvider | null;
};

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const validUsage = (usage: AiUsage | undefined): usage is AiUsage => Boolean(usage &&
  [usage.inputTokens, usage.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0));

/**
 * One request, in the order the cap and the audit need: reserve (the database checks role, company, switch, key and cap, and writes
 * ai_helper_requested or ai_helper_refused) -> read and decrypt the company's key -> one model call -> validate -> settle (actual cost,
 * the validated suggestion, ai_helper_suggested; or the failure, ai_helper_failed). No reservation, no model call. A suggestion whose
 * settle (and so its audit row) fails is not shown. The reservation is the person's own session (after the route's own sign-in and
 * role checks); only the key read and settle use the service role (migration 103: reserve no longer returns the key, and settle is
 * the service role's only), each for this company and this reservation alone.
 */
export async function runAiHelper<T>(input: RunInput<T>): Promise<RunOutcome<T>> {
  const model = AI_HELPER_MODELS[input.feature];
  const maxOutputTokens = MAX_OUTPUT_TOKENS[input.feature];
  // Every byte sent counts (E9 Q4): the system prompt, the data and the JSON schema the answer must follow.
  const estimate = estimatePence(model, Buffer.byteLength(input.system + input.data + JSON.stringify(input.schema), "utf8"), maxOutputTokens);
  // Without the service role nothing could be settled: refuse before anything is reserved.
  let service: SupabaseClient | null;
  try { service = createSupabaseAdminClient(); } catch {
    console.error("[ai-helper] server configuration unavailable");
    return { kind: "unavailable" };
  }
  if (!service) {
    console.error("[ai-helper] service role not configured");
    return { kind: "unavailable" };
  }
  const reserveArgs = { p_estimate_pence: estimate, p_input_digest: digest(input.data), p_input_bytes: Buffer.byteLength(input.data, "utf8") };
  // The assistant (G3) reserves through its own function (migration 134: 133's reserve rules for the one feature), so 133's
  // ai_helper_reserve stays exactly as it is.
  let reservation;
  try {
    reservation = input.feature === "assistant"
      ? await input.supabase.rpc("ai_helper_reserve_assistant", reserveArgs)
      : await input.supabase.rpc("ai_helper_reserve", { p_feature: input.feature, ...reserveArgs });
  } catch {
    console.error("[ai-helper] reserve unavailable");
    return { kind: "unavailable" };
  }
  const { data: reserved, error } = reservation;
  if (error) {
    if (error.hint === "ai_helper_off") return { kind: "off" };
    console.error("[ai-helper] reserve refused", error.code ?? "error");
    return { kind: "unavailable" };
  }
  const answer = reserved as { ok?: boolean; reason?: string; request_id?: string } | null;
  if (!answer?.request_id) return { kind: "unavailable" };
  const requestId = answer.request_id;
  if (!answer.ok) return answer.reason === "cap" ? { kind: "cap", requestId } : { kind: "no_key", requestId };

  // costPence: the actual cost from the provider's usage, unless given (the full reservation for an attempt that may have been billed).
  const settle = async (status: "suggested" | "failed", failure: AiFailure | null, usage: AiUsage, usedModel: string | null, output: Record<string, unknown> | null, costPence?: number) => {
    try {
      const { error: settleError } = await service.rpc("ai_helper_settle", {
        p_request: requestId, p_status: status, p_failure: failure, p_cost_pence: costPence ?? actualPence(model, usage), p_model: usedModel, p_output: output,
      });
      if (settleError) console.error("[ai-helper] settle refused", settleError.code ?? "error");
      return !settleError;
    } catch {
      // Keep the reservation (133's stale sweep charges it); never show an unaudited suggestion.
      console.error("[ai-helper] settle unavailable");
      return false;
    }
  };
  const none = { inputTokens: 0, outputTokens: 0 };

  let apiKey: string;
  try {
    // The reservation passed, so this company has a key: read it for this company only.
    const { data: secret, error: secretError } = await service.from("ai_helper_secrets").select("api_key_enc").eq("organization_id", input.organizationId).maybeSingle();
    if (secretError) throw secretError;
    apiKey = decryptSecret(String((secret as { api_key_enc?: unknown } | null)?.api_key_enc ?? ""), { organizationId: input.organizationId, provider: "anthropic", purpose: "api_key" });
  } catch {
    await settle("failed", "unavailable", none, null, null);
    return { kind: "failed", failure: "unavailable", detail: "key" };
  }
  const provider = input.provider === undefined ? aiHelperProvider() : input.provider;
  if (!provider) {
    await settle("failed", "unavailable", none, null, null);
    return { kind: "failed", failure: "unavailable" };
  }

  let completion;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // The SDK also aborts its request at this deadline; the helper bounds any adapter that fails to return.
    completion = await Promise.race([
      provider.complete({ model, system: input.system, data: input.data, schema: input.schema, maxOutputTokens, effort: AI_HELPER_EFFORT[input.feature], timeoutMs: AI_REQUEST_TIMEOUT_MS, apiKey }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new AiProviderError("unavailable")), AI_REQUEST_TIMEOUT_MS); }),
    ]);
  } catch (err) {
    const failure: AiFailure = err instanceof AiProviderError ? err.kind : "unavailable";
    const usage = err instanceof AiProviderError ? err.usage : none;
    console.error("[ai-helper] model call failed", failure, err instanceof AiProviderError ? err.detail ?? "" : "");
    // E9 Q4: given back only when the provider certainly did no work (it rejected the request, or answered and told us its usage:
    // refused / invalid). Anything else (timeout, 5xx, connection, unknown) may have been billed: settled at the full reservation.
    const certain = err instanceof AiProviderError && (err.rejectedBeforeWork || (err.kind !== "unavailable" && validUsage(usage)
      && usage.outputTokens <= maxOutputTokens && actualPence(model, usage) <= estimate));
    await settle("failed", failure, validUsage(usage) ? usage : none, model, null, err instanceof AiProviderError && err.rejectedBeforeWork ? 0 : certain ? undefined : estimate);
    return { kind: "failed", failure, detail: err instanceof AiProviderError ? err.detail : undefined };
  } finally {
    clearTimeout(timeout);
  }

  let checked;
  try {
    // A broken adapter must not turn invalid usage into a refund or undercharge.
    if (!validUsage(completion?.usage) || typeof completion.model !== "string" || !(completion.model === model || completion.model.startsWith(`${model}-`))
        || completion.usage.outputTokens > maxOutputTokens || actualPence(model, completion.usage) > estimate) {
      await settle("failed", "invalid", none, model, null, estimate);
      return { kind: "failed", failure: "invalid" };
    }
    checked = await input.validate(completion.json);
  } catch {
    await settle("failed", "invalid", completion.usage, model, null);
    return { kind: "failed", failure: "invalid" };
  }
  // Token counts accompany the existing request output; no duplicate ledger.
  if (!(await settle("suggested", null, completion.usage, model, { ...checked.store, usage: completion.usage }))) return { kind: "unavailable" };
  return { kind: "ok", requestId, value: checked.value };
}
