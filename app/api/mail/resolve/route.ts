import { NextResponse } from "next/server";
import { z } from "zod";

import { mailGuard } from "@/lib/m365/route";
import { clientIp, isErrorResponse, jsonError, readJson } from "@/lib/server/auth";

const schema = z.object({
  sendId: z.string().uuid(),
  as: z.enum(["sent", "failed"]),
});

/** An admin who has checked Sent Items settles a send whose outcome was unknown: it went, or it didn't (and may be retried). */
export async function POST(request: Request) {
  const ctx = await mailGuard(request);
  if (isErrorResponse(ctx)) return ctx;

  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { sendId, as } = parsed.data;

  const { data: historyId, error } = await ctx.auth.supabase.rpc("resolve_mail_send", { p_id: sendId, p_as: as });
  if (error) {
    if (error.code === "42501") return jsonError("Forbidden", 403);
    if (error.code === "P0002") return jsonError("Send not found", 404);
    if (error.code === "PT409") return jsonError(error.message, 409);
    console.error("[mail/resolve] failed", error.code);
    return jsonError("Could not update the send", 500);
  }
  const { error: auditError } = await ctx.auth.supabase.rpc("write_audit", {
    p_action: "UPDATE",
    p_entity_table: "email_history",
    p_entity_id: historyId as string,
    p_old: { outcome: "unknown" },
    p_new: { outcome: as === "sent" ? "confirmed_sent" : "failed", resolved_by_admin: true },
    p_metadata: { channel: "microsoft365", ledger_id: sendId },
    p_ip: clientIp(request),
    p_user_agent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
  });
  if (auditError) console.error("[mail/resolve] audit failed", auditError.code);
  return NextResponse.json({ status: as === "sent" ? "confirmed_sent" : "failed" });
}
