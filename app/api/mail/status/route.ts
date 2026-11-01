import { NextResponse } from "next/server";

import { mailConfig, type MailConfig } from "@/lib/m365/graph";
import { isErrorResponse, requireProfile } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/**
 * Whether Microsoft 365 mail is switched on for the signed-in admin's company, so the RFQ page shows "Check inbox" only
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
  const configured = Boolean(config) && auth.profile.organization_id === config?.organizationId;
  return NextResponse.json({ configured }, { headers: { "Cache-Control": "no-store" } });
}
