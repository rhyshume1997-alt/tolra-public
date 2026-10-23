import { NextResponse } from "next/server";
import { z } from "zod";

import { type AdminContext, audit, banState, companyMayLift, deactivationBanMarker, guard, liftDeactivationBan, loginIsProtected, ownsIdentity } from "@/lib/server/admin-users";
import { PROTECTED_CHECK_FAILED, PROTECTED_LOGIN } from "@/lib/company-access";
import { jsonError, mfaRequired, readJson } from "@/lib/server/auth";
import { PRODUCT } from "@/lib/product";
import { protectedStates, signInStates } from "@/lib/server/sign-in-list";

// Admin > Users, offboarding a leaver (migration 066 keeps every login's last company, so Deactivate can't switch off someone whose
// only company this is). "Disable sign-in" stops them signing in to Tolra: the app's own MARKED sign-in ban
// (app_metadata.deactivation_ban, with deactivation_ban_org = this company) on their login; their membership stays as it is. "Enable
// sign-in" lifts only a marked ban this company may lift (companyMayLift: the marker names this company, or it is a legacy marker
// with no company on a login whose memberships are all here).
//
//   GET  -> { users: [...], protected: [{ user_id, state: "protected" | "check_unavailable" }] } (093: such logins are never in
//           `users`). users: [{ user_id, sign_in: "on" | "off" | "off_platform" | "unknown" }] for the active, ordinary members whose login
//           belongs to this company alone (the same terms as username, password and two-step resets: ownsIdentity). Anyone else
//           is not listed, and the page shows them the normal Deactivate.
//   POST { user_id, enabled } -> disables (false) or enables (true) sign-in for one of them.
//
// Refused: support access (the guard); an admin session that hasn't passed the second step (aal2, always, whatever REQUIRE_ADMIN_MFA
// says); oneself; a support membership; a member who isn't active here (use Reactivate); a login that also belongs to another company
// (only Tolra support can stop that login); the last active admin who can still sign in. A ban this company didn't set (the platform
// owner's, or another company's marker) is never touched: Disable leaves it as it is, Enable refuses to lift it. Both changes are
// audited (UPDATE_USER_ACCESS, sign_in enabled/disabled).
//
// Platform owners (security_audit.platform_admins; the table is revoked from service_role, 036) and logins with any support membership
// are refused before either Disable or Enable (093): loginIsProtected asks admin_login_is_protected with the caller's token, and
// refuses when it can't be answered (fail closed). Support memberships here are refused below too.

const BAN_FOREVER = "876000h";
const LAST_ADMIN = "At least one active admin must be able to sign in.";
const schema = z.object({ user_id: z.string().uuid(), enabled: z.boolean() });

export async function GET(request: Request) {
  const ctx = await guard(request);
  if (ctx instanceof NextResponse) return ctx;
  const { auth, admin } = ctx;
  const orgId = auth.profile.organization_id;

  const { data: members, error } = await admin.from("organization_members").select("user_id, active, support").eq("organization_id", orgId);
  if (error) return jsonError("Couldn't load sign-in status", 500);
  const rows = (members ?? []) as Array<{ user_id: string; active: boolean; support: boolean }>;
  // 093: a platform owner's or support login (or one that can't be checked) is listed under `protected`, never as switchable.
  const shielded = await protectedStates(ctx, rows, auth.user.id);
  const held = new Set(shielded.map((row) => row.user_id));
  const users = (await signInStates(admin, rows, auth.user.id, orgId)).filter((row) => !held.has(row.user_id));
  return NextResponse.json({ users, protected: shielded });
}

/**
 * True when someone other than `userId` is an active, ordinary admin (role or second role) of `orgId` who can still sign in: no Auth
 * ban at all, neither a marked one nor the platform owner's. Null when unreadable. The caller counts only while their own login isn't
 * banned: an admin whose sign-in was disabled can keep a session open for up to an hour and must not use it to disable the last one.
 */
async function adminWhoCanSignIn(admin: AdminContext["admin"], orgId: string, userId: string): Promise<boolean | null> {
  const { data, error } = await admin.from("organization_members").select("user_id, role, secondary_role").eq("organization_id", orgId).eq("active", true).eq("support", false);
  if (error) return null;
  const admins = ((data ?? []) as Array<{ user_id: string; role: string; secondary_role: string | null }>)
    .filter((row) => row.user_id !== userId && (row.role === "admin" || row.secondary_role === "admin"));
  let unreadable = false;
  for (const row of admins) {
    const state = await banState(admin, row.user_id);
    if (state && !state.banned) return true;
    if (!state) unreadable = true;
  }
  return unreadable ? null : false;
}

