import { NextResponse } from "next/server";

import { delegatedMailbox } from "@/lib/integrations/microsoft/client";
import { mailConfig, type MailConfig } from "@/lib/m365/graph";
import { isErrorResponse, requireProfile } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Whether Microsoft 365 mail is switched on for the signed-in admin's company (its own delegated connection with Mail.Read, or the
 * legacy app-only mailbox), so the RFQ page shows "Check inbox" only
 * when it works (hidden otherwise) instead of a button that only answers "not configured". Read only: nothing is sent to Microsoft and no
 * setting, secret or mailbox name is returned.
 */
export async function GET() {
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  let config: MailConfig | null = null;
  try {
    config = mailConfig();
  } catch {
    config = null;
  }
  // The company's own delegated connection that may read mail (C1), or the legacy app-only mailbox mapped to it.
  let configured = Boolean(config) && auth.profile.organization_id === config?.organizationId;
  const service = configured ? null : createSupabaseAdminClient();
  if (service) configured = Boolean(await delegatedMailbox(service, auth.profile.organization_id).catch(() => null));
  return NextResponse.json({ configured }, { headers: { "Cache-Control": "no-store" } });
}
