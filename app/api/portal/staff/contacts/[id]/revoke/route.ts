import { forbiddenOrigin, isErrorResponse, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { PORTAL_INVITE_ACTION, revokePortalContact, staffReply } from "@/lib/portal/staff";

/**
 * BOUNDARY: POST {reason}: revoke one portal contact (ends their sessions, burns their codes). Admin of this company only, same origin,
 * through the admin's own client. Never logs the reason. Must not call anything but lib/portal/staff.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const { id } = await params;
  return staffReply(await revokePortalContact(auth.supabase, id, json.data), PORTAL_INVITE_ACTION);
}
