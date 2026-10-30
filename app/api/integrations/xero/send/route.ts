import { NextResponse } from "next/server";

import { sendQueued, xeroReady } from "@/lib/integrations/server";
import { MANUAL_SEND_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

// New documents are started only in the first 20 seconds; one already started may need a few Xero calls (contact, push, read-back) to
// finish. A function stopped mid-send leaves its row to be checked (needs_check), never sent twice; this keeps that rare.
export const maxDuration = 60;

/**
 * Admin > Integrations > Send now: sends what the caller's company has queued for Xero, retries whose time has come included (a few
 * documents per call; the rest go on the next). ADMIN ONLY (Rhys, Wed 21 Oct: every manual send, retry or resend is an admin's; the
 * automatic send right after an issue is /api/integrations/xero/after-issue). Only ever the caller's own company; counts only. Nothing is
 * sent unless the company is connected and every account and VAT rate used is mapped (the database's gate).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...MANUAL_SEND_ROLES]);
  if (isErrorResponse(auth)) return auth;
  // Support access (the platform owner inside a company) holds an admin membership but never changes or reads through this company's Xero:
  // refused before any Xero or database call, as on the Admin > Users routes. The database's connect functions exclude support too.
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const ready = await xeroReady();
  const service = createSupabaseAdminClient();
  if (!ready || !service) return NextResponse.json({ skipped: "not_configured" });
  try {
    const summary = await sendQueued(service, auth.profile.organization_id, ready, { maxDocuments: 10, budgetMs: 20_000 });
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[integrations] send run failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return NextResponse.json({ error: "The send to Xero stopped; it is tried again later." }, { status: 500 });
  }
}
