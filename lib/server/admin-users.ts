import "server-only";
import { NextResponse } from "next/server";

import { PROTECTED_CHECK_FAILED, PROTECTED_LOGIN } from "@/lib/company-access";
import { forbiddenOrigin, isErrorResponse, jsonError, mfaRequired, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

// Shared by the Admin > Users routes: the caller must be an active admin of their current organisation.

export type AdminContext = { auth: Exclude<Awaited<ReturnType<typeof requireProfile>>, NextResponse>; admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>> };

/**
 * `aal2`: the route hands over a login (setting someone's password, resetting their two-step sign-in), so the caller's session must
 * have passed the second step ALWAYS, whatever REQUIRE_ADMIN_MFA and the company's require_admin_mfa say (audit item 4); refused with
 * the usual mfa_required answer. Every other route keeps requireProfile's rule.
 */
export async function guard(request: Request, options: { aal2?: boolean } = {}): Promise<AdminContext | NextResponse> {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  // Support access (the platform owner inside a company) never manages who has access: no new users or admins, no role changes,
  // no password or two-step resets. The database refuses set_member_access for it too; the service-role paths are stopped here.
  if (auth.session?.support) return jsonError("Support access can't manage users", 403);
  if (options.aal2) {
    const { data: assurance, error: assuranceError } = await auth.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError || assurance?.currentLevel !== "aal2") return mfaRequired();
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return jsonError("User management not configured", 503);
  return { auth, admin };
}

export async function audit(ctx: Pick<AdminContext, "auth">, action: string, entityId: string, newData: Record<string, unknown>, request: Request, oldData: Record<string, unknown> | null = null) {
  const { error } = await ctx.auth.supabase.rpc("write_audit", {
    p_action: action,
    p_entity_table: "user_profiles",
    p_entity_id: entityId,
    p_old: oldData,
    p_new: newData,
    p_metadata: {},
    p_ip: request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null,
    p_user_agent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
  });
  if (error) console.error("[admin/users] audit failed", error.code);
}


/**
 * True when every membership of `userId` is in `orgId`: the login belongs to this company alone, so its global
 * identity (username, sign-in ban) is this company's to manage (audit SEC2). A login shared with another company
 * keeps its identity under its owner's control: they can change it themselves, or the platform owner can.
 * A support membership (the platform owner's, 036; active or switched off, window open or over) never makes a login this
 * company's (093): a leftover support row must not let a company reset the platform owner's identity.
 */
export async function ownsIdentity(admin: AdminContext["admin"], userId: string, orgId: string): Promise<boolean> {
  const { data, error } = await admin.from("organization_members").select("organization_id, support").eq("user_id", userId);
  if (error || !data?.length) return false;
  return data.every((row) => row.organization_id === orgId && row.support !== true);
}

/**
 * True for a login no company admin may act on (093): a platform owner's, or one with any support membership (active or not). The
 * support rows are read with the service role; the platform owner list only the database can answer, asked with the CALLER's token
 * (admin_login_is_protected: TRUE for anyone who isn't one of the caller's people, so nothing is revealed). Null when it can't be
 * answered, including before 093 is applied (the function is missing): the caller then refuses with PROTECTED_CHECK_FAILED (fail
 * closed; 093 is applied before the app that calls it).
 */
export async function loginIsProtected(ctx: AdminContext, userId: string): Promise<boolean | null> {
  const support = await ctx.admin.from("organization_members").select("organization_id").eq("user_id", userId).eq("support", true);
  if (support.error) return null;
  if ((support.data ?? []).length > 0) return true;
  const { data, error } = await ctx.auth.supabase.rpc("admin_login_is_protected", { p_user: userId });
  if (error) {
    console.error("[admin/users] protected-login check failed", error.code ?? "no-code");
    return null;
  }
  return data !== false;
}

/**
 * For adding an EXISTING login (lib/company-access.ts mayAddExistingLogin): every company where the login has a membership (active or
 * not, support included), whether any of them is a support membership (093), and the companies where the caller is an active,
 * non-support admin (role or second role). Null when either can't be read (the caller then refuses).
 */
export async function existingLoginScope(admin: AdminContext["admin"], callerId: string, userId: string): Promise<{ loginCompanies: string[]; loginSupport: boolean; callerAdminCompanies: string[] } | null> {
  const login = await admin.from("organization_members").select("organization_id, support").eq("user_id", userId);
  if (login.error || !login.data) return null;
  const caller = await admin.from("organization_members").select("organization_id, role, secondary_role, active, support").eq("user_id", callerId);
  if (caller.error || !caller.data) return null;
  return {
    loginCompanies: login.data.map((row) => String(row.organization_id)),
    loginSupport: login.data.some((row) => row.support === true),
    callerAdminCompanies: caller.data
      .filter((row) => row.active === true && row.support !== true && (row.role === "admin" || row.secondary_role === "admin"))
      .map((row) => String(row.organization_id)),
  };
}

export type MfaResetResult = { ok: true; removed: number } | { ok: false; status: number; error: string };

/**
 * Another admin resets a person's two-step sign-in (lost phone): their authenticator factors are removed, so at their next
 * sign-in they set up a new one. Only for a login that belongs to this company alone (like username and sign-in ban), never
 * for oneself (an admin who has lost their own app uses another admin, or the dashboard path in docs/MFA.md), never for a support
 * membership or a login with one anywhere (093: ownsIdentity), and the caller has already passed the guard (an admin who has passed
 * the second step themselves, always: guard(..., { aal2: true })). `isProtected` (the route passes loginIsProtected) is asked once
 * the login is known to be this company's alone: a platform owner's login is refused too.
 */
export async function resetMfa(admin: AdminContext["admin"], orgId: string, callerId: string, targetId: string, isProtected?: () => Promise<boolean | null>): Promise<MfaResetResult> {
  if (targetId === callerId) return { ok: false, status: 400, error: "Ask another admin to reset your two-step sign-in." };
  const { data: member } = await admin.from("organization_members").select("user_id, support").eq("user_id", targetId).eq("organization_id", orgId).eq("active", true).maybeSingle();
  if (!member) return { ok: false, status: 404, error: "User not found" };
  if ((member as { support?: boolean }).support === true) return { ok: false, status: 403, error: PROTECTED_LOGIN };
  if (!(await ownsIdentity(admin, targetId, orgId))) return { ok: false, status: 403, error: "This login is shared with another company, so its two-step sign-in can't be reset from here." };
  if (isProtected) {
    const protectedLogin = await isProtected();
    if (protectedLogin === null) return { ok: false, status: 500, error: PROTECTED_CHECK_FAILED };
    if (protectedLogin) return { ok: false, status: 403, error: PROTECTED_LOGIN };
  }
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId: targetId });
  if (error) return { ok: false, status: 500, error: "Couldn't reset two-step sign-in. Try again." };
  let removed = 0;
  for (const factor of data?.factors ?? []) {
    const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: targetId });
    if (deleteError) return { ok: false, status: 500, error: "Couldn't reset two-step sign-in. Try again." };
    removed += 1;
  }
  // An admin whose authenticator was removed sets up a new one at their next sign-in (migration 065), even while
  // REQUIRE_ADMIN_MFA is off. The database clears this for anyone who does not hold admin.
  await requireAdminEnrolment(admin, orgId, targetId);
  return { ok: true, removed };
}