export async function POST(request: Request) {
  const ctx = await guard(request);
  if (ctx instanceof NextResponse) return ctx;
  const { auth, admin } = ctx;
  const orgId = auth.profile.organization_id;

  // Always the second step for this one, even while REQUIRE_ADMIN_MFA is off: it locks a person out of Tolra.
  const { data: assurance, error: assuranceError } = await auth.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError || assurance?.currentLevel !== "aal2") return mfaRequired();

  const json = await readJson(request, 2048);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { user_id, enabled } = parsed.data;

  if (user_id === auth.user.id) return jsonError("You can't change your own sign-in. Ask another admin.", 409);
  const { data: member, error: memberError } = await admin
    .from("organization_members")
    .select("role, secondary_role, active, support")
    .eq("user_id", user_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (memberError) return jsonError("Couldn't change sign-in. Try again.", 500);
  if (!member) return jsonError("User not found", 404);
  const m = member as { role: string; secondary_role: string | null; active: boolean; support: boolean };
  if (m.support) return jsonError(`${PRODUCT.name} support access can't be changed here.`, 403);
  if (!m.active) return jsonError("They're deactivated in this company. Use Reactivate first.", 409);
  // 093: never the platform owner's login, nor one with a support membership anywhere; nothing is read from Auth or written first.
  const protectedLogin = await loginIsProtected(ctx, user_id);
  if (protectedLogin === null) return jsonError(PROTECTED_CHECK_FAILED, 500);
  if (protectedLogin) return jsonError(PROTECTED_LOGIN, 403);
  if (!(await ownsIdentity(admin, user_id, orgId))) {
    return jsonError(`This person also uses ${PRODUCT.name} with another company, so their sign-in can't be disabled from here. Use Deactivate to remove this company, or ask ${PRODUCT.name} support.`, 409);
  }

  const before = await banState(admin, user_id);
  if (!before) return jsonError("Couldn't read their sign-in status. Try again.", 500);
  const ours = before.banned && (await companyMayLift(admin, before, user_id, orgId));

  if (!enabled) {
    // A ban this company didn't set (the platform owner's, or another company's marker) stays exactly as it is: never re-marked.
    if (before.banned && !ours) return jsonError(`Their sign-in is already disabled by ${PRODUCT.name} support. Nothing was changed.`, 409);
    if (before.banned) return NextResponse.json({ ok: true, changed: false, sign_in: "off" });
    const isAdmin = m.role === "admin" || m.secondary_role === "admin";
    if (isAdmin) {
      const other = await adminWhoCanSignIn(admin, orgId, user_id);
      if (other === null) return jsonError("Couldn't change sign-in. Try again.", 500);
      if (!other) return jsonError(LAST_ADMIN, 409);
    }
    const { error: banError } = await admin.auth.admin.updateUserById(user_id, { ban_duration: BAN_FOREVER, app_metadata: deactivationBanMarker(orgId) });
    // A call can fail and still have landed: only the read-back decides.
    const after = await banState(admin, user_id);
    if (banError) console.error("[admin/users/sign-in] ban failed", banError.status);
    if (!after || !after.banned || !after.appBan || after.banOrg !== orgId) {
      return jsonError(after ? "Couldn't disable their sign-in. Nothing was changed." : "Their sign-in may not have been disabled. Reload to check.", 500);
    }
    if (isAdmin) {
      // Two admins disabling each other at the same moment: each checks again AFTER its own ban has landed (write, then read), so at
      // least one of them sees the other's ban and undoes its own. Both may undo; both never keep theirs. When no other admin can
      // sign in now (or that can't be read), this company's ban is lifted again and the answer is a refusal.
      const stillOther = await adminWhoCanSignIn(admin, orgId, user_id);
      if (stillOther !== true) {
        const undone = await liftDeactivationBan(admin, user_id, [orgId]);
        if (undone.error || undone.stillBanned) {
          console.error("[admin/users/sign-in] last-admin undo failed");
          return jsonError("Another admin's sign-in changed at the same time, and their sign-in may still be disabled. Reload to check.", 500);
        }
        return stillOther === null ? jsonError("Couldn't change sign-in. Nothing was changed. Try again.", 500) : jsonError(LAST_ADMIN, 409);
      }
    }
    await audit(ctx, "UPDATE_USER_ACCESS", user_id, { sign_in: "disabled" }, request, { sign_in: "enabled" });
    return NextResponse.json({ ok: true, changed: true, sign_in: "off" });
  }

  if (!before.banned) return NextResponse.json({ ok: true, changed: false, sign_in: "on" });
  if (!ours) return jsonError(`Their sign-in was disabled by ${PRODUCT.name} support, so only ${PRODUCT.name} support can turn it back on.`, 409);
  const lifted = await liftDeactivationBan(admin, user_id, [orgId]);
  if (lifted.error || !lifted.lifted) {
    console.error("[admin/users/sign-in] unban failed");
    return jsonError("Couldn't enable their sign-in. Reload to check, then try again.", 500);
  }
  await audit(ctx, "UPDATE_USER_ACCESS", user_id, { sign_in: "enabled" }, request, { sign_in: "disabled" });
  return NextResponse.json({ ok: true, changed: true, sign_in: "on" });
}
