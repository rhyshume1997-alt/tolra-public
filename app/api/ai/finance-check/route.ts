import { NextResponse } from "next/server";

import { writeAiAudit } from "@/lib/ai/finance-check/audit";
import { runFinanceCheck } from "@/lib/ai/finance-check/check";
import { LoadError, loadFinanceCheckInput, sessionReader } from "@/lib/ai/finance-check/load";
import { FINANCE_CHECK_ROLES, checkRequestSchema } from "@/lib/ai/finance-check/request";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const NOT_AVAILABLE = "Check not available";

/**
 * Tolra AI agent 1, the pre-issue finance check (SUGGEST ONLY). POST { kind, id } for one draft invoice, purchase order or credit
 * note: reads it and its linked records as the caller (their JWT and RLS, their company; never the service role), runs the
 * deterministic checks and returns suggestions. Writes nothing but the two audit events. Off (404) unless AI_FINANCE_CHECK_ENABLED is
 * exactly "true" (lib/ai/finance-check/flag.ts), decided before any other work.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_FINANCE_CHECK_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile([...FINANCE_CHECK_ROLES]);
  if (isErrorResponse(auth)) return auth;
  // A support session (the platform owner inside a company) never runs an agent (spec rule 9), as on the Xero routes.
  if (auth.session?.support) return jsonError("Support access can't run the finance check.", 403);

  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const parsed = checkRequestSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { kind, id } = parsed.data;

  if (!(await writeAiAudit(auth.supabase, "ai_finance_check_requested", kind, id))) return jsonError(NOT_AVAILABLE, 503);

  let input;
  try {
    input = await loadFinanceCheckInput(sessionReader(auth.supabase, auth.profile.organization_id), kind, id);
  } catch (err) {
    if (err instanceof LoadError && err.status === 404) return jsonError("Not found", 404);
    if (err instanceof LoadError && err.status === 409) return jsonError("Only drafts are checked.", 409);
    console.error("[ai-finance-check] read failed", err instanceof LoadError ? err.reason : "error");
    return jsonError(NOT_AVAILABLE, 503);
  }

  const suggestions = runFinanceCheck(input);
  const codes = [...new Set(suggestions.map((s) => s.code))];
  if (!(await writeAiAudit(auth.supabase, "ai_finance_check_completed", kind, id, { count: suggestions.length, codes }))) return jsonError(NOT_AVAILABLE, 503);

  return NextResponse.json({ suggestions, checker: "rules-v1" });
}