/** True / false when the login has / has no verified authenticator-app factor; null when Auth could not be asked. */
export async function hasVerifiedTotp(admin: AdminContext["admin"], userId: string): Promise<boolean | null> {
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) return null;
  return (data?.factors ?? []).some((factor) => factor.factor_type === "totp" && factor.status === "verified");
}

/** The stored enrolment flag of a membership (migration 065); false when it can't be read (e.g. before 065 is applied). */
export async function enrolmentFlag(admin: AdminContext["admin"], orgId: string, userId: string): Promise<boolean> {
  const { data, error } = await admin.from("organization_members").select("mfa_enrolment_required").eq("user_id", userId).eq("organization_id", orgId).maybeSingle();
  return !error && (data as { mfa_enrolment_required?: boolean } | null)?.mfa_enrolment_required === true;
}

/**
 * Marks a membership "must set up an authenticator app at next sign-in" (organization_members.mfa_enrolment_required, migration
 * 065) with the service role. The database keeps it only on an active admin membership. Best effort: before 065 is applied the
 * column does not exist and nothing changes (the person is simply not sent to set-up); the result says whether it was saved.
 */
export async function requireAdminEnrolment(admin: AdminContext["admin"], orgId: string, userId: string): Promise<boolean> {
  const { error } = await admin.from("organization_members").update({ mfa_enrolment_required: true }).eq("user_id", userId).eq("organization_id", orgId);
  if (error) console.error("[admin/users] enrolment flag not saved", error.code ?? "no-code");
  return !error;
}

