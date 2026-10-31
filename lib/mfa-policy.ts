/**
 * Admin two-step sign-in (Supabase TOTP, authenticator app). Who needs it, and the one switch.
 *
 * REQUIRE_ADMIN_MFA
 *   "true"   always required for admins;
 *   "false"  never (local development and the automated tests);
 *   unset    off everywhere. It is switched on deliberately at go-live, by setting "true" in Vercel Production, only
 *            after Supabase TOTP is confirmed enabled on the hosted project and the admins can enrol
 *            (docs/GO-LIVE-GATES.md A5). Turning it on by default could lock every admin out after a deploy.
 *
 * Required means: a person whose role (or second role) is admin can use the app, its API routes and the privileged database
 * actions only on a session that has passed the second step (assurance level aal2). Everyone else is unaffected. The
 * database has its own switch for the same rule (organizations.require_admin_mfa, migration 033) for the actions that
 * the browser calls without going through our API.
 */
export function adminMfaRequired(env: Record<string, string | undefined> = process.env): boolean {
  const setting = env.REQUIRE_ADMIN_MFA?.trim().toLowerCase();
  if (setting === "true" || setting === "1" || setting === "on") return true;
  if (setting === "false" || setting === "0" || setting === "off") return false;
  return false;
}

/** True for a person who holds the admin role as their role or second role. */
export function holdsAdmin(profile: { role?: string | null; secondary_role?: string | null } | null | undefined): boolean {
  return profile?.role === "admin" || profile?.secondary_role === "admin";
}

/** What the API answers (403) when the second step is missing; the browser sends the person to /mfa. */
export const MFA_REQUIRED_CODE = "mfa_required";

// ---- Onboarding a new admin (migration 065) ---------------------------------------------------------------------------------
// When someone is GIVEN admin by another admin (created as admin, role or second role changed to admin, an admin reactivated, or
// their two-step sign-in reset), their membership is flagged (organization_members.mfa_enrolment_required). Until they have a
// verified authenticator factor, every page sends them to /mfa?enrol=1 to set one up, even while REQUIRE_ADMIN_MFA is off. It is
// an enrolment step, not the aal2 gate: once set up they are not asked for a code at each sign-in unless REQUIRE_ADMIN_MFA is on.
// The database answers FALSE for the last admin who could still sign in normally, so a company is never locked out.

/** What the admin is told when giving someone admin, and what the new admin is told on the set-up screen. */
export const ADMIN_MFA_ONBOARDING_NOTICE =
  "Admins must use two-step sign-in. At their next sign-in they will be asked to set up an authenticator app (Microsoft Authenticator, Google Authenticator or similar) before they can use the app.";
export const ADMIN_MFA_ONBOARDING_SELF =
  "You have been made an administrator. Administrators must use two-step sign-in: set up an authenticator app now to continue.";

/** Query string the middleware adds when it sends a newly made admin to /mfa to set up. */
export const MFA_ENROL_PARAM = "enrol";

type Roles = { role?: string | null; secondary_role?: string | null; active?: boolean | null } | null | undefined;

/** True when `after` holds admin (and is active) and `before` did not: the moment the onboarding notice applies. */
export function becomesAdmin(before: Roles, after: Roles): boolean {
  const admin = (m: Roles) => Boolean(m) && m?.active !== false && holdsAdmin(m);
  return admin(after) && !admin(before);
}

/**
 * True when a membership change gives or takes admin: the role or second role to or from admin, or reactivating someone who holds
 * it. Such a change hands over (or takes away) the company's admin rights, so it needs the second step always, like creating a user
 * (audit Z1). Fields left undefined are unchanged; a null second role removes it.
 */
export function changesAdmin(before: Roles, change: { role?: string; secondary_role?: string | null; active?: boolean }): boolean {
  const after = {
    role: change.role ?? before?.role,
    secondary_role: change.secondary_role !== undefined ? change.secondary_role : before?.secondary_role,
    active: change.active ?? before?.active,
  };
  return holdsAdmin(before) !== holdsAdmin(after) || becomesAdmin(before, after);
}

/**
 * Whether the middleware should ask the database if this person must set up an authenticator app first. Only when the global
 * switch is off (when it is on, the aal2 gate already sends every admin to /mfa), for someone holding admin, who is not at aal2
 * and has no verified factor on this session (nextLevel aal1). The database decides the rest (my_mfa_enrolment_required).
 */
export function shouldCheckEnrolment(input: { globalRequired: boolean; holdsAdmin: boolean; currentLevel?: string | null; nextLevel?: string | null }): boolean {
  if (input.globalRequired || !input.holdsAdmin) return false;
  return input.currentLevel !== "aal2" && input.nextLevel !== "aal2";
}

export type AdminMfaOverview = {
  requireAdminMfa: boolean;
  canRequire: boolean;
  admins: Map<string, { enrolled: boolean; enrolmentRequired: boolean }>;
};

/** Parses admin_mfa_overview() (migration 065). Null when the answer is missing or not the expected shape. */
export function parseAdminMfaOverview(value: unknown): AdminMfaOverview | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { require_admin_mfa?: unknown; can_require?: unknown; admins?: unknown };
  if (typeof raw.require_admin_mfa !== "boolean" || typeof raw.can_require !== "boolean" || !Array.isArray(raw.admins)) return null;
  const admins = new Map<string, { enrolled: boolean; enrolmentRequired: boolean }>();
  for (const row of raw.admins) {
    if (!row || typeof row !== "object") return null;
    const { user_id, enrolled, enrolment_required } = row as Record<string, unknown>;
    if (typeof user_id !== "string" || typeof enrolled !== "boolean") return null;
    admins.set(user_id, { enrolled, enrolmentRequired: enrolment_required === true });
  }
  return { requireAdminMfa: raw.require_admin_mfa, canRequire: raw.can_require, admins };
}

/** One line for an admin's row in Admin > Users. */
export function adminMfaStatusLabel(status: { enrolled: boolean; enrolmentRequired: boolean } | undefined): string {
  if (!status) return "Two-step sign-in: unknown";
  if (status.enrolled) return "Two-step sign-in: set up";
  return status.enrolmentRequired ? "Two-step sign-in: not set up (asked at next sign-in)" : "Two-step sign-in: not set up";
}

/**
 * The database rule's state (organizations.require_admin_mfa) for Admin > Users. `nameOf` gives a person's display name. The rule
 * itself is switched on in the release route (docs/GO-LIVE-GATES.md A5), not from the app; the database refuses it while any admin
 * has not set up an authenticator app.
 */
export function adminMfaRuleMessage(overview: AdminMfaOverview, nameOf: (userId: string) => string): { tone: "ok" | "warn"; text: string } {
  const missing = [...overview.admins.entries()].filter(([, s]) => !s.enrolled).map(([id]) => nameOf(id)).sort((a, b) => a.localeCompare(b));
  if (overview.requireAdminMfa) {
    return missing.length
      ? { tone: "warn", text: `The company requires two-step sign-in for admins. ${missing.join(", ")} must set up an authenticator app before they can make admin changes.` }
      : { tone: "ok", text: "The company requires two-step sign-in for admins. Every admin has set it up." };
  }
  if (missing.length) {
    return { tone: "warn", text: `Two-step sign-in can't be required for this company yet: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} not set up an authenticator app.` };
  }
  return { tone: "ok", text: "Every admin has set up two-step sign-in, so it can be required for this company." };
}
