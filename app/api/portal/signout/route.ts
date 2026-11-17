import { NextResponse, type NextRequest } from "next/server";

import { clearPortalSessionCookie, portalCookieName } from "@/lib/portal/cookie";
import { portalEnabled } from "@/lib/portal/flag";
import { checkPortalIpLimit } from "@/lib/portal/limits";
import { endPortalSession } from "@/lib/portal/server";
import { sameOrigin } from "@/lib/server/auth";

/**
 * BOUNDARY: POST /api/portal/signout (public; listed in PUBLIC_ROUTES). Input: the portal cookie. Output: ends that session in the
 * database (best effort), clears the cookie and 303s to /portal/signin, Cache-Control: no-store. Flag off, cross-origin or limited: the
 * same 303 without ending anything. Order: flag, same origin, per-IP limit. Nothing is logged. Must not reveal whether a session existed.
 */
export const dynamic = "force-dynamic";

const back = () => new NextResponse(null, { status: 303, headers: { Location: "/portal/signin", "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  if (!portalEnabled()) return back();
  if (!sameOrigin(request)) return back();
  if ((await checkPortalIpLimit("read", request)) !== "ok") return back();
  await endPortalSession(request.cookies.get(portalCookieName())?.value);
  const response = back();
  response.cookies.set(clearPortalSessionCookie());
  return response;
}
