import { NextResponse } from "next/server";
import { z } from "zod";

import { audit, guard, loginIsProtected, type AdminContext } from "@/lib/server/admin-users";
import { PROTECTED_CHECK_FAILED, PROTECTED_LOGIN } from "@/lib/company-access";
import { jsonError, readJson } from "@/lib/server/auth";
import { passwordProblem, PASSWORD_MAX } from "@/lib/password";
import { PRODUCT } from "@/lib/product";
import { setMustChange } from "@/lib/server/password-setup";

// An admin sets a new password for a member of their current organisation (no e-mail involved).
// Refused for yourself (use "Change password") and for a login that also belongs to another organisation: that
// password isn't this organisation's to change (they can use "Forgot password" instead). Never for a platform owner's login or one
// with any support membership, active or not (093: loginIsProtected), and always at aal2, whatever REQUIRE_ADMIN_MFA says.
// The password goes straight to Supabase Auth; it is never logged, stored or written to the audit trail.

const schema = z.object({
  user_id: z.string().uuid(),
  password: z.string().max(PASSWORD_MAX),
  must_change_password: z.boolean().default(true),
});

/** How long to wait for Auth before treating the result as unknown. */
const AUTH_TIMEOUT_MS = 15_000;

type AuthOutcome =
  | { kind: "done" }
  | { kind: "rejected"; error: { status?: number; code?: string; message?: string } }
  | { kind: "uncertain"; reason: string };

/**
 * Sets the password in Auth and says what is known afterwards (audit R1). Only a 4xx answer (other than 408) proves
 * the password was not changed; a timeout, a network failure, a 5xx or no status at all leaves it unknown.
 */
async function setAuthPassword(admin: AdminContext["admin"], userId: string, password: string, mustChange: boolean): Promise<AuthOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), AUTH_TIMEOUT_MS); });
  try {
    const result = await Promise.race([
      admin.auth.admin.updateUserById(userId, {
        password,
        ...(mustChange ? { app_metadata: { temp_password_set_at: new Date().toISOString() } } : {}),
      }),
      timeout,
    ]);
    if (result === "timeout") return { kind: "uncertain", reason: "timeout" };
    const { error } = result;
    if (!error) return { kind: "done" };
    const status = typeof error.status === "number" ? error.status : undefined;
    if (status !== undefined && status >= 400 && status < 500 && status !== 408) return { kind: "rejected", error: { status, code: error.code, message: error.message } };
    return { kind: "uncertain", reason: `status ${status ?? "none"} ${error.code ?? ""}`.trim() };
  } catch (thrown) {
    return { kind: "uncertain", reason: thrown instanceof Error ? thrown.name : "thrown" };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request) {
  const ctx = await guard(request, { aal2: true });
  if (ctx instanceof NextResponse) return ctx;
  const { auth, admin } = ctx;
  const orgId = auth.profile.organization_id;

  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { user_id, password, must_change_password } = parsed.data;

  if (user_id === auth.user.id) return jsonError("Change your own password from the menu (Change password).", 409);
  const problem = passwordProblem(password);
  if (problem) return jsonError(problem, 400);

  const { data: memberships, error: memberError } = await admin
    .from("organization_members")
    .select("organization_id, support")
    .eq("user_id", user_id);
  if (memberError) return jsonError("Could not set the password", 500);
  if (!memberships?.some((row) => row.organization_id === orgId)) return jsonError("User not found", 404);
  // A support membership (here or anywhere, window open or over) never makes the login this company's (093).
  if (memberships.some((row) => row.support === true)) return jsonError(PROTECTED_LOGIN, 403);
  if (memberships.some((row) => row.organization_id !== orgId)) {
    return jsonError(`This person also uses ${PRODUCT.name} with another company, so only they can change their password (Forgot password on the sign-in page).`, 409);
  }
  const protectedLogin = await loginIsProtected(ctx, user_id);
  if (protectedLogin === null) return jsonError(PROTECTED_CHECK_FAILED, 500);
  if (protectedLogin) return jsonError(PROTECTED_LOGIN, 403);

  // The requirement is stored and verified before the password changes (audit R1): if it can't be saved, the old
  // password stays in place and nothing is reported as done (fail closed).
  const { data: before } = await admin.from("user_profiles").select("must_change_password").eq("id", user_id).maybeSingle();
  if (!(await setMustChange(admin, user_id, must_change_password))) {
    console.error("[admin/users/password] flag update failed; password left unchanged (nothing changed, so nothing audited)");
    return jsonError(must_change_password
      ? "Couldn't save \"must change password\", so the password was not changed. Try again."
      : "Couldn't remove the change-password requirement, so the password was not changed. Try again.", 500);
  }

  // The marker is written in the same Auth call as the password, so it can never describe a different password.
  const outcome = await setAuthPassword(admin, user_id, password, must_change_password);
  if (outcome.kind === "rejected") {
    // Auth refused the request (4xx), so the password didn't change: put the requirement back as it was.
    if (before && typeof before.must_change_password === "boolean" && before.must_change_password !== must_change_password) {
      if (!(await setMustChange(admin, user_id, before.must_change_password))) console.error("[admin/users/password] flag restore failed");
    }
    const { error } = outcome;
    if (error.code === "weak_password" || error.status === 422) return jsonError(error.message || "That password isn't allowed. Choose another.", 400);
    console.error("[admin/users/password] update refused", error.status, error.code);
    return jsonError("Could not set the password", 500);
  }
  if (outcome.kind === "uncertain") {
    // A timeout, network failure or server error: the password may or may not have changed. The requirement is
    // never put back to "off" here; it stays on (or goes back on, if it was on before), so a password nobody
    // confirmed can't be used without choosing a new one. Setting the password again is safe and finishes the job.
    if (!must_change_password && before?.must_change_password === true && !(await setMustChange(admin, user_id, true))) {
      console.error("[admin/users/password] flag restore failed after an uncertain Auth result");
    }
    console.error("[admin/users/password] Auth result uncertain", outcome.reason);
    const protectedNow = must_change_password || before?.must_change_password === true;
    return NextResponse.json({
      error: `We couldn't confirm whether the password changed${protectedNow ? ", so they'll still have to choose a new password when they sign in" : ""}. Press Set password again to finish.`,
      code: "password_result_uncertain",
    }, { status: 503 });
  }

  await audit(ctx, "SET_USER_PASSWORD", user_id, { must_change_password }, request);
  return NextResponse.json({ ok: true });
}
