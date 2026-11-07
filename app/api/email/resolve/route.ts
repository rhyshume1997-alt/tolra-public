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
  const { data: row } = await supabase.from("email_history").select("id, organization_id, status, related_to_type, related_to_id").eq("id", parsed.data.history_id).eq("organization_id", profile.organization_id).maybeSingle();
  const current = row as { status: string; related_to_type: string | null } | null;
  if (!current) return jsonError("Email not found", 404);
  if (current.status !== "unknown" && current.status !== "sending") return jsonError("Only an email that needs checking can be settled here.", 409);
  if (current.related_to_type === "job") return jsonError("Settle a job email from its own Email history entry.", 409);
  const patch = parsed.data.outcome === "sent" ? { status: "sent_manually", sent_at: new Date().toISOString() } : { status: "drafted" };
  const { data: changed, error } = await supabase.from("email_history").update(patch).eq("id", parsed.data.history_id).eq("organization_id", profile.organization_id).eq("status", current.status).select("id");
  if (error || changed?.length !== 1) return jsonError("The email changed. Reload and check it again.", 409);
  if (parsed.data.outcome === "not_sent") {
    // The attempt's own history row (made by the send ledger) was left 'unknown'. A person has now checked it was not sent: it becomes a
    // confirmed failure, which moves the next approval to a new attempt key (the ledger still holds the old one as unknown, forever).
    await supabase.from("email_history").update({ status: "failed" }).eq("organization_id", profile.organization_id).eq("related_to_id", String((row as { related_to_id?: string }).related_to_id ?? "")).eq("status", "unknown").neq("id", parsed.data.history_id);
  }
  const audited = await recordSendAudit(supabase, { outcome: parsed.data.outcome === "sent" ? "resolved_sent" : "resolved_not_sent", historyId: parsed.data.history_id, channel: "email-resolve" }, request.headers.get("user-agent")?.slice(0, 256) ?? null, clientIp(request));
  return NextResponse.json({ status: parsed.data.outcome === "sent" ? "sent_manually" : "drafted", audited });
}
