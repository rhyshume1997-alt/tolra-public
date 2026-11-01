import { NextResponse } from "next/server";

import { microsoftReady } from "@/lib/integrations/microsoft/client";
import { newConsentLink } from "@/lib/integrations/microsoft/consent";
import { notConfiguredResponse } from "@/lib/integrations/not-configured";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Admin > Integrations > Microsoft 365 > "Ask your Microsoft admin to approve" (C2). Admin only, two-step, own company, never a support
 * session. Answers a link for the company's Microsoft administrator (Microsoft's admin-consent page for Tolra's app, the exact scopes,
 * the existing Microsoft callback, and a signed state bound to this company that expires in 24 hours and works once), a mailto: for it,
 * and the permissions in plain words. Nothing is stored. While Microsoft 365 isn't set up (before go-live) the answer is a clean 503.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Microsoft 365 settings.", 403);
  const ready = await microsoftReady(createSupabaseAdminClient());
  if (!ready) return notConfiguredResponse("microsoft");
  const { data: org } = await auth.supabase.from("organizations").select("name").eq("id", auth.profile.organization_id).maybeSingle();
  const link = newConsentLink(ready.config, ready.key, { org: auth.profile.organization_id, userId: auth.user.id, company: (org as { name?: string } | null)?.name ?? null });
  return NextResponse.json(link, { headers: { "cache-control": "no-store" } });
}
