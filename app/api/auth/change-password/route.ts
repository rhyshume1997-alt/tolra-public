import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { isUnreachableError } from "@/lib/auth-errors";
import { adminMfaRequired, holdsAdmin, recentSecondStep } from "@/lib/mfa-policy";
import { forbiddenOrigin, jsonError, mfaRecentRequired, mfaRequired, readJson, sameOrigin } from "@/lib/server/auth";
import { passwordProblem, PASSWORD_MAX } from "@/lib/password";
import { changedAfterTemporary, markers, persist, recentLinkSignIn, setMustChange } from "@/lib/server/password-setup";
import { isBreachedPassword } from "@/lib/server/breached-password";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { withGatewayRetry } from "@/lib/server/resilient-fetch";

// The signed-in person chooses their own password ("Choose your password" page: invite / reset links, and the
// forced change after an admin set a password). Changing it here is the only way the "must change password"
// requirement is cleared, so it can't be skipped by calling an endpoint without actually changing the password.
//
// Success is only reported once the requirement is durably cleared. If the password changed but the bookkeeping
// failed, the answer says so (partial: true) and { finish: true } completes it later without a second password
// change; that is only allowed once the login's own markers prove the temporary password was replaced.
//
// Who may change it (audit Z7/C9): the current password is checked, unless an admin set a temporary one (must change password) or
// a reset or invite link signed this session in within the hour; and an admin needs the second step (aal2), entered within the last 15
// minutes, when REQUIRE_ADMIN_MFA is on, except while choosing their own password in place of a
// temporary one (the middleware sends them here before /mfa).

const schema = z.union([
  z.object({ password: z.string().max(PASSWORD_MAX), current_password: z.string().max(256).optional() }),
  z.object({ finish: z.literal(true) }),
]);

const PARTIAL = "Your new password is saved, but setting up your account didn't finish. Press \"Finish set-up\" to try again.";

function partial() {
  return NextResponse.json({ error: PARTIAL, partial: true }, { status: 500 });
}

/**
 * Checks a password with a sign-in that is never stored (a separate client, as /api/auth/signin checks one); the extra session it
 * makes is ended at once. Null when the auth service could not be asked (that says nothing about the password).
 */
async function passwordMatches(url: string, anonKey: string, email: string | undefined, password: string): Promise<boolean | null> {
  if (!email || !password) return false;
  const check = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await check.auth.signInWithPassword({ email, password });
  if (error || !data.session) return isUnreachableError(error) ? null : false;
  await check.auth.signOut({ scope: "local" }).catch(() => undefined);
  return true;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return jsonError("Service unavailable", 503);
  // Checked before anything changes: without it the requirement could never be cleared.
  const admin = createSupabaseAdminClient();
  if (!admin) return jsonError("Password changes are unavailable right now. Try again later.", 503);

  const json = await readJson(request, 2048);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);

  const cookieStore = await cookies();
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    global: { fetch: withGatewayRetry() },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) =>
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, { ...options, secure: process.env.NODE_ENV === "production" }),
        ),
    },
  });
  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user;
  if (!user) return jsonError("Your session has expired. Sign in again.", 401);

  // Repair after a partial result, also reached when the person re-submits the password they already saved.
  const finish = async () => ((await setMustChange(admin, user.id, false)) ? NextResponse.json({ ok: true }) : partial());

  if ("finish" in parsed.data) {
    if (!changedAfterTemporary(markers(user.app_metadata))) return jsonError("Choose your new password below.", 409);
    return finish();
  }

  const { password, current_password } = parsed.data;
  const problem = passwordProblem(password);
  if (problem) return jsonError(problem, 400);

  // Who is asking. Unreadable state counts against the caller: the current password is asked for, and an admin needs aal2.
  const { data: profile, error: profileError } = await admin.from("user_profiles").select("must_change_password").eq("id", user.id).maybeSingle();
  const mustChange = !profileError && profile?.must_change_password === true;
  const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  // An admin needs the second step, and a recent one, to change a password, whenever it is required for admins (REQUIRE_ADMIN_MFA). While
  // the switch is off nobody is asked for a code at sign-in, so there is no way to give one and nothing is asked here either.
  if (adminMfaRequired() && !mustChange) {
    const { data: memberships, error: membershipError } = await admin.from("organization_members").select("role, secondary_role").eq("user_id", user.id).eq("active", true);
    if (membershipError || (memberships ?? []).some((membership) => holdsAdmin(membership))) {
      if (assurance?.currentLevel !== "aal2") return mfaRequired();
      if (!recentSecondStep(assurance?.currentAuthenticationMethods)) return mfaRecentRequired();
    }
  }
  if (!mustChange && !recentLinkSignIn(assurance?.currentAuthenticationMethods)) {
    if (!current_password) return jsonError("Enter your current password.", 400);
    const matches = await passwordMatches(supabaseUrl, supabaseAnonKey, user.email, current_password);
    if (matches === null) return jsonError("Couldn't check your current password. Try again shortly.", 503);
    if (!matches) return jsonError("Your current password is wrong.", 400);
  }
  // Server side and private (k-anonymity range lookup); never blocks when the service is unavailable.
  if (await isBreachedPassword(password)) return jsonError("That password has appeared in a known data breach, so it isn't safe to use. Choose a different one.", 400);

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (error.code === "same_password") {
      return changedAfterTemporary(markers(user.app_metadata))
        ? finish()
        : jsonError("Choose a new password, different from the one you were given.", 400);
    }
    if (error.code === "weak_password" || error.status === 422) return jsonError(error.message || "That password isn't allowed. Choose another.", 400);
    console.error("[auth/change-password] update failed", error.status, error.code);
    return jsonError("Couldn't save your password. Try again.", 500);
  }

  const marked = await persist(() => admin.auth.admin.updateUserById(user.id, { app_metadata: { password_changed_at: new Date().toISOString() } }));
  if (!marked) console.error("[auth/change-password] marker write failed");
  const cleared = await setMustChange(admin, user.id, false);

  await supabase.rpc("write_audit", {
    p_action: "CHANGE_OWN_PASSWORD",
    p_entity_table: "user_profiles",
    p_entity_id: user.id,
    p_old: null,
    p_new: null,
    p_metadata: { completed: cleared },
    p_ip: request.headers.get("x-real-ip") ?? null,
    p_user_agent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
  }).then(() => undefined, () => undefined);

  if (!cleared) {
    console.error("[auth/change-password] flag clear failed");
    // Without the marker a retry can't be proven safe; choosing another new password still works.
    return marked ? partial() : jsonError("Your password changed, but setting up your account didn't finish. Choose another new password to try again.", 500);
  }
  return NextResponse.json({ ok: true });
}
