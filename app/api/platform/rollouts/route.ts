import { NextResponse } from "next/server";

import { recentSecondStep } from "@/lib/mfa-policy";
import { checkRolloutInput, parseRolloutOverview, parseRolloutResult, rolloutRefusal } from "@/lib/platform/rollouts";
import { isErrorResponse, jsonError, mfaRecentRequired, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

// The platform owner's Rollouts (module G): turn ONE existing per-company switch on or off for one company, a chosen few or all, with a log.
// GET: every company with the listed switches it has on now, and the last 200 log rows (release 167's platform_rollout_overview, the owner's own
// session). POST { switchMarker, organizationIds, on, phase }: ONE call to platform_rollout_apply, which changes only that marker in each company's
// hidden_nav and writes one log row (who, when, which switch, which companies, on or off) in one transaction. Only the six listed markers are accepted;
// turning ON needs an authenticator code under 15 minutes old, turning OFF needs only the signed-in second step (so switching off is always one click).
// The apply function is service-role only (the company's own guard on hidden_nav lets only that company's admin change it for a signed-in caller), so
// this is the one place the service role is used, after flag -> same origin -> signed in -> is_platform_admin() -> aal2 have all passed, and the actor
// named is the verified user. Off (404) unless PLATFORM_ROLLOUTS_ENABLED is exactly "true". Nothing is on by default; no company data other than
// that one marker is touched; no AI, no e-mail. Database messages are never returned.

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (process.env.PLATFORM_ROLLOUTS_ENABLED !== "true") return jsonError("Not found", 404); // same rule as rolloutsEnabled() in lib/platform/owner-flags.ts, inline because a guard must come first
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const { data, error } = await ctx.supabase.rpc("platform_rollout_overview");
  if (error) {
    console.error("[platform] rollout overview refused", error.code ?? "no-code", error.hint ?? "");
    return jsonError(error.code === "42501" ? "Forbidden" : "Couldn't load the rollouts. Try again.", error.code === "42501" ? 403 : 500);
  }
  const overview = parseRolloutOverview(data);
  if (!overview) return jsonError("Couldn't load the rollouts. Try again.", 500);
  return NextResponse.json(overview, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (process.env.PLATFORM_ROLLOUTS_ENABLED !== "true") return jsonError("Not found", 404); // same rule as rolloutsEnabled() in lib/platform/owner-flags.ts, inline because a guard must come first
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const { supabase, user, admin } = ctx;

  const json = await readJson(request, 16 * 1024);
  if (!json.ok) return json.response;
  const checked = checkRolloutInput(json.data);
  if (!checked.ok) return jsonError(checked.error, 400);
  const { switchMarker, organizationIds, on, phase } = checked.value;

  if (on) {
    const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError || !recentSecondStep(assurance?.currentAuthenticationMethods)) return mfaRecentRequired("turn a feature on for companies");
  }

  const { data, error } = await admin.rpc("platform_rollout_apply", {
    p_actor: user.id, p_actor_email: user.email ?? user.id, p_switch: switchMarker, p_orgs: organizationIds, p_on: on, p_phase: phase,
  });
  if (error) {
    console.error("[platform] rollout refused", error.code ?? "no-code", error.hint ?? "");
    const refusal = rolloutRefusal(error);
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
  const result = parseRolloutResult(data);
  if (!result) return jsonError("Couldn't confirm the change. Check the rollout log before trying again.", 500);
  console.info(JSON.stringify({ event: "platform.rollout_applied", actor: user.id, switch: result.switchMarker, turned_on: result.turnedOn, requested: result.requested, changed: result.changed, at: new Date().toISOString() }));
  return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
}
