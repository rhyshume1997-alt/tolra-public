import { NextResponse, type NextRequest } from "next/server";

import { checkPortalIpLimit } from "@/lib/portal/limits";
import { portalEnabled } from "@/lib/portal/flag";
import { requestPortalSignin } from "@/lib/portal/server";
import { sameOrigin } from "@/lib/server/auth";

/**
 * BOUNDARY: POST /api/portal/signin/request (public; listed in PUBLIC_ROUTES). Input: a form post with `email`. Output: ALWAYS a 303 to
 * /portal/signin/sent, with Cache-Control: no-store, whatever happened (flag off, cross-origin, limited, unknown e-mail, error), so the
 * response never says whether an e-mail is a contact. Order: flag, same origin, per-IP limit, then lib/portal. Nothing is logged here.
 * Must not branch the response on any outcome, echo the e-mail, or set a cookie.
 */
export const dynamic = "force-dynamic";

const sent = () => new NextResponse(null, { status: 303, headers: { Location: "/portal/signin/sent", "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  if (!portalEnabled()) return sent();
  if (!sameOrigin(request)) return sent();
  if ((await checkPortalIpLimit("request", request)) !== "ok") return sent();
  let email: unknown = "";
  try {
    email = (await request.formData()).get("email");
  } catch {
    email = "";
  }
  try {
    await requestPortalSignin(email);
  } catch {
    // Same answer whatever happened.
  }
  return sent();
}
