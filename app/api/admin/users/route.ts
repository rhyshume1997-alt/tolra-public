import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, readJson } from "@/lib/server/auth";
import { type AdminContext, type BanState, audit, banState, companyMayLift, deactivationBanMarker, enrolmentFlag, existingLoginScope, guard, hasVerifiedTotp, liftDeactivationBan, loginIsProtected, ownsIdentity, requireAal2, requireAdminEnrolment } from "@/lib/server/admin-users";
import { becomesAdmin, changesAdmin } from "@/lib/mfa-policy";
import { companyAccessErrorMessage, mayAddExistingLogin, OTHER_COMPANY_LOGIN, PROTECTED_CHECK_FAILED, PROTECTED_LOGIN } from "@/lib/company-access";
import { PRODUCT } from "@/lib/product";
import { passwordProblem, PASSWORD_MAX } from "@/lib/password";
import { setMustChange } from "@/lib/server/password-setup";
import { MEMBER_SECTION_KEYS } from "@/lib/sections";
import { USERNAME_PATTERN, USERNAME_RULES } from "@/lib/username";
import { DISPLAY_NAME_MAX, normaliseDisplayName } from "@/lib/display-name";

// Admin-only user management for the caller's CURRENT organisation. A login can belong to several organisations
// (organization_members), so access is managed per membership. No e-mail is sent anywhere here.
//   POST  { email?, full_name?, role, secondary_role?, hidden_sections?, username?, password, must_change_password? }
//         -> creates the login with the admin's password (confirmed, works at once), or, when the e-mail OR the username
//            already belongs to a login (a member of another organisation), just adds the membership: their password, e-mail,
//            username, name and two-step sign-in are untouched, and the e-mail is optional then (the username is enough).
//            An existing login is added only when it is the caller, or the caller administers every company it is in (403 "This login
//            belongs to another company ..." otherwise; also, from 093, for a login with no company, a platform owner's login and one
//            with any support membership); a disabled login is still refused (409).
//   PATCH { user_id, role?, secondary_role?, hidden_sections?, active?, username?, full_name? }
//         full_name (the display name) is written with the CALLER's client, so RLS ("Admins update org members") and the
//         profile guard decide; a login shared with another company is refused (only the person can rename it).
//         A platform owner's login, or one with any support membership (093), is refused (403) unless the change only switches its
//         access here off (Revoke support access, Deactivate), or it is the caller's own.
//         -> public.set_member_access() with the CALLER's own client, so the database safeguards apply (admin of this
//            organisation, at least one active admin, nobody deactivates or demotes themselves, and from 066 a login keeps at
//            least one active company: last_company comes back as the same sentence as per-company access, plus the next step).
//            Reactivating lifts only the app's own marked sign-in ban; nothing here bans anyone (a leaver whose only company this
//            is: Disable sign-in, ./sign-in/route.ts).
// POST, and a PATCH that gives or takes admin, need the caller's second step (aal2) always (audit Z1, lib/mfa-policy.ts changesAdmin).
// Passwords never reach a log or the audit trail. Set someone's password later: ./password/route.ts.

const ROLES = ["admin", "office", "workshop", "viewer"] as const;
const BAN_FOREVER = "876000h";
const SHARED_IDENTITY = "This person also uses their login with another company, so only they (or the platform owner) can change their username.";
const LOGIN_DISABLED = "That login is disabled, so it can't be added. Contact Tolra support.";
const SHARED_NAME = "This person also uses their login with another company, so only they can change their name (Account Settings).";

const usernameField = z.string().trim().toLowerCase().regex(USERNAME_PATTERN, `Username: ${USERNAME_RULES}`);

const sectionsField = z.array(z.enum(MEMBER_SECTION_KEYS as [string, ...string[]])).max(MEMBER_SECTION_KEYS.length);

const createSchema = z.object({
  // Optional when a username names an existing login (resolved on the server); required for a brand-new login.
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  full_name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ROLES),
  secondary_role: z.enum(ROLES).nullable().optional(),
  hidden_sections: sectionsField.optional(),
  username: usernameField.optional(),
  password: z.string().max(PASSWORD_MAX).optional(),
  must_change_password: z.boolean().default(true),
});

