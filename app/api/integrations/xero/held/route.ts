import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRecentAal2 } from "@/lib/server/admin-users";
import { forbiddenOrigin, isErrorResponse, jsonError, mfaRecentRequired, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * Xero documents HELD for an admin's review (release 149). A document queued before transfers were switched on (before 149, while OFF, while
 * the connection needed reconnecting, or in an earlier ON period) is never sent by switching ON, a reconnect, a retry or the daily sweep: the
 * company's own admin reviews the list and explicitly approves each one. GET: the held list. POST {sends: [id, ...]}: approve those (1 to 200).
 * Admin of this company only, never a support session; approving always needs the second step with a RECENT authenticator code (forced even
 * while REQUIRE_ADMIN_MFA is off), and the database function checks admin, support, the fresh code, the company and the connection again.
 * Approving sends nothing by itself: an approved document goes once transfers are ON, on this connection only.
 */
export async function GET() {
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't review held Xero documents.", 403);
  const { data, error } = await auth.supabase.rpc("integration_xero_held_sends");
  if (error) return jsonError("Held Xero documents are not available. Nothing was changed.", 503);
  return NextResponse.json({ held: Array.isArray(data) ? data : [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't approve held Xero documents.", 403);
  const json = await readJson(request, 16 * 1024);
  if (!json.ok) return json.response;
  const parsed = z.object({ sends: z.array(z.string().uuid()).min(1).max(200) }).strict().safeParse(json.data);
  if (!parsed.success || new Set(parsed.data.sends).size !== parsed.data.sends.length) return jsonError("Choose 1 to 200 held documents, each once.", 400);
  const refused = await requireRecentAal2(auth, "approve held Xero documents", true);
  if (refused) return refused;
  const { data, error } = await auth.supabase.rpc("integration_xero_approve_held", { p_sends: parsed.data.sends });
  if (error) {
    const hint = (error as { hint?: string }).hint;
    if (hint === "mfa_recent_required") return mfaRecentRequired("approve held Xero documents");
    if (hint === "not_connected") return jsonError("Connect this company to Xero first.", 409);
    if (hint === "not_held") return jsonError("Only a waiting, failed or to-check document can be approved. Nothing was approved.", 409);
    if (error.code === "P0002") return jsonError("A chosen document was not found. Nothing was approved.", 404);
    return jsonError("Nothing was approved. Check your admin sign-in and the connection.", error.code === "42501" ? 403 : 409);
  }
  return NextResponse.json(data ?? { approved: 0 }, { headers: { "Cache-Control": "no-store" } });
}
