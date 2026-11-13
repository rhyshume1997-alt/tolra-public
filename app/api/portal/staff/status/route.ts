import { forbiddenOrigin, isErrorResponse, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { PORTAL_SWITCH_ACTION, getPortalStatus, setPortalEnabled, staffReply } from "@/lib/portal/staff";

/**
 * BOUNDARY: the company's customer-portal switch. GET: status. POST {enabled, reason}: switch on (fresh authenticator code) or off.
 * Admin of this company only, same origin, through the admin's own client (never the service role). Logs nothing about the reason.
 * Must not add other fields or call anything but lib/portal/staff.ts.
 */
export async function GET() {
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  return staffReply(await getPortalStatus(auth.supabase), PORTAL_SWITCH_ACTION);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  return staffReply(await setPortalEnabled(auth.supabase, json.data), PORTAL_SWITCH_ACTION);
}