const patchSchema = z
  .object({
    user_id: z.string().uuid(),
    role: z.enum(ROLES).optional(),
    // null removes it.
    secondary_role: z.enum(ROLES).nullable().optional(),
    hidden_sections: sectionsField.optional(),
    active: z.boolean().optional(),
    // null clears it.
    username: usernameField.nullable().optional(),
    // The display name: never empty, never an e-mail address (company_people() would show neither).
    full_name: z.string().trim().min(1).max(DISPLAY_NAME_MAX).refine((value) => !value.includes("@"), "Use a name, not an email address.").optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "user_id" && value[key as keyof typeof value] !== undefined));

/** What to do instead when Deactivate is refused because this is someone's only company. */
const LAST_COMPANY_NEXT_STEP = `If they're leaving, use Disable sign-in instead: it stops them signing in to ${PRODUCT.name}.`;

/** Maps set_member_access() errors to responses (its messages are written for people). */
function memberAccessError(error: { code?: string; message: string; details?: string; hint?: string }) {
  console.error("[admin/users] set_member_access failed", error.code ?? "no-code", String(error.message ?? "").slice(0, 200));
  // The same friendly wording as per-company access (066): a login keeps one company; a clash with another change is retried.
  if (error.hint === "last_company") return jsonError(`${companyAccessErrorMessage(error, "this company")} ${LAST_COMPANY_NEXT_STEP}`, 409);
  if (error.code === "40P01" || error.code === "40001") return jsonError(companyAccessErrorMessage(error, "this company"), 409);
  if (error.code === "42501") return jsonError("Forbidden", 403);
  if (error.code === "P0002") return jsonError("User not found", 404);
  if (error.code === "23514") return jsonError(error.message, 409);
  if (error.code === "22023") return jsonError("Invalid request", 400);
  return jsonError("Could not update user", 500);
}

/** Supabase Auth's own password checks (e.g. leaked-password protection) come back as 422 / weak_password. */
function authPasswordError(error: { status?: number; code?: string; message?: string } | null) {
  if (!error) return null;
  if (error.code === "weak_password" || error.status === 422) return jsonError(error.message || "That password isn't allowed. Choose another.", 400);
  return null;
}

/** True when `username` belongs to someone other than `userId` (usernames are unique across the platform). */
async function usernameTaken(admin: AdminContext["admin"], username: string, userId: string | null) {
  const { data } = await admin.from("user_profiles").select("id").eq("username", username).maybeSingle();
  return Boolean(data && data.id !== userId);
}

/** Sets a member's username with the service role (the profile guard refuses it from signed-in clients). */
async function writeUsername(admin: AdminContext["admin"], userId: string, username: string | null): Promise<{ message: string; status: number } | null> {
  const { error } = await admin.from("user_profiles").update({ username }).eq("id", userId);
  if (!error) return null;
  if (error.code === "23505") return { message: "That username is already taken", status: 409 };
  console.error("[admin/users] username update failed", error.code);
  return { message: "Could not save the username", status: 500 };
}

async function setUsername(admin: AdminContext["admin"], userId: string, username: string | null) {
  const failure = await writeUsername(admin, userId, username);
  return failure ? jsonError(failure.message, failure.status) : null;
}

/**
 * A PATCH can change up to three things, each a separate write: "access" (role, secondary role, pages, active), "username" and "name".
 * Every input is checked before the first write. A write that fails after an earlier one succeeded is reported as
 * { ok: false, error, failed, applied: [...], uncertain: [...] } so the page can say exactly what changed instead of "nothing changed".
 * A step is in exactly one of `applied` (saved), `failed` (known not saved, or rolled back and verified) and `uncertain` (the outcome
 * could not be confirmed: "may not have saved, reload to check"). `failed` is null when only uncertain steps remain.
 */
type PatchStep = "access" | "username" | "name";
function stepFailure(message: string, status: number, failed: PatchStep | null, applied: PatchStep[], uncertain: PatchStep[] = []) {
  return NextResponse.json({ ok: false, error: message, failed, applied, uncertain }, { status });
}

