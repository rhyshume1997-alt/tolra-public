import { NextResponse } from "next/server";
import { z } from "zod";

import { clientIp, forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const schema = z.object({
  historyId: z.string().uuid(),
  as: z.enum(["sent", "failed"]),
});

/**
 * An admin who has checked (the provider's log, or with the customer) settles a job e-mail whose outcome was unknown: it went,
 * or it didn't (and may be sent again). Migration 033, the same pattern as /api/mail/resolve.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;

  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { historyId, as } = parsed.data;

  const { error } = await auth.supabase.rpc("resolve_job_email", { p_history: historyId, p_as: as });
  if (error) {
    if (error.code === "42501") return NextResponse.json({ error: "Forbidden", code: error.hint === "mfa_required" ? "mfa_required" : undefined }, { status: 403 });
    if (error.code === "P0002") return jsonError("Send not found", 404);
    if (error.code === "PT409") return jsonError("Only an email with an unknown outcome can be settled.", 409);
    console.error("[send-job/resolve] failed", error.code);
    return jsonError("Could not update the email", 500);
  }
  const { error: auditError } = await auth.supabase.rpc("write_audit", {
    p_action: "UPDATE",
    p_entity_table: "email_history",
    p_entity_id: historyId,
    p_old: { outcome: "unknown" },
    p_new: { outcome: as === "sent" ? "confirmed_sent" : "failed", resolved_by_admin: true },
    p_metadata: { channel: "job-email" },
    p_ip: clientIp(request),
    p_user_agent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
  });
  if (auditError) console.error("[send-job/resolve] audit failed", auditError.code);
  return NextResponse.json({ status: as === "sent" ? "sent" : "failed" });
}
