import { NextResponse } from "next/server";
import { z } from "zod";

import { AI_HELPER_ROLES } from "@/lib/ai-helper/flag";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const decisionSchema = z.discriminatedUnion("decision", [
  z.object({ requestId: z.string().regex(UUID), decision: z.literal("approved"), quoteId: z.string().regex(UUID) }).strict(),
  z.object({ requestId: z.string().regex(UUID), decision: z.literal("rejected") }).strict(),
]);

/**
 * Records the person's decision on an RFQ suggestion (ai_helper_decide, as the caller; audited ai_helper_approved / ai_helper_rejected)
 * and NOTHING ELSE. Approved names the draft quote the person's own Approve click already created through create_with_lines; the
 * database checks it is a draft of this company made after the suggestion, and that the suggestion is this company's and undecided.
 * Off (404) unless AI_HELPER_ENABLED is exactly "true".
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile([...AI_HELPER_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't use the AI helper.", 403);

  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = decisionSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const body = parsed.data;
  const { error } = await auth.supabase.rpc("ai_helper_decide", {
    p_request: body.requestId, p_decision: body.decision, p_quote: body.decision === "approved" ? body.quoteId : null,
  });
  if (error) {
    console.error("[ai-helper] decision refused", error.code ?? "error");
    return error.code === "42501" ? jsonError("This suggestion can't be decided here.", 404) : jsonError("The decision could not be recorded.", 503);
  }
  return NextResponse.json({ ok: true });
}
