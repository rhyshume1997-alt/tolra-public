import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { anthropicProvider } from "@/lib/ai-helper/anthropic";
import { AI_HELPER_EFFORT, AI_HELPER_MODELS, AI_REQUEST_TIMEOUT_MS, type AiHelperFeature, MAX_OUTPUT_TOKENS, actualPence, estimatePence } from "@/lib/ai-helper/limits";
import { mockProvider } from "@/lib/ai-helper/mock";
import { type AiFailure, type AiHelperProvider, AiProviderError, type AiUsage } from "@/lib/ai-helper/provider";
import { decryptSecret } from "@/lib/integrations/crypto";

/**
 * The model provider this server uses: the company's own Anthropic account, or (AI_HELPER_PROVIDER=mock, tests and local runs only) the
 * deterministic mock. The mock is refused on any Vercel deployment (VERCEL_ENV set), so a stray setting can't fake answers in use.
 */
export function aiHelperProvider(env: Record<string, string | undefined> = process.env): AiHelperProvider | null {
  if (env.AI_HELPER_PROVIDER === "mock") return env.VERCEL_ENV ? null : mockProvider();
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

/**
 * One request, in the order the cap and the audit need: reserve (the database checks role, company, switch, key and cap, and writes
 * ai_helper_requested or ai_helper_refused) -> decrypt the company's key -> one model call -> validate -> settle (actual cost, the
 * validated suggestion, ai_helper_suggested; or the failure, ai_helper_failed). No reservation, no model call. A suggestion whose
 * settle (and so its audit row) fails is not shown. Every database call is the person's own session.
 */
export async function runAiHelper<T>(input: RunInput<T>): Promise<RunOutcome<T>> {
  const model = AI_HELPER_MODELS[input.feature];
  const maxOutputTokens = MAX_OUTPUT_TOKENS[input.feature];
  const estimate = estimatePence(model, Buffer.byteLength(input.system + input.data, "utf8"), maxOutputTokens);
  const { data: reserved, error } = await input.supabase.rpc("ai_helper_reserve", {
    p_feature: input.feature, p_estimate_pence: estimate, p_input_digest: digest(input.data), p_input_bytes: Buffer.byteLength(input.data, "utf8"),
  });
  if (error) {
    if (error.hint === "ai_helper_off") return { kind: "off" };
    console.error("[ai-helper] reserve refused", error.code ?? "error");
    return { kind: "unavailable" };
  }
  const answer = reserved as { ok?: boolean; reason?: string; request_id?: string; key_enc?: string } | null;
  if (!answer?.request_id) return { kind: "unavailable" };
  const requestId = answer.request_id;
  if (!answer.ok) return answer.reason === "cap" ? { kind: "cap", requestId } : { kind: "no_key", requestId };

  const settle = async (status: "suggested" | "failed", failure: AiFailure | null, usage: AiUsage, usedModel: string | null, output: Record<string, unknown> | null) => {
    const { error: settleError } = await input.supabase.rpc("ai_helper_settle", {
      p_request: requestId, p_status: status, p_failure: failure, p_cost_pence: actualPence(model, usage), p_model: usedModel, p_output: output,
    });
    if (settleError) console.error("[ai-helper] settle refused", settleError.code ?? "error");
    return !settleError;
  };
  const none = { inputTokens: 0, outputTokens: 0 };

  let apiKey: string;
  try {
    apiKey = decryptSecret(answer.key_enc ?? "", { organizationId: input.organizationId, provider: "anthropic", purpose: "api_key" });
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
  try {
    completion = await provider.complete({ model, system: input.system, data: input.data, schema: input.schema, maxOutputTokens, effort: AI_HELPER_EFFORT[input.feature], timeoutMs: AI_REQUEST_TIMEOUT_MS, apiKey });
  } catch (err) {
    const failure: AiFailure = err instanceof AiProviderError ? err.kind : "unavailable";
    const usage = err instanceof AiProviderError ? err.usage : none;
    console.error("[ai-helper] model call failed", failure, err instanceof AiProviderError ? err.detail ?? "" : "");
    await settle("failed", failure, usage, model, null);
    return { kind: "failed", failure, detail: err instanceof AiProviderError ? err.detail : undefined };
  }

  let checked;
  try {
    checked = await input.validate(completion.json);
  } catch {
    await settle("failed", "invalid", completion.usage, model, null);
    return { kind: "failed", failure: "invalid" };
  }
  if (!(await settle("suggested", null, completion.usage, model, checked.store))) return { kind: "unavailable" };
  return { kind: "ok", requestId, value: checked.value };
}