/** Finds an existing login for an e-mail. Profiles first, then the auth list. */
async function findUserIdByEmail(admin: AdminContext["admin"], email: string): Promise<string | null> {
  // ilike for case-insensitivity only: escape its wildcards so "a_b@x.com" can never match "axb@x.com" in another organisation.
  const exact = email.replace(/[\\%_]/g, (char) => `\\${char}`);
  const { data: profile } = await admin.from("user_profiles").select("id").ilike("email", exact).maybeSingle();
  if (profile?.id) return String(profile.id);
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    const match = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (match) return match.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

export async function POST(request: Request) {
  // Creates a login (any role, admin too) or hands an existing one to this company: the second step always (audit Z1).
  const ctx = await guard(request, { aal2: true });
  if (ctx instanceof NextResponse) return ctx;
  const { auth, admin } = ctx;
  const orgId = auth.profile.organization_id;

  const json = await readJson(request, 8 * 1024);
  if (!json.ok) return json.response;
  const parsed = createSchema.safeParse(json.data);
  if (!parsed.success) return jsonError(parsed.error.issues.find((issue) => issue.path[0] === "username")?.message ?? "Invalid request", 400);
  const { role, username, password, must_change_password } = parsed.data;
  let email = parsed.data.email;
  // Only what the admin typed. The existing login's own profile name is never read into this request or returned.
  const full_name = parsed.data.full_name;
  const secondary = parsed.data.secondary_role && parsed.data.secondary_role !== role ? parsed.data.secondary_role : null;
  const hidden = parsed.data.hidden_sections ?? [];

  // A username already in use names an EXISTING login (usernames are unique across the platform). That is not an error: the login
  // gets a membership in this company, exactly like the e-mail case below. If an e-mail was typed as well it must be that same
  // login's; otherwise the request is ambiguous and is refused with the old message (nothing about the other login is revealed).
  let userId: string | null = null;
  const typedEmail = parsed.data.email;
  if (username) {
    const { data: owner } = await admin.from("user_profiles").select("id, email").eq("username", username).maybeSingle();
    if (owner?.id) {
      const ownerEmail = String(owner.email ?? "").toLowerCase();
      if (!ownerEmail || (email && ownerEmail !== email)) return jsonError("That username is already taken", 409);
      userId = String(owner.id);
      email = ownerEmail;
    }
  }
  if (!email) return jsonError("Enter an email, or the username of someone who already has a login.", 400);
  if (!userId) userId = await findUserIdByEmail(admin, email);
  const created = !userId;
  let reactivating = false;

  if (userId) {
    // The e-mail already has a login (a member of another organisation, or a former member here): add the
    // membership only. Their password belongs to them and to their other organisations, so it isn't touched.
    const { data: existing } = await admin
      .from("organization_members")
      .select("active")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (existing?.active) return jsonError("That person is already a member of this organisation", 409);
    reactivating = Boolean(existing);
    // Only the caller themself, or a login all of whose companies the caller administers (an admin of
    // JNR and Marpet adds a JNR login to Marpet; a Marpet-only admin can't). Otherwise the login would become shared and JNR could no
    // longer reset its password, username or two-step sign-in (ownsIdentity). Checked before anything is written or the ban is read.
    const scope = await existingLoginScope(admin, auth.user.id, userId);
    if (!scope) return jsonError("Could not check who that login belongs to. Try again.", 500);
    // 093: never a platform owner's login, or one with any support membership (asked only for a login that has a company and isn't the caller).
    let protectedLogin = scope.loginSupport;
    if (!protectedLogin && userId !== auth.user.id && scope.loginCompanies.length > 0) {
      const answer = await loginIsProtected(ctx, userId);
      if (answer === null) return jsonError(PROTECTED_CHECK_FAILED, 500);
      protectedLogin = answer;
    }
    if (!mayAddExistingLogin(auth.user.id, userId, scope.loginCompanies, [...scope.callerAdminCompanies, orgId], protectedLogin)) return jsonError(OTHER_COMPANY_LOGIN, 403);
    if (username) {
      // A username is global: only set it on a login that is (or, once added, will be) this company's alone.
      const { data: current } = await admin.from("user_profiles").select("username").eq("id", userId).maybeSingle();
      const others = await admin.from("organization_members").select("organization_id").eq("user_id", userId).neq("organization_id", orgId).limit(1);
      if (current?.username !== username && (others.error || (others.data ?? []).length > 0)) return jsonError(SHARED_IDENTITY, 409);
    }
    // add_member() does not look at the sign-in ban, so it is checked here BEFORE anything is written. A disabled login (banned by the
    // platform owner or by another organisation) is never added, and a ban is never lifted for it. Only this company's OWN former
    // member carrying the app's deactivation marker passes (their ban is lifted below, as before). Unreadable state: refuse.
    const ban = await banState(admin, userId);
    if (!ban) return jsonError("Could not check whether that login is active. Try again.", 500);
    if (ban.banned && !(reactivating && ban.appBan)) return jsonError(LOGIN_DISABLED, 409);
  } else {
    if (!full_name) return jsonError("Enter a name.", 400);
    const problem = passwordProblem(password ?? "");
    if (problem) return jsonError(problem, 400);
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
      // Same Auth call as the password, so the marker always describes this temporary password.
      ...(must_change_password ? { app_metadata: { temp_password_set_at: new Date().toISOString() } } : {}),
    });
    const passwordRejected = authPasswordError(error);
    if (passwordRejected) return passwordRejected;
    if (error || !data?.user) {
      console.error("[admin/users] create user failed", error?.status, error?.code);
      return jsonError("Could not create the user", 400);
    }
    userId = data.user.id;
  }

  const rollback = async () => {
    if (created && userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  };

  // add_member: membership (role, active), and a profile with this organisation as current one only if none exists.
  const { error: addError } = await admin.rpc("add_member", { p_org: orgId, p_email: email, p_role: role });
  if (addError) {
    console.error("[admin/users] add member failed", addError.code);
    await rollback();
    return jsonError("Could not create the user", 500);
  }

  // Secondary role and page access through the caller's own client: the same checks as editing.
  if (secondary || hidden.length || reactivating) {
    const { error: accessError } = await auth.supabase.rpc("set_member_access", {
      p_user: userId,
      p_secondary_role: secondary,
      p_clear_secondary: !secondary,
      p_hidden_sections: hidden,
    });
    if (accessError) {
      await rollback();
      return memberAccessError(accessError);
    }
  }

  let loginDisabled = false;
  if (created) {
    await admin.from("user_profiles").update({ full_name }).eq("id", userId).then(() => undefined, () => undefined);
    // A new login must not keep an admin-chosen password by accident: no stored requirement, no user.
    if (!(await setMustChange(admin, userId, must_change_password))) {
      console.error("[admin/users] must_change_password not saved");
      await rollback();
      return jsonError("Could not create the user. Try again.", 500);
    }
  } else {
    // Existing login: keep their profile and fill a missing name. Only lift a ban when this organisation is
    // reactivating its own former member (the ban came from deactivating them here); a ban set for any other
    // reason, or by another organisation, stays.
    if (parsed.data.full_name) await admin.from("user_profiles").update({ full_name }).eq("id", userId).is("full_name", null);
    if (reactivating) {
      const result = await liftDeactivationBan(admin, userId, [orgId]);
      if (result.error) console.error("[admin/users] unban failed");
      loginDisabled = result.stillBanned;
    }
  }

  if (username) {
    const usernameError = await setUsername(admin, userId, username);
    if (usernameError) {
      await rollback();
      return usernameError;
    }
  }

  // A new admin sets up an authenticator app at their first sign-in (migration 065). The admin creating them is told so.
  // Reported (and the admin told after saving) only when the person has no verified factor and the flag was actually saved.
  let adminMfaOnboarding = false;
  if (role === "admin" || secondary === "admin") {
    const enrolled = created ? false : await hasVerifiedTotp(admin, userId);
    if (enrolled !== true) adminMfaOnboarding = (await requireAdminEnrolment(admin, orgId, userId)) && enrolled === false;
  }

  await audit(ctx, "CREATE_USER", userId, {
    email: typedEmail ?? null, full_name: full_name ?? null, role, secondary_role: secondary, hidden_sections: hidden, username: username ?? null,
    existing_login: !created, reactivated: reactivating, password_set_by_admin: created, must_change_password: created ? must_change_password : null,
  }, request);
  // An existing login keeps its own password: say so, so the admin does not hand out a password that does nothing. The login's
  // e-mail is returned only when the admin typed it; the message never names another company.
  let message: string | undefined;
  if (!created) {
    const { data: org } = await admin.from("organizations").select("name").eq("id", orgId).maybeSingle();
    // Only what the admin typed: the username, else the name or e-mail they typed. Never the login's own profile name.
    const who = username || full_name || typedEmail || "This person";
    message = `${who} already has a Tolra login; added to ${org?.name ?? "this company"} as ${role}. They sign in with their existing password.`;
  }
  return NextResponse.json({
    ok: true,
    existing_login: !created,
    ...(message ? { message } : {}),
    login_disabled: loginDisabled,
    admin_mfa_onboarding: adminMfaOnboarding,
    user: { id: userId, ...(typedEmail ? { email: typedEmail } : {}), ...(full_name ? { full_name } : {}), role, active: true },
  }, { status: 201 });
}

