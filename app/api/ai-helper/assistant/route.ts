import { NextResponse } from "next/server";
import { z } from "zod";

import { ASSISTANT_OUTPUT_SCHEMA, ASSISTANT_SYSTEM_PROMPT, ASSISTANT_TOPICS, assistantContext, buildAssistantData, checkedAnswer, readCompanyAssistant } from "@/lib/ai-helper/assistant";
import { loadAssistantRows } from "@/lib/ai-helper/assistant-load";
import { AI_HELPER_ROLES } from "@/lib/ai-helper/flag";
import { ASSISTANT_BODY_MAX_BYTES, ASSISTANT_QUESTION_MAX_CHARS } from "@/lib/ai-helper/limits";
import { outcomeMessage, runAiHelper } from "@/lib/ai-helper/server";
import { toDateInput } from "@/lib/dates";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const askSchema = z.object({
  topic: z.enum(ASSISTANT_TOPICS),
  question: z.string().trim().min(1).max(ASSISTANT_QUESTION_MAX_CHARS),
}).strict();

const OFF = "The AI assistant is off for this company.";

/**
 * G3, the in-app assistant (SUGGEST ONLY, built OFF). POST { topic, question }: one answer about the caller's own company's records,
 * and maybe a draft for the person to copy. It writes nothing but the request's own log, cost and audit rows (ai_helper_reserve and
 * ai_helper_settle); every link it gives opens an existing page, where the person acts by hand.
 *
 * Off (404) unless BOTH AI_HELPER_ENABLED and AI_ASSISTANT_ENABLED are exactly "true", before any other work. Then: office and admin
 * only; a support session refused; the company's own switch (migration 133, off by default, admin only) read as the caller BEFORE any
 * record is read, and checked again by the database when the cost is reserved. While any of them is off, nothing is read, reserved
 * or sent to the AI provider. The records are read with the caller's own session (RLS), never the service role; the service role is
 * used only inside runAiHelper, after the reservation, to read this company's key and settle (migration 103).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true" || process.env.AI_ASSISTANT_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile([...AI_HELPER_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't use the AI assistant.", 403);

  const json = await readJson(request, ASSISTANT_BODY_MAX_BYTES);
  if (!json.ok) return json.response;
  const parsed = askSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Ask a question of up to 1,000 characters about quotes or jobs.", 400);
  const question = parsed.data.question;

  const organizationId = auth.profile.organization_id;
  // The company's switch first, so a company with the assistant off reads nothing (the database checks it again in reserve).
  const company = await readCompanyAssistant(auth.supabase, organizationId);
  if (!company.enabled) return NextResponse.json({ error: OFF, code: "off" }, { status: 404 });

  let rows: Record<string, unknown>[];
  try {
    rows = await loadAssistantRows(auth.supabase, parsed.data.topic, organizationId);
  } catch (error) {
    console.error("[ai-assistant] records could not be read", error instanceof Error ? error.message : "error");
    return jsonError("Your records could not be read just now. Nothing was sent to the AI.", 503);
  }
  const ctx = assistantContext(parsed.data.topic, rows, organizationId, toDateInput(new Date()));
  // Nothing to look at: no model call, no cost.
  if (ctx.records.length === 0) {
    return NextResponse.json({ answer: null, refs: [], draft: null, review: [], records: 0, notice: `There are no ${parsed.data.topic} to look at yet, so nothing was sent to the AI.` });
  }

  const outcome = await runAiHelper({
    supabase: auth.supabase,
    organizationId,
    feature: "assistant",
    system: ASSISTANT_SYSTEM_PROMPT,
    data: buildAssistantData(question, ctx),
    schema: ASSISTANT_OUTPUT_SCHEMA,
    validate: (answer) => {
      const checked = checkedAnswer(answer, ctx);
      return { value: checked.shown, store: checked.stored };
    },
  });
  if (outcome.kind === "ok") {
    return NextResponse.json({ requestId: outcome.requestId, ...outcome.value, records: ctx.records.length,
      notice: "Suggestions only: check it before you use it. Nothing was sent, saved or changed." });
  }
  if (outcome.kind === "off") return NextResponse.json({ error: OFF, code: "off" }, { status: 404 });
  const message = outcomeMessage(outcome);
  if (message.code === "refused") return NextResponse.json({ error: "The AI declined to answer that. Nothing was changed.", code: message.code }, { status: message.status });
  if (message.code === "invalid") return NextResponse.json({ error: "The AI's answer could not be used. Nothing was changed: try asking another way.", code: message.code }, { status: message.status });
  return NextResponse.json({ error: message.error, code: message.code }, { status: message.status });
}
