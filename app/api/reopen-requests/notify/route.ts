import { NextResponse } from "next/server";

import { sendCompanyEmail } from "@/lib/email/send-company-email";
import { isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A request is announced once, right after it is made (the mailer's idempotency key also stops a repeat). */
const FRESH_MS = 15 * 60 * 1000;
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/**
 * Tells the company's admins by e-mail about a reopen waiting for their sign-off (migration 113, lib/reopen-sign-off). The in-app
 * Approval Queue badge is the notice that always works; this e-mail goes through the company mailer (sendCompanyEmail, E8) and is
 * best effort: no mailer set up is an answer, not an error. Only the person who made the request, for a pending request of their own
 * session's company, made in the last 15 minutes. The request is read with the caller's own session (RLS: their company only); the
 * admins' addresses are read server side and never returned.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("Forbidden", 403);
  const auth = await requireProfile(["admin", "office", "workshop"]);
  if (isErrorResponse(auth)) return auth;
  const body = (await request.json().catch(() => null)) as { requestId?: unknown } | null;
  const requestId = typeof body?.requestId === "string" && UUID.test(body.requestId) ? body.requestId : null;
  if (!requestId) return jsonError("Unknown request", 400);

  const { data: row, error } = await auth.supabase.from("reopen_requests")
    .select("id, organization_id, record_ref, reason, requested_by, requested_at, status, approval_mode, reopened_at")
    .eq("id", requestId).maybeSingle<{ id: string; organization_id: string; record_ref: string | null; reason: string; requested_by: string; requested_at: string; status: string; approval_mode: string; reopened_at: string | null }>();
  if (error || !row || row.organization_id !== auth.profile.organization_id) return jsonError("Not found", 404);
  if (row.requested_by !== auth.user.id || row.status !== "pending" || Date.now() - Date.parse(row.requested_at) > FRESH_MS) {
    return jsonError("Nothing to announce", 409);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return NextResponse.json({ emailed: false, reason: "not_configured" });
  const { data: members } = await admin.from("organization_members").select("user_id, role, secondary_role")
    .eq("organization_id", row.organization_id).eq("active", true).eq("support", false);
  const adminIds = (members ?? []).filter((m: { role?: string; secondary_role?: string | null }) => m.role === "admin" || m.secondary_role === "admin")
    .map((m: { user_id: string }) => m.user_id).filter((id: string) => id !== auth.user.id);
  const { data: profiles } = adminIds.length
    ? await admin.from("user_profiles").select("email").in("id", adminIds).eq("active", true)
    : { data: [] as { email: string | null }[] };
  const to = [...new Set((profiles ?? []).map((p: { email: string | null }) => p.email ?? "").filter((email: string) => email.includes("@")))];
  if (!to.length) return NextResponse.json({ emailed: false, reason: "no_admin_address" });

  const ref = oneLine(row.record_ref ?? "A job");
  const who = oneLine(auth.profile.full_name ?? "A member of staff");
  const done = Boolean(row.reopened_at);
  const site = process.env.NEXT_PUBLIC_SITE_URL ? `${process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "")}/approval` : "the Approval Queue";
  const text = [
    done ? `${who} reopened ${ref} with no admin available. Please approve or reject it.` : `${who} asked to reopen ${ref} and is waiting for an admin to approve it.`,
    "",
    `Reason: ${row.reason}`,
    "",
    done ? "A rejection is recorded against the reopen; it does not undo it or the work done since." : `${ref} is not reopened until an admin approves it.`,
    `Sign it off in ${site}.`,
  ].join("\n");
  const sent = await sendCompanyEmail({
    organizationId: row.organization_id, userId: auth.user.id, kind: "alert", to,
    subject: `Reopen to sign off: ${ref}`, text, recordType: "reopen_request", recordId: row.id, idempotencyKey: `reopen-request-${row.id}`,
  });
  return NextResponse.json(sent.ok ? { emailed: true, mode: sent.mode } : { emailed: false, reason: sent.code });
}
