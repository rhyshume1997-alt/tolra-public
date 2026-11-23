import { NextResponse } from "next/server";

import { checkIssueFilters, checkOwnerUpdate, ownerIssueRefusal, parseOwnerIssue } from "@/lib/issues/issues";
import { ownerIssuesEnabled } from "@/lib/issues/owner-flag";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

// The platform owner's issues inbox: GET lists issues across all companies (?org=&status=&urgent=), PATCH { id, status, notes, prUrl } sets
// the status, the private notes and the PR link (status "closed" closes it). OFF unless OWNER_ISSUES_ENABLED is exactly "true" (404 for the
// platform owner, before any issue is read or changed; everyone else is refused by the guard first, as on every platform route).
// Order: requirePlatformOwner (same origin, signed in, is_platform_admin(), aal2) -> flag -> checked input -> ONE call to
// release 165's platform_list_issues / platform_update_issue with the owner's OWN session; the database checks the owner and the second
// step again. The service role is never used here. Database messages are never returned. No e-mail is sent and no AI is called.

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  if (!ownerIssuesEnabled()) return jsonError("Not found", 404);
  const filters = checkIssueFilters(new URL(request.url).searchParams);
  if (!filters.ok) return jsonError(filters.error, 400);

  const { data, error } = await ctx.supabase.rpc("platform_list_issues", {
    p_org: filters.value.organizationId, p_status: filters.value.status, p_urgent: filters.value.urgent, p_limit: 200,
  });
  if (error) {
    console.error("[platform] issues list refused", error.code ?? "no-code", error.hint ?? "");
    const refusal = ownerIssueRefusal(error);
    return NextResponse.json({ error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}) }, { status: refusal.status });
  }
  const issues = (Array.isArray(data) ? data : []).map(parseOwnerIssue).filter((issue) => issue !== null);
  const companies = ctx.companies.map((company) => ({ organizationId: company.organization_id, name: company.name }));
  return NextResponse.json({ issues, companies }, { headers: NO_STORE });
}

export async function PATCH(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  if (!ownerIssuesEnabled()) return jsonError("Not found", 404);
  const json = await readJson(request, 16 * 1024);
  if (!json.ok) return json.response;
  const checked = checkOwnerUpdate(json.data);
  if (!checked.ok) return jsonError(checked.error, 400);
  const { id, status, notes, prUrl } = checked.value;

  const { data, error } = await ctx.supabase.rpc("platform_update_issue", { p_id: id, p_status: status, p_notes: notes, p_pr_url: prUrl });
  if (error) {
    console.error("[platform] issue update refused", error.code ?? "no-code", error.hint ?? "");
    const refusal = ownerIssueRefusal(error);
    return NextResponse.json({ error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}) }, { status: refusal.status });
  }
  const result = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!result || result.issue_id !== id) return jsonError("Couldn't confirm the change. Reload before trying again.", 500);
  console.info(JSON.stringify({ event: "platform.issue_updated", actor: ctx.user.id, issue_id: id, status, at: new Date().toISOString() }));
  return NextResponse.json({ ok: true, status: result.status, closedAt: result.closed_at ?? null, updatedAt: result.updated_at ?? null }, { headers: NO_STORE });
}
