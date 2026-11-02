import { NextResponse } from "next/server";
import { z } from "zod";

import { accountantInviteUrl, accountantMailto } from "@/lib/integrations/accountant-invite";
import { siteOrigin } from "@/lib/integrations/app-credentials";
import { newInviteToken } from "@/lib/integrations/invite";
import { DbError, xeroReady } from "@/lib/integrations/server";
import { requireAal2 } from "@/lib/server/admin-users";
import { forbiddenOrigin, isErrorResponse, jsonError, mfaRequired, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * Admin > Integrations > "Invite your accountant" (C3, migration 129). Admin only, the second sign-in step always (aal2), own company,
 * never a support session (the database checks all of it again: create_accountant_invite). Makes a random token, keeps only its SHA-256;
 * the role is always viewer and the invite lasts 7 days. Answers with the link for the admin to copy or send (Tolra sends nothing here).
 * { connectXero: true } also makes the EXISTING Xero connect link (107, integration_invite_create, 24 hours), offered on the accountant's
 * page, only while Xero is set up on this server and not connected for this company. The links are built on NEXT_PUBLIC_SITE_URL.
 */
const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  connectXero: z.boolean().optional(),
});

const NEEDS_129 = "Not available until database update 129 is applied.";

function dbError(error: { message: string; code?: string; hint?: string }) {
  return new DbError(error.message, error.code, error.hint);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't invite anyone.", 403);
  const refused = await requireAal2(auth);
  if (refused) return refused;
  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const parsed = createSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Enter the accountant's e-mail address.", 400);
  const origin = siteOrigin();
  if (!origin) return jsonError("Not set up yet: the server's site address (NEXT_PUBLIC_SITE_URL) is missing.", 503);

  const { token, tokenHash } = newInviteToken();
  const { data, error } = await auth.supabase.rpc("create_accountant_invite", { p_email: parsed.data.email, p_token_hash: tokenHash });
  if (error) {
    const err = dbError(error as { message: string; code?: string; hint?: string });
    if (err.code === "PGRST202" || err.code === "42883") return jsonError(NEEDS_129, 503);
    if (err.code === "42501") return err.hint === "mfa_required" ? mfaRequired() : jsonError("Forbidden", 403);
    if (err.code === "23505") return jsonError(err.message, 409);
    if (err.code === "22023") return jsonError("Enter the accountant's e-mail address.", 400);
    console.error("[integrations] accountant invite failed:", err.code ?? "error");
    return jsonError("Couldn't make the invite. Try again.", 500);
  }
  const invite = (data ?? {}) as { id?: string; email?: string; expires_at?: string };

  // The Xero step (optional): the existing connect link, only while Xero is set up here and not connected for this company.
  let xeroToken: string | null = null;
  let xeroProblem: string | null = null;
  if (parsed.data.connectXero) {
    const overview = await auth.supabase.rpc("integration_overview", { p_provider: "xero" });
    const connected = (overview.data as { status?: string } | null)?.status === "connected";
    if (connected) xeroProblem = "Xero is already connected for this company, so the invite has no Xero step.";
    else if (!(await xeroReady())) xeroProblem = "Xero isn't set up on this server yet, so the invite has no Xero step.";
    else {
      const xero = newInviteToken();
      const made = await auth.supabase.rpc("integration_invite_create", { p_provider: "xero", p_token_hash: xero.tokenHash });
      if (made.error) {
        const err = dbError(made.error as { message: string; code?: string; hint?: string });
        xeroProblem = err.hint === "too_many_invites" ? err.message : "Couldn't add the Xero step; the invite works without it.";
        if (err.hint !== "too_many_invites") console.error("[integrations] accountant invite xero step failed:", err.code ?? "error");
      } else xeroToken = xero.token;
    }
  }

  const { data: org } = await auth.supabase.from("organizations").select("name").eq("id", auth.profile.organization_id).maybeSingle();
  const url = accountantInviteUrl(origin, token, xeroToken);
  const email = invite.email ?? parsed.data.email;
  return NextResponse.json({
    id: invite.id ?? null, email, url, expiresAt: invite.expires_at ?? null, xero: xeroToken !== null, xeroProblem,
    mailto: accountantMailto(url, (org as { name?: string } | null)?.name ?? null, email, xeroToken !== null),
  }, { status: 201, headers: { "cache-control": "no-store" } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revoke an open accountant invite: DELETE ?id=<invite id>. Admin only, own company, never a support session; the company's two-step rule
 * applies (the database checks it again: revoke_accountant_invite). One already used, revoked, expired or another company's: 404.
 */
export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't cancel an invite.", 403);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!UUID.test(id)) return jsonError("Invalid request", 400);
  const { data, error } = await auth.supabase.rpc("revoke_accountant_invite", { p_invite: id });
  if (error) {
    const err = dbError(error as { message: string; code?: string; hint?: string });
    if (err.code === "PGRST202" || err.code === "42883") return jsonError(NEEDS_129, 503);
    if (err.code === "42501") return err.hint === "mfa_required" ? mfaRequired() : jsonError("Forbidden", 403);
    console.error("[integrations] accountant invite revoke failed:", err.code ?? "error");
    return jsonError("Couldn't cancel the invite. Try again.", 500);
  }
  if (data !== true) return jsonError("That invite is no longer open.", 404);
  return NextResponse.json({ ok: true });
}
