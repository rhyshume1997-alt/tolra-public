import { NextResponse } from "next/server";
import { z } from "zod";

import { approveChaseDraft } from "@/lib/email/chase/approve";
import { localDate } from "@/lib/email/schedules/due";
import { EMAIL_SEND_ROLES, onRecipientAllowlist, selectProvider, sendCompanyEmail } from "@/lib/email/send-company-email";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * POST /api/chase/approve { history_id, subject, body }: "Approve and send" a chase draft from the Approvals queue (migration 138).
 * Office and admin of the company only (requireProfile: an admin also needs the second step when required); a support session is refused.
 * Every check is lib/email/chase/approve.ts's. Sends through the company mailer (Microsoft 365, else Resend) in the person's own session;
 * with no mailer set up it answers 409 { status: "no_provider" } and writes nothing (the draft stays for Copy / mail app / Mark as Sent).
 */
const schema = z.object({
  history_id: z.string().uuid(),
  subject: z.string().max(200),
  body: z.string().max(100_000),
});

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...EMAIL_SEND_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't send e-mail.", 403);
  const { supabase, profile, user } = auth;
  const admin = createSupabaseAdminClient();
  if (!admin) return jsonError("Service unavailable", 503);

  const json = await readJson(request, 256 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);

  const { data: schedule } = await admin.from("email_schedules").select("timezone").eq("organization_id", profile.organization_id).eq("kind", "invoice_reminder").maybeSingle();
  const zone = (schedule as { timezone?: string } | null)?.timezone || "Europe/London";
  const result = await approveChaseDraft(
    { organizationId: profile.organization_id, userId: user.id, draftId: parsed.data.history_id, subject: parsed.data.subject, body: parsed.data.body, today: localDate(new Date(), zone) },
    {
      db: supabase,
      admin,
      provider: (org) => selectProvider(org),
      send: (input) => sendCompanyEmail(input, { db: supabase }),
      allowlisted: (address) => onRecipientAllowlist(address, process.env.EMAIL_RECIPIENT_DOMAINS),
    },
  );
  if (result.status === "sent") return NextResponse.json({ status: "sent", history_id: result.historyId, recorded: result.recorded });
  if (result.status === "no_provider") return NextResponse.json({ status: "no_provider", error: result.message }, { status: 409 });
  return NextResponse.json({ status: "refused", error: result.message }, { status: result.http });
}
