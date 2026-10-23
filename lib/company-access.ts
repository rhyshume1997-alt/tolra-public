/**
 * Admin > Users, per-company access (migration 066). An admin who also administers other companies (e.g. JNR and Marpet) gives or
 * takes a login's access to each of them, with a role, from the Add and Edit dialogs. The database decides everything
 * (public.admin_set_company_access: admin of THAT company, its two-step rule, last admin, no self-demotion, a login keeps one company,
 * audited in that company's log); this file only turns its answers into what the page shows and what it sends.
 */
import type { UserRole } from "@/types";

export const COMPANY_ROLES: UserRole[] = ["admin", "office", "workshop", "viewer"];
const isRole = (value: unknown): value is UserRole => typeof value === "string" && (COMPANY_ROLES as string[]).includes(value);

/** One company the signed-in admin administers, and the login's membership there (from my_admin_companies / admin_company_access). */
export type CompanyAccess = {
  organizationId: string;
  name: string;
  /** The company this session works in: its access is set by the main Role fields, not here. */
  isCurrent: boolean;
  requireAdminMfa: boolean;
  member: boolean;
  role: UserRole | null;
  secondary: UserRole | "";
  active: boolean;
  /** A Tolra support membership: never changed here. */
  support: boolean;
};

/** Rows from my_admin_companies() or admin_company_access(); anything malformed is dropped. */
export function parseCompanyAccess(data: unknown): CompanyAccess[] {
  if (!Array.isArray(data)) return [];
  const rows: CompanyAccess[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.organization_id !== "string" || !r.organization_id) continue;
    rows.push({
      organizationId: r.organization_id,
      name: typeof r.name === "string" && r.name ? r.name : "Company",
      isCurrent: r.is_current === true,
      requireAdminMfa: r.require_admin_mfa === true,
      member: r.member === true,
      role: isRole(r.role) ? r.role : null,
      secondary: isRole(r.secondary_role) ? r.secondary_role : "",
      active: r.active === true,
      support: r.support === true,
    });
  }
  return rows;
}

/** What the admin has ticked for one other company. */
export type CompanyDraft = { organizationId: string; name: string; on: boolean; role: UserRole; secondary: UserRole | ""; locked: boolean };

/** The editable rows: every company but the current one. A company the login is not in starts off, with `defaultRole` ready. */
export function draftCompanies(rows: CompanyAccess[], defaultRole: UserRole = "workshop"): CompanyDraft[] {
  return rows.filter((row) => !row.isCurrent).map((row) => ({
    organizationId: row.organizationId,
    name: row.name,
    on: row.active && !row.support,
    role: row.role ?? defaultRole,
    secondary: row.secondary && row.secondary !== (row.role ?? defaultRole) ? row.secondary : "",
    locked: row.support,
  }));
}

/** One call of admin_set_company_access, as POST /api/admin/users/companies takes it. */
export type CompanyChange = { organization_id: string; active: boolean; role?: UserRole; secondary_role?: UserRole | null };

/**
 * The changes between what is stored (`rows`; empty for a brand-new login) and what is ticked (`drafts`): switched on (grant, with the
 * role), switched off (removal), or a different role or second role while on. Current and support rows are never sent.
 */
export function planCompanyChanges(rows: CompanyAccess[], drafts: CompanyDraft[]): CompanyChange[] {
  const stored = new Map(rows.map((row) => [row.organizationId, row]));
  const changes: CompanyChange[] = [];
  for (const draft of drafts) {
    const row = stored.get(draft.organizationId);
    if (draft.locked || row?.isCurrent || row?.support) continue;
    const secondary = draft.secondary && draft.secondary !== draft.role ? draft.secondary : null;
    const wasOn = Boolean(row?.active);
    if (!draft.on) {
      if (wasOn) changes.push({ organization_id: draft.organizationId, active: false });
      continue;
    }
    if (!wasOn || row?.role !== draft.role || (row?.secondary || null) !== secondary) {
      changes.push({ organization_id: draft.organizationId, active: true, role: draft.role, secondary_role: secondary });
    }
  }
  return changes;
}

/** Adding or switching on an EXISTING login that is also in a company the caller does not administer (hint other_company_login). */
export const OTHER_COMPANY_LOGIN = "This login belongs to another company. An admin of that company must add it.";

/** A platform owner's login, or one with any Tolra support membership (093): no company admin changes it (hint protected_login). */
export const PROTECTED_LOGIN = "This is a Tolra support login, so it can't be changed here.";
/** The check behind PROTECTED_LOGIN couldn't be made (e.g. the database doesn't have its 093 update yet): nothing is changed. */
export const PROTECTED_CHECK_FAILED = "Couldn't check whether this is a Tolra support login, so nothing was changed. Try again; if it keeps happening, the database needs its 093 update (contact Tolra support).";

