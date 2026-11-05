import { NextResponse } from "next/server";
import { z } from "zod";

import { cleanAddress } from "@/lib/email/send-company-email";
import { siteOrigin } from "@/lib/integrations/app-credentials";
import { allowedInviteRedirect, newInviteRef } from "@/lib/integrations/invite";
import { sendInviteLinkEmail } from "@/lib/integrations/invite-mail";
import { notConfiguredResponse } from "@/lib/integrations/not-configured";
import { DbError, xeroReady } from "@/lib/integrations/server";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const NEEDS_151 = "Not available until database update 151 is applied.";
const createSchema = z.object({ email: z.string().max(254) }).strict();

/**
 * Admin > Integrations > Xero > "E-mail the accountant a connect link" (E2, migration 107; hardened by proposal 151). Admin only, two-step, own
 * company, never a support session (the database checks all of it again). The admin names the accountant's e-mail address; the invite is bound to
 * that address, this company and this admin. The link (an opaque reference only: it grants nothing on its own) is E-MAILED to that address through
 * the company's own mail provider and is NOT returned here. If it can't be sent (no provider, provider refused) the invite is cancelled again and
 * the admin is told, so no invite exists that nobody received. Built on NEXT_PUBLIC_SITE_URL (never the request's Host). The Xero redirect address
 * must be on the exact allow list (XERO_INVITE_REDIRECT_URIS) or no invite is made.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  // No Xero app details yet (they are entered at go-live): no invite is made, so none can be handed out that opens onto nothing.
  const ready = await xeroReady();
  if (!ready) return notConfiguredResponse("xero");
  if (!allowedInviteRedirect(ready.config)) {
    return jsonError("Not set up yet: the server's accountant-link redirect address (XERO_INVITE_REDIRECT_URIS) is missing or doesn't match.", 503);
  }
  const origin = siteOrigin();
  if (!origin) return jsonError("Not set up yet: the server's site address (NEXT_PUBLIC_SITE_URL) is missing.", 503);
  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const parsed = createSchema.safeParse(json.data);
  const email = parsed.success ? cleanAddress(parsed.data.email) : null;
  if (!email) return jsonError("Enter the accountant's e-mail address.", 400);
  const ref = newInviteRef();
  const { data, error } = await auth.supabase.rpc("integration_invite_create", { p_provider: "xero", p_ref: ref, p_recipient: email });
  if (error) {
    const err = new DbError(error.message, error.code, (error as { hint?: string }).hint);
    if (err.code === "PGRST202" || err.code === "42883") return jsonError(NEEDS_151, 503);
    if (err.code === "42501") return jsonError(err.hint === "mfa_required" ? "Confirm your authenticator code first." : "Forbidden", 403);
    if (err.hint === "too_many_invites") return jsonError(err.message, 429);
    if (err.hint === "invalid_recipient" || err.code === "22023") return jsonError("Enter the accountant's e-mail address.", 400);
    console.error("[integrations] invite create failed:", err.code ?? "error");
    return jsonError("Couldn't make the link. Try again.", 500);
  }
  const made = (data ?? {}) as { id?: string; expires_at?: string; recipient?: string };
  const { data: org } = await auth.supabase.from("organizations").select("name").eq("id", auth.profile.organization_id).maybeSingle();
  const sent = made.id
    ? await sendInviteLinkEmail({ organizationId: auth.profile.organization_id, userId: auth.user.id, inviteId: made.id, to: email,
        companyName: (org as { name?: string } | null)?.name ?? "A company", url: `${origin}/api/integrations/invite/${ref}` })
    : { ok: false as const, error: "Couldn't make the link. Try again." };
  if (!sent.ok) {
    // Nobody received it: cancel it again (best effort; it can't be used without the code, which only goes to that address, and it expires).
    if (made.id) await auth.supabase.rpc("integration_invite_revoke", { p_invite: made.id });
    return jsonError(sent.error, 502);
  }
  return NextResponse.json({ id: made.id, sent: true, recipient: made.recipient ?? null, expiresAt: made.expires_at ?? null }, { headers: { "cache-control": "no-store" } });
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
