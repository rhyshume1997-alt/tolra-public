import { NextResponse } from "next/server";

import { delegatedMailbox, microsoftReady } from "@/lib/integrations/microsoft/client";
import { type InboxCheckSummary, NOT_CONNECTED_REASON, checkCompanyInbox } from "@/lib/integrations/microsoft/inbox";
import { DbError } from "@/lib/integrations/server";
import { forbiddenOrigin, isErrorResponse, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Who may check the company's inbox (the browser check and the Check inbox button): admin and office. Workshop and viewer: 403. */
const ROLES = ["admin", "office"];
const NO_STORE = { "Cache-Control": "no-store" };
const notConnected: InboxCheckSummary = { checked_at: null, new: 0, status: "not_connected", reason: NOT_CONNECTED_REASON };

/**
 * The company's own inbox through its delegated Microsoft 365 connection (C1, migration 127), for a signed-in admin or office user of
 * the session's active company only (requireProfile: the session's company and roles from the database, an active membership, and an
 * admin's second step when the app requires it). There is no company parameter: the company is always the session's.
 *
 * POST: one check now (the browser check every few minutes while Tolra is open, and the Check inbox button), throttled per company
 * (127's mailbox_sync_claim: one real check per 90 seconds whatever the number of tabs or users; the others get "recent"). The browser
 * gets { checked_at, new, status, reason } only: never a token, the cursor, the service key or Microsoft's error text.
 * GET: { available } (whether this company's inbox can be read through its connection), so the RFQ page knows to use this endpoint.
 * The legacy app-only mailbox stays on /api/mail/poll (admins only); /api/cron/mail-poll (not scheduled) runs every company.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(ROLES);
  if (isErrorResponse(auth)) return auth;
  const org = auth.profile.organization_id;
  try {
    const service = createSupabaseAdminClient();
    const ready = service ? await microsoftReady(service) : null;
    if (!service || !ready) return NextResponse.json(notConnected, { headers: NO_STORE });
    return NextResponse.json(await checkCompanyInbox({ service, ready, org }), { headers: NO_STORE });
  } catch (err) {
    console.error("[mail/check] failed", err instanceof DbError ? err.code : err instanceof Error ? err.name : "error");
    const failed: InboxCheckSummary = { checked_at: null, new: 0, status: "failed", reason: "Couldn't check mail just now. Tolra will try again shortly." };
    return NextResponse.json(failed, { status: 500, headers: NO_STORE });
  }
}

export async function GET() {
  const auth = await requireProfile(ROLES);
  if (isErrorResponse(auth)) return auth;
  const service = createSupabaseAdminClient();
  const ready = service ? await microsoftReady(service).catch(() => null) : null;
  const available = Boolean(service && ready && (await delegatedMailbox(service, auth.profile.organization_id).catch(() => null)));
  return NextResponse.json({ available }, { headers: NO_STORE });
}
