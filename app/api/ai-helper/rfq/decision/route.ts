import { NextResponse } from "next/server";
import { z } from "zod";

import { approveEditsSchema, companyVatFromProfile, createDraftQuote, planDraft, readStoredSuggestion } from "@/lib/ai-helper/approve";
import { knownCustomer } from "@/lib/ai-helper/customers";
import { AI_HELPER_ROLES } from "@/lib/ai-helper/flag";
import { costingPrices } from "@/lib/ai-helper/pricing";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { serverCostingDeps } from "@/lib/server/costing-engine";
import { ValidationError } from "@/lib/validation/schemas";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Room for the edits of RFQ_MAX_LINES lines; nothing else is accepted. */
const DECISION_BODY_MAX_BYTES = 32 * 1024;

// Strict: a body carrying lines, prices, a quote id or any other key is refused (400) and nothing is saved.
const decisionSchema = z.discriminatedUnion("decision", [
  z.object({ requestId: z.string().regex(UUID), decision: z.literal("approved"), edits: approveEditsSchema.optional() }).strict(),
  z.object({ requestId: z.string().regex(UUID), decision: z.literal("rejected") }).strict(),
]);

/**
 * The person's decision on an RFQ suggestion. Rejected records the decision only (ai_helper_decide; audited ai_helper_rejected).
 * Approved builds the draft HERE, on the server, from the suggestion the database stored when the AI answered (ai_helper_requests.output,
 * read with the caller's session and RLS), plus the person's line corrections, re-checked and re-priced on the server for this company
 * (lib/ai-helper/approve.ts). The browser sends no line content to copy and no price. The draft is created through next_doc_number and
 * create_with_lines under the caller's own session, then ai_helper_decide links it (audited ai_helper_approved). Nothing is sent or issued.
 * Off (404) unless AI_HELPER_ENABLED is exactly "true".
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile([...AI_HELPER_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't use the AI helper.", 403);

  const json = await readJson(request, DECISION_BODY_MAX_BYTES);
  if (!json.ok) return json.response;
  const parsed = decisionSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const body = parsed.data;
  // The company's RFQ switch, as the rfq route checks it: off (or no settings row) records nothing.
  const { data: status, error: statusError } = await auth.supabase.rpc("ai_helper_status");
  if (statusError) return jsonError("The AI helper is not available right now.", 503);
  if ((status as { rfq_enabled?: boolean } | null)?.rfq_enabled !== true) return jsonError("The AI helper is off for this company.", 404);

  let quote: { id: string; ref: string } | null = null;
  if (body.decision === "approved") {
    const org = auth.profile.organization_id;
    const { data: row, error: rowError } = await auth.supabase.from("ai_helper_requests").select("id, feature, status, output")
      .eq("id", body.requestId).eq("organization_id", org).maybeSingle();
    if (rowError) return jsonError("The AI helper is not available right now.", 503);
    const stored = row && row.feature === "rfq" && row.status === "suggested" ? readStoredSuggestion(row.output) : null;
    if (!stored) return jsonError("This suggestion can't be decided here.", 404);
    try {
      const { data: settings } = await auth.supabase.from("organization_settings").select("company_profile").eq("organization_id", org).maybeSingle();
      const engine = serverCostingDeps(org);
      const plan = await planDraft(stored, body.edits, {
        price: (lines) => costingPrices(lines, engine),
        customerKnown: (name) => knownCustomer(auth.supabase, org, name),
      });
      quote = await createDraftQuote(auth.supabase, plan, companyVatFromProfile(settings?.company_profile));
    } catch (err) {
      if (err instanceof ValidationError) return jsonError(err.message, 400);
      console.error("[ai-helper] draft not created", (err as { code?: string })?.code ?? "error");
      return jsonError("Could not create the draft quote. Nothing was saved.", 503);
    }
  }

  const { error } = await auth.supabase.rpc("ai_helper_decide", {
    p_request: body.requestId, p_decision: body.decision, p_quote: quote?.id ?? null,
  });
  if (error) {
    console.error("[ai-helper] decision refused", error.code ?? "error");
    if (quote) return NextResponse.json({ error: `Draft quote ${quote.ref} was created, but the approval could not be recorded.`, quoteId: quote.id, ref: quote.ref }, { status: 503 });
    return error.code === "42501" ? jsonError("This suggestion can't be decided here.", 404) : jsonError("The decision could not be recorded.", 503);
  }
  return NextResponse.json(quote ? { ok: true, quoteId: quote.id, ref: quote.ref } : { ok: true });
}
