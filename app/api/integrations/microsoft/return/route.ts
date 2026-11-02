import { NextResponse } from "next/server";

import { classifyProviderError, finishAppTest, ownerStillValid } from "@/lib/integrations/app-test";
import { microsoftReady } from "@/lib/integrations/microsoft/client";
import { isConsentBlocked } from "@/lib/integrations/microsoft/consent";
import { notConfiguredResponse } from "@/lib/integrations/not-configured";
import { MAX_SIGNED_STATE_LENGTH, consumeStateOnce, isSignedState, verifyState } from "@/lib/integrations/signed-state";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { createSupabaseServerClient, isErrorResponse, requireProfile } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Where /api/integrations/microsoft/callback (the ONE redirect URI registered at Microsoft) passes every return that carries a SIGNED
 * state, query unchanged. Two kinds, both signed with the server's key, expiring, and used up on first arrival (signed-state.ts):
 *  - `admin_consent`: the company's Microsoft administrator approved (or refused) Tolra. Bound to the company; no Tolra session is
 *    needed (they are not a Tolra user). They land on the Integrations card, which says "Approved, now click Connect".
 *  - `app_test`: the platform owner's own test sign-in (Platform > App connections). Nothing is stored; the tokens are dropped.
 * Anything else (no state, a plain state, a bad signature, another kind) gets nothing used up and nothing done. No token, code or state is
 * logged or put in a redirect. While Microsoft 365 isn't set up (before go-live) the answer is a clean 503.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const returned = { code: url.searchParams.get("code"), error: url.searchParams.get("error"), description: url.searchParams.get("error_description"), adminConsent: url.searchParams.get("admin_consent") };
  const back = (outcome: string) => NextResponse.redirect(new URL(`/admin/integrations?microsoft=${encodeURIComponent(outcome)}`, request.url), 303);
  const platform = (outcome: string) => NextResponse.redirect(new URL(`/platform?app_test=microsoft&result=${encodeURIComponent(outcome)}`, request.url), 303);

  if (!isSignedState(state) || state.length > MAX_SIGNED_STATE_LENGTH) return back("invalid");
  const service = createSupabaseAdminClient();
  const ready = await microsoftReady(service);
  if (!ready || !service) return notConfiguredResponse("microsoft");

  const consent = verifyState(state, ready.key, { kind: "admin_consent" });
  if (consent.ok) {
    if (!(await consumeStateOnce(service, consent.payload))) return back("expired");
    // A person who IS signed in to a different company is not sent to a card that would say "Approved" for the wrong company.
    const auth = await requireProfile([...CONNECT_ROLES]);
    if (!isErrorResponse(auth) && auth.profile.organization_id !== consent.payload.o) return back("invalid");
    if (returned.error) return back(isConsentBlocked(returned.error, returned.description) ? "consent_blocked" : returned.error === "access_denied" ? "cancelled" : "refused");
    return back(/^true$/i.test(returned.adminConsent ?? "") ? "consent_approved" : "refused");
  }

  const test = verifyState(state, ready.key, { kind: "app_test" });
  if (test.ok && test.payload.p === "microsoft") {
    if (!(await consumeStateOnce(service, test.payload))) return platform("expired");
    if (!(await ownerStillValid(await createSupabaseServerClient(), test.payload.u))) return platform("failed");
    if (returned.error) return platform(classifyProviderError(returned.error, returned.description));
    if (!returned.code || returned.code.length > 4000) return platform("failed");
    return platform(await finishAppTest(test.payload, ready, returned.code));
  }
  // Wrong signature, an expired state, or a state of another kind: nothing is used up and nothing happens.
  if (!test.ok && test.reason === "expired") return platform("expired");
  return back(!consent.ok && consent.reason === "expired" ? "expired" : "invalid");
}