export type BanState = {
  banned: boolean;
  /** The app set this ban itself (app_metadata.deactivation_ban). */
  appBan: boolean;
  /** The company that set the app's ban (app_metadata.deactivation_ban_org); null for any other ban, and for a legacy marker with no company. */
  banOrg: string | null;
};

/**
 * The app's own sign-in ban is MARKED in the login's app_metadata (only the service role writes app_metadata; a user can't set or
 * clear it themselves): `deactivation_ban: true` (what supabase/verify/unmarked_bans.sql classifies as marked) plus
 * `deactivation_ban_org`, the company whose admin set it. Written only through these helpers.
 */
export function deactivationBanMarker(orgId: string | null) {
  return { deactivation_ban: true, deactivation_ban_org: orgId };
}

/** Current sign-in ban state of a login, whether the app itself set it, and which company did. */
export async function banState(admin: AdminContext["admin"], userId: string): Promise<BanState | null> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  const user = data.user as typeof data.user & { banned_until?: string | null };
  const banned = Boolean(user.banned_until && new Date(user.banned_until).getTime() > Date.now());
  const metadata = (user.app_metadata as Record<string, unknown> | undefined) ?? {};
  const appBan = metadata.deactivation_ban === true;
  const banOrg = appBan && typeof metadata.deactivation_ban_org === "string" ? metadata.deactivation_ban_org : null;
  return { banned, appBan, banOrg };
}

/**
 * The app's marked ban, and the company `orgId` may lift it: the marker names `orgId`, or it is a LEGACY marker (no company, set
 * before markers carried one: the old "no active membership left" deactivation) and every membership of the login is in `orgId`
 * (ownsIdentity), so no other company can have set it. A marker naming another company, a legacy marker on a login shared with
 * another company, and any unmarked ban (the platform owner's) are never this company's.
 */
export async function companyMayLift(admin: AdminContext["admin"], state: BanState, userId: string, orgId: string): Promise<boolean> {
  if (!state.appBan) return false;
  if (state.banOrg !== null) return state.banOrg === orgId;
  return ownsIdentity(admin, userId, orgId);
}

/**
 * Lifts the app's own marked sign-in ban, only for one of `orgIds` (the companies the caller has just reactivated the person in, or
 * the company enabling their sign-in) and only when companyMayLift says that company set it. Any other ban (another company's
 * marker, the platform owner's, or a legacy marker on a shared login) stays, and the caller reports the login as disabled.
 */
export async function liftDeactivationBan(admin: AdminContext["admin"], userId: string, orgIds: readonly string[]): Promise<{ lifted: boolean; stillBanned: boolean; error?: true }> {
  const state = await banState(admin, userId);
  if (!state) return { lifted: false, stillBanned: false, error: true };
  if (!state.banned) return { lifted: false, stillBanned: false };
  let mine = false;
  for (const orgId of orgIds) if (await companyMayLift(admin, state, userId, orgId)) { mine = true; break; }
  if (!mine) return { lifted: false, stillBanned: true };
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: "none", app_metadata: { deactivation_ban: null, deactivation_ban_org: null } });
  if (error) return { lifted: false, stillBanned: true, error: true };
  return { lifted: true, stillBanned: false };
}
