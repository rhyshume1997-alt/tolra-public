import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { knownCustomer } from "@/lib/ai-helper/customers";
import { AI_HELPER_ROLES } from "@/lib/ai-helper/flag";
import { RFQ_BODY_MAX_BYTES, RFQ_MAX_BYTES, RFQ_MAX_CHARS, RFQ_MAX_LINES, RFQ_PAST_LINES } from "@/lib/ai-helper/limits";
import {
  ATTACHMENTS_REFUSED, type PastLine, RFQ_OUTPUT_SCHEMA, RFQ_SYSTEM_PROMPT, type RfqSuggestion, buildRfqData, looksLikeInjection, sanitizeRfqAnswer,
  searchWords, storedRfqOutput,
} from "@/lib/ai-helper/rfq";
import { outcomeMessage, runAiHelper } from "@/lib/ai-helper/server";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const rfqSchema = z.object({ text: z.string().max(RFQ_MAX_CHARS) }).strict();

/** Up to RFQ_PAST_LINES of this company's own past quote lines sharing a word with the email (the caller's session and RLS). */
async function pastLines(db: SupabaseClient, org: string, text: string): Promise<PastLine[]> {
  const words = searchWords(text);
  if (!words.length) return [];
  try {
    const { data: lines, error } = await db.from("quote_line_items").select("quote_id, description, quantity").eq("organization_id", org)
      .or(words.map((w) => `description.ilike.%${w}%`).join(",")).limit(RFQ_PAST_LINES);
    if (error || !lines?.length) return [];
    const ids = [...new Set(lines.map((l) => String(l.quote_id)))];
    const { data: quotes, error: quoteError } = await db.from("quotes").select("id, quote_ref").eq("organization_id", org).in("id", ids);
    if (quoteError) return [];
    const refs = new Map((quotes ?? []).map((q) => [String(q.id), String(q.quote_ref)]));
    return lines.filter((l) => refs.has(String(l.quote_id)) && typeof l.description === "string")
      .map((l) => ({ ref: refs.get(String(l.quote_id))!, description: String(l.description).slice(0, 300), quantity: typeof l.quantity === "number" ? l.quantity : Number(l.quantity) || null }));
  } catch {
    return [];
  }
}

/**
 * RFQ email to draft quote (SUGGEST ONLY). POST { text }: the pasted email text (no attachments in v1). The model reads it, with this
 * company's similar past quote lines as examples, into customer and spec lines; lib/ai-helper/rfq.ts keeps only what it allows and flags
 * every missing or unclear field "Needs human review". No price comes from the model. Nothing is saved here but the request's audit and
 * cost rows and the validated suggestion: Approve (rfq/decision) rebuilds the draft from that stored suggestion on the server.
 * Off (404) unless AI_HELPER_ENABLED is exactly "true"; the company's RFQ switch, the role, the key and the cap are checked by the
 * database before any model call (ai_helper_reserve).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile([...AI_HELPER_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't use the AI helper.", 403);

  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return jsonError(ATTACHMENTS_REFUSED, 415);
  const json = await readJson(request, RFQ_BODY_MAX_BYTES);
  if (!json.ok) return json.response;
  const body = json.data as Record<string, unknown> | null;
  if (body && typeof body === "object" && ["attachments", "attachment", "files", "file", "drawings"].some((k) => k in body)) return jsonError(ATTACHMENTS_REFUSED, 415);
  const parsed = rfqSchema.safeParse(body);
  if (!parsed.success) return jsonError(`Paste the email text only (up to ${RFQ_MAX_CHARS.toLocaleString("en-GB")} characters).`, 400);
  const text = parsed.data.text.trim();
  if (!text) return jsonError("Paste the RFQ email text first.", 400);
  if (Buffer.byteLength(text, "utf8") > RFQ_MAX_BYTES) return jsonError("That email is too long to read in one go.", 413);

  const org = auth.profile.organization_id;
  const { data: status, error: statusError } = await auth.supabase.rpc("ai_helper_status");
  if (statusError) return jsonError("The AI helper is not available right now.", 503);
  if ((status as { rfq_enabled?: boolean } | null)?.rfq_enabled !== true) return jsonError("The AI helper is off for this company.", 404);

  const past = await pastLines(auth.supabase, org, text);
  const knownRefs = new Set(past.map((line) => line.ref));
  const inputSuspicious = looksLikeInjection(text);
  const outcome = await runAiHelper<RfqSuggestion>({
    supabase: auth.supabase,
    organizationId: org,
    feature: "rfq",
    system: RFQ_SYSTEM_PROMPT,
    data: buildRfqData(text, past),
    schema: RFQ_OUTPUT_SCHEMA,
    // The customer is checked against this company's own customers before the suggestion is stored, so the row says the same.
    validate: async (answer) => {
      const clean = sanitizeRfqAnswer(answer, { knownRefs, inputSuspicious, maxLines: RFQ_MAX_LINES });
      const value: RfqSuggestion = { ...clean, customerKnown: await knownCustomer(auth.supabase, org, clean.customer) };
      return { value, store: storedRfqOutput(value) };
    },
  });
  if (outcome.kind !== "ok") {
    const { status: code, error, code: reason } = outcomeMessage(outcome);
    return NextResponse.json({ error, code: reason }, { status: code });
  }
  return NextResponse.json({ requestId: outcome.requestId, suggestion: outcome.value });
}
