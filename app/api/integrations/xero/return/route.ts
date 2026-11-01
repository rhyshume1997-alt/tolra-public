import { NextResponse } from "next/server";

import { classifyProviderError, finishAppTest, ownerStillValid } from "@/lib/integrations/app-test";
import { notConfiguredResponse } from "@/lib/integrations/not-configured";
import { xeroReady } from "@/lib/integrations/server";
import { MAX_SIGNED_STATE_LENGTH, consumeStateOnce, isSignedState, verifyState } from "@/lib/integrations/signed-state";
import { createSupabaseServerClient } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Where /api/integrations/xero/callback (a redirect URI registered at Xero) passes every return that carries a SIGNED state, query
 * unchanged: the platform owner's own test sign-in (Platform > App connections, state kind `app_test`: signed with the server's key,
 * expiring in 10 minutes, used up on first arrival). The code is exchanged, the connections list read, and nothing at all is stored: the
 * tokens are dropped. Anything else gets nothing used up and nothing done. While Xero isn't set up the answer is a clean 503.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const back = (outcome: string) => NextResponse.redirect(new URL(`/admin/integrations?xero=${encodeURIComponent(outcome)}`, request.url), 303);
  const platform = (outcome: string) => NextResponse.redirect(new URL(`/platform?app_test=xero&result=${encodeURIComponent(outcome)}`, request.url), 303);

  if (!isSignedState(state) || state.length > MAX_SIGNED_STATE_LENGTH) return back("invalid");
  const ready = await xeroReady();
  const service = createSupabaseAdminClient();
  if (!ready || !service) return notConfiguredResponse("xero");

  const test = verifyState(state, ready.key, { kind: "app_test" });
  if (!test.ok) return test.reason === "expired" ? platform("expired") : back("invalid");
  if (test.payload.p !== "xero") return back("invalid");
  if (!(await consumeStateOnce(service, test.payload))) return platform("expired");
  if (!(await ownerStillValid(await createSupabaseServerClient(), test.payload.u))) return platform("failed");
  const error = url.searchParams.get("error");
  if (error) return platform(classifyProviderError(error, url.searchParams.get("error_description")));
  const code = url.searchParams.get("code");
  if (!code || code.length > 2000) return platform("failed");
  return platform(await finishAppTest(test.payload, ready, code));
}
