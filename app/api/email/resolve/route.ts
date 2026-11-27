import { NextResponse } from "next/server";
import { z } from "zod";

import { recordSendAudit } from "@/lib/email/chase/send-audit";
import { clientIp, forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const schema = z.object({ history_id: z.string().uuid(), outcome: z.enum(["sent", "not_sent"]) }).strict();

/**
 * An admin who has CHECKED (the provider's sent items, or the customer) settles an e-mail whose outcome was unknown, or that was left
 * 'sending'. It records who and when (audit row) and moves the record; it NEVER sends. "sent": the message is recorded as sent by hand.
 * "not sent": it goes back to the queue as a draft, to be approved again by a person. Job e-mails have their own ledger and are settled by
 * /api/send-job/resolve, not here.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't settle e-mail.", 403);
  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { supabase, profile } = auth;
  const { data: status, error } = await supabase.rpc("resolve_approval_email", {
    p_org: profile.organization_id, p_user: auth.user.id, p_history: parsed.data.history_id, p_outcome: parsed.data.outcome,
  });
  const expected = parsed.data.outcome === "sent" ? "sent_manually" : "drafted";
  if (error || status !== expected) return jsonError("This email is still held. Its exact send attempt could not be settled. Check Email history before proceeding.", 409);
  const audited = await recordSendAudit(supabase, { outcome: parsed.data.outcome === "sent" ? "resolved_sent" : "resolved_not_sent", historyId: parsed.data.history_id, channel: "email-resolve" }, request.headers.get("user-agent")?.slice(0, 256) ?? null, clientIp(request));
  return NextResponse.json({ status, audited });
}