/**
 * Whether an admin may add (or switch back on) an EXISTING login in one of their companies. Allowed only when the login is the
 * caller themself, or every company where it has a membership (active or not, the target company included) is one where the caller
 * is an active admin. Otherwise the login would become shared with a company that does not own it, and its owner company could no
 * longer reset its password, username or two-step sign-in (ownsIdentity). The database applies the same rule in
 * admin_set_company_access (066, hint other_company_login).
 * Never (093): a login with no membership at all (nothing shows it is the caller's to add), or `protectedLogin`, a platform owner's
 * login or one with any support membership, active or switched off, window open or over (admin_login_is_protected), unless it is the
 * caller themself.
 */
export function mayAddExistingLogin(callerId: string, loginId: string, loginCompanies: readonly string[], callerAdminCompanies: readonly string[], protectedLogin: boolean): boolean {
  if (loginCompanies.length === 0) return false;
  if (callerId === loginId) return true;
  if (protectedLogin) return false;
  const admin = new Set(callerAdminCompanies);
  return loginCompanies.every((company) => admin.has(company));
}

/** The database's refusals (hint, else SQLSTATE) as one sentence naming the company. */
export function companyAccessErrorMessage(error: { code?: string | null; hint?: string | null } | null | undefined, company: string): string {
  switch (error?.hint) {
    case "not_company_admin": return `You're not an admin of ${company}, so you can't change who has access to it.`;
    case "mfa_required": return `${company} requires two-step sign-in for admins. Sign out, sign in again with your authenticator code, then try again.`;
    case "last_admin": return `${company} must keep at least one active admin.`;
    case "self_removal": return `You can't remove your own access to ${company}.`;
    case "self_demotion": return `You can't remove your own admin rights in ${company}. Ask another admin there.`;
    case "last_company": return `They must keep access to at least one company, so ${company} can't be removed.`;
    case "support_membership": return `Tolra support access to ${company} can't be changed here.`;
    case "support_session": return "Support access can't change who has access to a company.";
    case "unknown_login": return `Add them to your company with New user first, then give them access to ${company}.`;
    case "other_company_login": return OTHER_COMPANY_LOGIN;
    case "protected_login": return PROTECTED_LOGIN;
    case "concurrent_change": return `Someone changed access to ${company} at the same time. Reload and try again.`;
    default: break;
  }
  switch (error?.code) {
    case "22023": return `Choose a role for ${company}.`;
    case "P0002": return "User not found.";
    case "42501": return `You can't change who has access to ${company}.`;
    case "40001": case "40P01": return `Someone changed access to ${company} at the same time. Reload and try again.`;
    default: return `Couldn't update access to ${company}. Try again.`;
  }
}

/** One company's outcome, as the route returns it. */
export type CompanyResult = { organization_id: string; name: string; ok: boolean; changed?: boolean; action?: string | null; error?: string; admin_mfa_onboarding?: boolean; login_disabled?: boolean };

/** Reads the route's `results`; anything malformed is dropped. */
export function parseCompanyResults(data: unknown): CompanyResult[] {
  const list = data && typeof data === "object" ? (data as { results?: unknown }).results : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.organization_id !== "string") return [];
    return [{
      organization_id: r.organization_id,
      name: typeof r.name === "string" && r.name ? r.name : "Company",
      ok: r.ok === true,
      changed: r.changed === true,
      action: typeof r.action === "string" ? r.action : null,
      ...(typeof r.error === "string" ? { error: r.error } : {}),
      admin_mfa_onboarding: r.admin_mfa_onboarding === true,
      login_disabled: r.login_disabled === true,
    }];
  });
}

/** The toast after saving: what was saved, and each company that was refused with its reason. */
export function summariseCompanyResults(results: CompanyResult[]): { tone: "ok" | "partial" | "error" | "none"; text: string } {
  const saved = results.filter((r) => r.ok && r.changed).map((r) => r.name);
  const failed = results.filter((r) => !r.ok);
  if (!saved.length && !failed.length) return { tone: "none", text: "" };
  const parts: string[] = [];
  if (saved.length) parts.push(`Company access saved: ${saved.join(", ")}.`);
  for (const r of failed) parts.push(`${r.name}: ${r.error ?? "not saved."}`);
  return { tone: failed.length ? (saved.length ? "partial" : "error") : "ok", text: parts.join(" ") };
}
