import { NextResponse, type NextRequest } from "next/server";

import { portalSessionCookie } from "@/lib/portal/cookie";
import { cleanPortalRef } from "@/lib/portal/crypto";
import { portalEnabled } from "@/lib/portal/flag";
import { checkPortalIpLimit } from "@/lib/portal/limits";
import { logPortalRefusal, portalRefusal } from "@/lib/portal/refusal";
import { verifyPortalSignin } from "@/lib/portal/server";
import { sameOrigin } from "@/lib/server/auth";

/**
 * BOUNDARY: POST /api/portal/signin/verify (public; listed in PUBLIC_ROUTES). Input: a form post with `ref` and `code`. Output: success sets
 * the portal cookie and 303s to /portal; EVERY refusal (flag off, cross-origin, limited, bad ref or code, expired, switched off, error)
 * is the same 303 to /portal/code/<ref>?c=<correlationId>, so no reason can be told apart. Order: flag, same origin, per-IP limit, then
 * lib/portal. Cache-Control: no-store. Logs only correlation ids. Must not branch the refusal on its cause or put anything else in it.
 */
export const dynamic = "force-dynamic";

const go = (location: string) => new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  // The form is read lazily, after the flag check, so that every refusal (even an early one) can carry the same <ref> in its address.
  let form: Promise<FormData | null> | null = null;
  const read = () => (form ??= request.formData().catch(() => null));
  const refuse = async (correlationId?: string) => {
    const r = portalRefusal(correlationId);
    logPortalRefusal(r.correlationId);
    const ref = cleanPortalRef((await read())?.get("ref"));
    return go(`/portal/code/${ref ?? "x"}?c=${encodeURIComponent(r.correlationId)}`);
  };

  if (!portalEnabled()) return refuse();
  if (!sameOrigin(request)) return refuse();
  if ((await checkPortalIpLimit("verify", request)) !== "ok") return refuse();
  const data = await read();
  const result = await verifyPortalSignin({ ref: data?.get("ref"), code: data?.get("code") });
  if (!result.ok) return refuse(result.correlationId);
  const response = go("/portal");
  response.cookies.set(portalSessionCookie(result.data.token));
  return response;
}
