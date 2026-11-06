import { NextResponse } from "next/server";

import { connectOutcomeMessage } from "@/lib/integrations/overview";
import { DbError, finishPick, xeroReady } from "@/lib/integrations/server";
import { PICKER_COOKIE, PICKER_PATH, type PickerPayload, csrfMatches, openPicker, pickerCsrf, readCookie, toOffer } from "@/lib/integrations/xero/picker";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { requireRecentAal2 } from "@/lib/server/admin-users";
import { type AuthContext, forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { LimiterUnavailableError, withinLimit } from "@/lib/server/login";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const clear = (res: NextResponse) => {
  res.cookies.set(PICKER_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: PICKER_PATH, maxAge: 0 });
  return res;
};

/** The offer in this browser's cookie, only if it is this admin's, for this company, and not expired: null otherwise. */
function ownOffer(request: Request, auth: AuthContext, key: Buffer): PickerPayload | null {
  const opened = openPicker(readCookie(request.headers.get("cookie"), PICKER_COOKIE), key);
  if (!opened.ok) return null;
  const p = opened.payload;
  return p.o === auth.profile.organization_id && p.u === auth.user.id ? p : null;
}

/**
 * The Xero organisation picker (several organisations were ticked in one consent). GET: the organisations THIS consent made, by name, and
 * the anti-forgery value for the POST; no token, tenant secret or state. POST: the admin's explicit choice (tenantId, csrf). The offer is
 * the sealed cookie the callback set (lib/integrations/xero/picker.ts): bound to this company and this admin, 10 minutes, single use. The
 * server re-reads Xero's connections and accepts only an organisation that was offered; connecting leaves transfers off (release 149).
 */
export async function GET(request: Request) {
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const ready = await xeroReady();
  if (!ready) return jsonError("Xero is not set up on this server yet.", 503);
  const offer = ownOffer(request, auth, ready.key);
  if (!offer) return jsonError("There is nothing to choose: click Connect to Xero again.", 410, { headers });
  return NextResponse.json({ organisations: offer.t.map((x) => ({ tenantId: x.t, name: x.n })), csrf: pickerCsrf(offer, ready.key), expiresAt: offer.e * 1000 }, { headers });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const recent = await requireRecentAal2(auth, "connect Xero", true);
  if (recent) return recent;
  const ready = await xeroReady();
  const service = createSupabaseAdminClient();
  if (!ready || !service) return jsonError("Xero is not set up on this server yet.", 503);
  const body = await readJson(request, 4 * 1024);
  if (!body.ok) return body.response;
  const { tenantId, csrf } = (body.data ?? {}) as { tenantId?: unknown; csrf?: unknown };
  const offer = ownOffer(request, auth, ready.key);
  if (!offer) return clear(jsonError("This choice expired or was not started here: click Connect to Xero again.", 410, { headers }));
  if (!csrfMatches(csrf, offer, ready.key)) return jsonError("Forbidden", 403, { headers });
  // Explicit selection only: no default, no guess. A tenant the offer did not name is refused before anything is used up.
  if (typeof tenantId !== "string" || !offer.t.some((x) => x.t === tenantId)) return jsonError("Choose one of the organisations listed.", 400, { headers });
  // Single use (the existing limiter, keyed on the offer's nonce): the first call passes, a replay or an unavailable limiter is refused.
  try {
    if (!(await withinLimit(service, "xero_picker_use", offer.n, 3600, 1))) return clear(jsonError("This choice was already used: click Connect to Xero again.", 410, { headers }));
  } catch (err) {
    if (err instanceof LimiterUnavailableError) return jsonError("Try again shortly.", 503, { headers });
    throw err;
  }
  try {
    const outcome = await finishPick(service, auth.profile.organization_id, auth.user.id, toOffer(offer), tenantId, ready);
    if (outcome.ok) {
      const { error } = await auth.supabase.rpc("write_audit", {
        p_action: "ORGANIZATION_SETTINGS_UPDATE", p_entity_table: "organization_settings", p_entity_id: auth.profile.organization_id, p_old: null, p_new: null,
        p_metadata: { integration: "xero", purpose: "organisation_picker", chosen: outcome.tenantName, offered: offer.t.length },
        p_ip: null, p_user_agent: null,
      });
      if (error) console.error("[integrations] picker audit failed", error.code);
    }
    if (outcome.ok) return clear(NextResponse.json({ ok: true, outcome: "connected" }, { headers }));
    return clear(NextResponse.json({ ok: false, outcome: outcome.reason, error: connectOutcomeMessage(outcome.reason) }, { status: 409, headers }));
  } catch (err) {
    console.error("[integrations] picker failed:", err instanceof DbError ? err.hint ?? err.code : err instanceof Error ? err.name : "error");
    return clear(NextResponse.json({ ok: false, outcome: "failed" }, { status: 500, headers }));
  }
}
