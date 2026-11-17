import { forbiddenOrigin, isErrorResponse, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { PORTAL_INVITE_ACTION, invitePortalContact, listPortalContacts, staffReply } from "@/lib/portal/staff";

/**
 * BOUNDARY: portal contacts of one customer. GET ?customer=<uuid>: the list. POST {customerId, email, name, permissions, reason}: invite
 * (fresh authenticator code; the portal must be on). Admin of this company only, same origin, through the admin's own client.
 * Never logs the e-mail, name or reason. Must not call anything but lib/portal/staff.ts.
 */
export async function GET(request: Request) {
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  const customer = new URL(request.url).searchParams.get("customer");
  return staffReply(await listPortalContacts(auth.supabase, customer), PORTAL_INVITE_ACTION);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  const json = await readJson(request, 8 * 1024);
  if (!json.ok) return json.response;
  return staffReply(await invitePortalContact(auth.supabase, json.data), PORTAL_INVITE_ACTION, 201);
}
