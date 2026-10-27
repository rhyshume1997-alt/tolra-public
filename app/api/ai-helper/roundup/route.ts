import { NextResponse } from "next/server";
import { z } from "zod";

import { AI_HELPER_ROLES } from "@/lib/ai-helper/flag";
import { ROUNDUP_OUTPUT_SCHEMA, ROUNDUP_SYSTEM_PROMPT, buildRoundupData, checkedSummary, roundupFacts, totalItems } from "@/lib/ai-helper/roundup";
import { outcomeMessage, runAiHelper } from "@/lib/ai-helper/server";
import { loadAttention } from "@/lib/attention-load";
import { toDateInput } from "@/lib/dates";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const roundupSchema = z.object({ period: z.enum(["daily", "weekly"]) }).strict();

/**
 * The round-up (READ ONLY). POST { period }: the facts are the dashboard's "Needs attention" rules, read as the caller (their session,
 * RLS and role: office never gets the money rules); the model only words a summary of them, and the wording is dropped if it holds a
 * number the facts don't. Nothing is written but the request's audit and cost rows. Nothing to report means no model call at all.
 * Off (404) unless AI_HELPER_ENABLED is exactly "true"; the company's round-up switch is checked by the database (ai_helper_reserve).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile([...AI_HELPER_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't use the AI helper.", 403);

  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = roundupSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);

  // Same switch check as the database's, first, so a company with the round-up off reads nothing.
  const { data: status, error: statusError } = await auth.supabase.rpc("ai_helper_status");
  if (statusError) return jsonError("The AI helper is not available right now.", 503);
  if ((status as { roundup_enabled?: boolean } | null)?.roundup_enabled !== true) return jsonError("The AI helper is off for this company.", 404);

  const role = [auth.profile.role, auth.profile.secondary_role].includes("admin") ? "admin" : "office";
  const sections = await loadAttention(auth.supabase, role);
  const facts = roundupFacts(sections, parsed.data.period, toDateInput(new Date()));
  if (totalItems(facts) === 0) return NextResponse.json({ facts, summary: null, notice: "Nothing needs attention right now." });

  const outcome = await runAiHelper({
    supabase: auth.supabase,
    organizationId: auth.profile.organization_id,
    feature: "roundup",
    system: ROUNDUP_SYSTEM_PROMPT,
    data: buildRoundupData(facts),
    schema: ROUNDUP_OUTPUT_SCHEMA,
    validate: (answer) => {
      const summary = checkedSummary(answer, facts);
      return { value: summary, store: { kind: "roundup", period: facts.period, summary, sections: facts.sections.map((s) => ({ title: s.title, count: s.count, failed: s.failed })) } };
    },
  });
  if (outcome.kind === "ok") {
    return NextResponse.json({ facts, summary: outcome.value, requestId: outcome.requestId,
      notice: outcome.value ? null : "The AI's wording didn't match the figures, so only the figures are shown." });
  }
  // The figures are plain code and always shown; only the wording is missing.
  const { error, code } = outcomeMessage(outcome);
  if (outcome.kind === "off") return jsonError(error, 404);
  return NextResponse.json({ facts, summary: null, notice: error, code });
}
