import { NextResponse } from "next/server";

import { CHASE_NOT_APPLIED, runChase } from "@/lib/email/chase/run";
import { localDate } from "@/lib/email/schedules/due";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const maxDuration = 60;

/**
 * POST /api/chase/run: Invoices > Chase All Overdue (migration 138). DRAFTS ONLY: the same chase steps as the scheduled pass
 * (lib/email/chase/run.ts), for the caller's company, each step at most once per invoice, each draft in the Approvals queue. Nothing is
 * e-mailed. Office and admin only; a support session is refused. The drafts are made through public.chase_create_draft with the service
 * role, which checks again that the caller is an active office or admin member of the company and records them as the drafter.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin", "office"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't chase invoices.", 403);
  const admin = createSupabaseAdminClient();
  if (!admin) return jsonError("Service unavailable", 503);
  const org = auth.profile.organization_id;

  const { data: schedule } = await admin.from("email_schedules").select("timezone, recipients").eq("organization_id", org).eq("kind", "invoice_reminder").maybeSingle();
  const row = schedule as { timezone?: string; recipients?: string[] | null } | null;
  try {
    const result = await runChase(admin, { organizationId: org, today: localDate(new Date(), row?.timezone || "Europe/London"), recipients: row?.recipients ?? null, userId: auth.user.id }, { deadline: Date.now() + 45_000 });
    if (result.error === CHASE_NOT_APPLIED) return jsonError("Payment reminder settings are not available yet. Ask your admin to contact Tolra support.", 503);
    return NextResponse.json({ drafted: result.drafted, skipped: result.skipped, failed: result.failed, reasons: result.reasons, error: result.error });
  } catch (err) {
    console.error("[chase/run] failed", err instanceof Error ? err.name : "unknown");
    return jsonError("Couldn't draft the chase e-mails. Try again.", 500);
  }
}
