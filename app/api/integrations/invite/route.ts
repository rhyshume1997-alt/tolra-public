import { NextResponse } from "next/server";

import { siteOrigin } from "@/lib/integrations/app-credentials";
import { newInviteToken } from "@/lib/integrations/invite";
import { DbError } from "@/lib/integrations/server";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * Admin > Integrations > Xero > "Send the accountant a connect link" (E2, migration 107). Admin only, two-step, own company, never a
 * support session (the database checks all of it again). Makes a random one-use token, keeps only its SHA-256 for 24 hours, and answers
 * with the link for the admin to copy. The link is built on NEXT_PUBLIC_SITE_URL (never on the request's Host header) and grants nothing
 * but this company's Xero Connect.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const origin = siteOrigin();
  if (!origin) return jsonError("Not set up yet: the server's site address (NEXT_PUBLIC_SITE_URL) is missing.", 503);
  const { token, tokenHash } = newInviteToken();
  const { data, error } = await auth.supabase.rpc("integration_invite_create", { p_provider: "xero", p_token_hash: tokenHash });
  if (error) {
    const err = new DbError(error.message, error.code, (error as { hint?: string }).hint);
    if (err.code === "PGRST202" || err.code === "42883") return jsonError("Not available until database update 107 is applied.", 503);
    if (err.code === "42501") return jsonError(err.hint === "mfa_required" ? "Confirm your authenticator code first." : "Forbidden", 403);
    if (err.hint === "too_many_invites") return jsonError(err.message, 429);
    console.error("[integrations] invite create failed:", err.code ?? "error");
    return jsonError("Couldn't make the link. Try again.", 500);
  }
  const expiresAt = (data as { expires_at?: string } | null)?.expires_at ?? null;
  return NextResponse.json({ url: `${origin}/api/integrations/invite/${token}`, expiresAt }, { headers: { "cache-control": "no-store" } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cancel an open link: DELETE ?id=<invite id>. Admin only, two-step, own company, never a support session (the database checks all of
 * it again: integration_invite_revoke). A link that is already used, cancelled, expired or another company's is left as it is (404).
 */
export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!UUID.test(id)) return jsonError("Invalid request", 400);
  const { data, error } = await auth.supabase.rpc("integration_invite_revoke", { p_invite: id });
  if (error) {
    const err = new DbError(error.message, error.code, (error as { hint?: string }).hint);
    if (err.code === "PGRST202" || err.code === "42883") return jsonError("Not available until database update 107 is applied.", 503);
    if (err.code === "42501") return jsonError(err.hint === "mfa_required" ? "Confirm your authenticator code first." : "Forbidden", 403);
    console.error("[integrations] invite cancel failed:", err.code ?? "error");
    return jsonError("Couldn't cancel the link. Try again.", 500);
  }
  if (data !== true) return jsonError("That link is no longer open.", 404);
  return NextResponse.json({ ok: true });
}
