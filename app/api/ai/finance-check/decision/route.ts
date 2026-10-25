import { NextResponse } from "next/server";

import { writeAiAudit } from "@/lib/ai/finance-check/audit";
import { documentVisible, sessionReader } from "@/lib/ai/finance-check/load";
import { FINANCE_CHECK_ROLES, decisionRequestSchema } from "@/lib/ai/finance-check/request";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * Accept or dismiss one finance-check suggestion. Records ai_suggestion_accepted / ai_suggestion_rejected and NOTHING ELSE: accepting
 * changes nothing on the document (the person edits it themselves through the normal editor). Same switch, roles and support refusal
 * as the check route; the document must be readable by the caller in their own company.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_FINANCE_CHECK_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile([...FINANCE_CHECK_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't run the finance check.", 403);

  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const parsed = decisionRequestSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { kind, id, suggestionId, code, decision } = parsed.data;

  try {
    if (!(await documentVisible(sessionReader(auth.supabase, auth.profile.organization_id), kind, id))) return jsonError("Not found", 404);
  } catch {
    return jsonError("Check not available", 503);
  }
  const action = decision === "accepted" ? "ai_suggestion_accepted" : "ai_suggestion_rejected";
  if (!(await writeAiAudit(auth.supabase, action, kind, id, { suggestion_id: suggestionId, code }))) return jsonError("Check not available", 503);
  return NextResponse.json({ ok: true, changed: false });
}