export async function PATCH(request: Request) {
  const ctx = await guard(request);
  if (ctx instanceof NextResponse) return ctx;
  const { auth, admin } = ctx;
  const orgId = auth.profile.organization_id;

  const json = await readJson(request, 8 * 1024);
  if (!json.ok) return json.response;
  const parsed = patchSchema.safeParse(json.data);
  if (!parsed.success) return jsonError(parsed.error.issues.find((issue) => issue.path[0] === "username" || issue.path[0] === "full_name")?.message ?? "Invalid request", 400);
  const { user_id, role, active, username, secondary_role, hidden_sections, full_name } = parsed.data;
  const accessChange = role !== undefined || active !== undefined || secondary_role !== undefined || hidden_sections !== undefined;

  const { data: before } = await admin
    .from("organization_members")
    .select("role, secondary_role, active, hidden_sections, support")
    .eq("user_id", user_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!before) return jsonError("User not found", 404);
  // Giving or taking admin (role, second role, or reactivating an admin) needs the second step always, like creating a user (audit Z1).
  if (changesAdmin(before, { role, secondary_role, active })) {
    const refused = await requireAal2(auth);
    if (refused) return refused;
  }

  // 093: a platform owner's login, or one with any support membership (here or anywhere, window open or over), is never changed from
  // here, except a change that only switches its access to this company off (Revoke support access, Deactivate): active false and
  // nothing else, never on, never a role. Not oneself.
  const switchOffOnly = active === false && role === undefined && secondary_role === undefined && hidden_sections === undefined && username === undefined && full_name === undefined;
  if (user_id !== auth.user.id && !switchOffOnly) {
    if (before.support === true) return jsonError(PROTECTED_LOGIN, 403);
    const protectedLogin = await loginIsProtected(ctx, user_id);
    if (protectedLogin === null) return jsonError(PROTECTED_CHECK_FAILED, 500);
    if (protectedLogin) return jsonError(PROTECTED_LOGIN, 403);
  }

  // 1. Validate everything first (reads only). Nothing is written until every input is known to be acceptable.
  if (full_name !== undefined && user_id !== auth.user.id && !(await ownsIdentity(admin, user_id, orgId))) return jsonError(SHARED_NAME, 409);
  if (username !== undefined) {
    if (!(await ownsIdentity(admin, user_id, orgId))) return jsonError(SHARED_IDENTITY, 409);
    if (username && await usernameTaken(admin, username, user_id)) return jsonError("That username is already taken", 409);
  }

  // 2. Writes, the most failure-prone first (the database safeguards on access: last admin, self-demotion), then the username
  // (unique), then the name. Whatever was applied before a failure is named in the response.
  const applied: PatchStep[] = [];
  let loginDisabled = false;
  // Given admin by this change: the database flags them to set up an authenticator app (migration 065); the page tells the admin.
  let adminMfaOnboarding = false;

  if (accessChange) {
    // A later step of the access change failed: try to put the WHOLE previous membership back (role, secondary role, pages, active).
    // The response is never trusted: a rollback can commit and still report an error, so the caller always reads the membership back.
    const undoAccess = async () => {
      const { error: restoreError } = await auth.supabase.rpc("set_member_access", {
        p_user: user_id,
        p_role: before.role,
        p_active: before.active,
        p_secondary_role: before.secondary_role ?? null,
        p_clear_secondary: before.secondary_role == null,
        p_hidden_sections: before.hidden_sections ?? [],
      });
      if (restoreError) console.error("[admin/users] access restore failed", restoreError.code ?? "no-code");
    };
    type Member = { role: string; secondary_role: string | null; active: boolean; hidden_sections: string[] | null };
    /** The company-scoped membership as stored right now (same organisation, same user), or null when it could not be read. */
    const readMembership = async (): Promise<Member | null> => {
      const { data, error } = await admin
        .from("organization_members")
        .select("role, secondary_role, active, hidden_sections, support")
        .eq("user_id", user_id)
        .eq("organization_id", orgId)
        .maybeSingle();
      return error || !data ? null : (data as Member);
    };
    const sections = (value: string[] | null | undefined) => JSON.stringify([...(value ?? [])].sort());
    const sameMember = (a: Member, b: Member) =>
      a.role === b.role && (a.secondary_role ?? null) === (b.secondary_role ?? null) && a.active === b.active && sections(a.hidden_sections) === sections(b.hidden_sections);
    const matchesRequest = (m: Member) =>
      (role === undefined || m.role === role) &&
      (secondary_role === undefined || (m.secondary_role ?? null) === secondary_role) &&
      (hidden_sections === undefined || sections(m.hidden_sections) === sections(hidden_sections)) &&
      (active === undefined || m.active === active);
    /**
     * Brings the Auth ban to `wantBanned` and checks it by reading it back. Only a deactivation ban this company may lift is lifted
     * (companyMayLift); a ban someone else set (the platform owner, another company) stays. A ban put back carries `markerOrg`, the
     * company its marker named before (null: a legacy marker). True only when the read-back confirms it, so an unreadable state is
     * never treated as fine.
     */
    const settleAuth = async (wantBanned: boolean, markerOrg: string | null) => {
      const matches = async (state: BanState | null) =>
        state !== null && (wantBanned ? state.banned : !state.banned || !(await companyMayLift(admin, state, user_id, orgId)));
      const now = await banState(admin, user_id);
      if (!now) return false;
      if (await matches(now)) return true;
      if (wantBanned) {
        const { error: banAgainError } = await admin.auth.admin.updateUserById(user_id, { ban_duration: BAN_FOREVER, app_metadata: deactivationBanMarker(markerOrg) });
        if (banAgainError) console.error("[admin/users] ban restore failed", banAgainError.status);
      } else {
        await liftDeactivationBan(admin, user_id, [orgId]);
      }
      return matches(await banState(admin, user_id));
    };
    const UNCERTAIN = "Access may not have been saved. Reload to check what is stored now.";
    /**
     * A step after the access change failed. Nothing is inferred from any response: the rollback is attempted, then the stored membership is
     * READ BACK and the Auth ban is made to match what is actually stored (re-reading the ban, since a call can succeed and still error).
     * If the membership cannot be read back, access is uncertain and Auth is not touched. Returns a response, or null when the read-back
     * shows the membership as requested AND Auth agreeing with it (everything asked for is in place).
     */
    const authStepFailed = async (authStep: { intent: "ban" | "unban"; wasBanned: boolean; markerOrg: string | null }) => {
      await undoAccess();
      const stored = await readMembership();
      if (!stored) return stepFailure(UNCERTAIN, 500, null, [], ["access"]);
      const restored = sameMember(stored, before as Member);
      const authSettled = await settleAuth(restored ? authStep.wasBanned : !stored.active, authStep.markerOrg);
      if (!authSettled) return stepFailure(UNCERTAIN, 500, null, [], ["access"]);
      if (restored) return stepFailure("Could not update user. Nothing was changed.", 500, "access", []);
      if (matchesRequest(stored)) return null;
      return stepFailure(UNCERTAIN, 500, null, [], ["access"]);
    };
    /** A step that never reached Auth failed: the membership is put back if possible and read back; Auth is left alone. */
    const accessStepFailed = async () => {
      await undoAccess();
      const stored = await readMembership();
      return stored && sameMember(stored, before as Member)
        ? stepFailure("Could not update user. Nothing was changed.", 500, "access", [])
        : stepFailure(UNCERTAIN, 500, null, [], ["access"]);
    };

    // Called as the signed-in admin: the function checks admin rights in their current organisation, blocks
    // self-deactivation and self-demotion, and protects the last active admin.
    const { error: rpcError } = await auth.supabase.rpc("set_member_access", {
      p_user: user_id,
      p_role: role ?? null,
      p_active: active ?? null,
      p_secondary_role: secondary_role ?? null,
      p_clear_secondary: secondary_role === null,
      p_hidden_sections: hidden_sections ?? null,
    });
    if (rpcError) return memberAccessError(rpcError);

    if (active === true && !before.active) {
      const banBefore = await banState(admin, user_id);
      if (!banBefore) return accessStepFailed(); // nothing was sent to Auth
      // Only a marked ban this company may lift goes (companyMayLift); another company's, or the platform owner's, stays.
      const result = await liftDeactivationBan(admin, user_id, [orgId]);
      if (result.error) {
        console.error("[admin/users] unban failed");
        const stopped = await authStepFailed({ intent: "unban", wasBanned: banBefore.banned, markerOrg: banBefore.appBan ? banBefore.banOrg : orgId });
        if (stopped) return stopped;
      } else loginDisabled = result.stillBanned;
    }
    // Deactivate never leaves a login without an active company (066: the database refuses the last one, hint last_company), so
    // nobody is banned from signing in here. A leaver whose only company this is: Disable sign-in (./sign-in/route.ts).

    const { data: after } = await admin
      .from("organization_members")
      .select("role, secondary_role, active, hidden_sections")
      .eq("user_id", user_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    // The saved membership must be readable to call the access change done.
    if (!after) return stepFailure(UNCERTAIN, 500, null, [], ["access"]);
    // The database set the flag only if they have no verified factor (065); report it only when it is stored.
    adminMfaOnboarding = !before.support && becomesAdmin(before, after) && (await enrolmentFlag(admin, orgId, user_id));
    const action = active === true && !before.active ? "REACTIVATE_USER" : active === false && before.active ? "DEACTIVATE_USER" : "UPDATE_USER_ACCESS";
    await audit(ctx, action, user_id, { ...(after ?? {}) }, request, before);
    applied.push("access");
  }

  if (username !== undefined) {
    const usernameError = await writeUsername(admin, user_id, username);
    if (usernameError) return stepFailure(usernameError.message, usernameError.status, "username", applied);
    await audit(ctx, "UPDATE_USERNAME", user_id, { username }, request);
    applied.push("username");
  }

  let savedName: string | undefined;
  if (full_name !== undefined) {
    const name = normaliseDisplayName(full_name);
    const { data: old } = await admin.from("user_profiles").select("full_name").eq("id", user_id).maybeSingle();
    // As the signed-in admin: RLS and the profile guard decide, not the service role.
    const { data: saved, error: nameError } = await auth.supabase.from("user_profiles").update({ full_name: name }).eq("id", user_id).select("id");
    if (nameError || !saved?.length) {
      console.error("[admin/users] name update failed", nameError?.code ?? "no-row");
      const forbidden = nameError?.code === "42501";
      return stepFailure(forbidden ? "Forbidden" : "Could not save the name", forbidden ? 403 : 500, "name", applied);
    }
    await audit(ctx, "UPDATE", user_id, { full_name: name }, request, { full_name: old?.full_name ?? null });
    applied.push("name");
    savedName = name;
  }

  const { data: current } = await admin
    .from("organization_members")
    .select("role, secondary_role, active, hidden_sections")
    .eq("user_id", user_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  return NextResponse.json({
    ok: true,
    applied,
    login_disabled: loginDisabled,
    admin_mfa_onboarding: adminMfaOnboarding,
    user: { id: user_id, ...(current ?? {}), ...(username !== undefined ? { username } : {}), ...(savedName !== undefined ? { full_name: savedName } : {}) },
  });
}
