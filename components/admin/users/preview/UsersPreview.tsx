"use client";

/**
 * BOUNDARY (Auth / Company / Users / Admin, Module 1, PREVIEW ONLY, security-critical module: nothing here is wired to anything).
 * Inputs: none from the server. Everything shown is fictional sample data (people on reserved ".example" addresses, one made-up company, as of 23/11/2026) held in
 * this file, plus the person's clicks. Outputs: an Admin > Users look-and-feel prototype (the table, the Add user and Edit forms, Set password, the
 * confirmations, the Inspectors section) whose only state is LOCAL UI state. It contains NO authentication, NO session, NO role escalation path (the "Role" control
 * in Preview controls only changes which screen is drawn; it grants nothing), NO API route, Supabase, e-mail, MFA, password-reset or clipboard call, and the
 * authenticator-code step-up dialog is deliberately not drawn. A password typed or generated here lives in this component's state until it closes and goes nowhere.
 * No action reports success: every action answers with the neutral "Preview only ... Nothing was saved." toast and nothing changes. Destructive actions (Deactivate,
 * Disable sign-in, Reset two-step, Switch off support access) show the real page's confirmation wording first, then only the toast.
 * Run-time imports from lib/ are pure modules only (password, username, display-name, mfa-policy, sign-in-access, sections, company-access, empty-hints, dates,
 * product, shell-status) and types. The form checks are the REAL pure validators; the few rules that live inline in app/(dashboard)/admin/users/page.tsx and
 * components/authorised-inspectors.tsx are mirrored here and pinned to that source text by tests/unit/usersPreview.test.ts.
 * v2 (owner-approved structure, STRUCTURAL-CHANGES-BRIEF items 3, 4, 7, 9, 10, 11): the per-row clock-in toggles ("On site only", "Can clock in off site (while the network lock is on)") live in the Edit user sheet (same
 * labels, same rules: only for an active, non-support person, and only when the database has migration 075 / 114); the two stacked notices are ONE "N things need attention" Disclosure that opens to the two original messages
 * verbatim; one role pill style plus a dot-and-word status; ONE primary action (Edit) per row, the rest in More; one PreviewBar strip; the generic page sentence is a tooltip and a screen-reader description of the title.
 * MUST NOT CHANGE: wording, roles, columns, row actions and who may see which control mirror today's page (Admin only: everyone else sees "Access Denied"). Do not
 * wire this to real data, a session or an action, do not add a control the real page lacks, keep row controls at a 48 px hit area. Delete the four preview files
 * (this component and its .module.css, app/(dashboard)/admin/users/preview/page.tsx, tests/unit/usersPreview.test.ts) to remove it completely.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Button, Checkbox, Disclosure, EmptyState, FailedState, Field, Input, LoadingState, PageHeader, Popover, PreviewBar, ScrollTable, SegmentedControl, Select, Sheet, StatusBadge, Switch, Textarea,
  ToastProvider, cx, nextMenuIndex, placeLayer, premiumTokens, srOnly, tabularNumbers, typeScale, useToast,
} from "@/components/ui/premium";
import type { LayerPosition, StatusTone } from "@/components/ui/premium";
import { fmtDateTime } from "@/lib/dates";
import { displayNameProblem, hasDisplayName, normaliseDisplayName, countMissingNames } from "@/lib/display-name";
import { usersEmptyHint } from "@/lib/empty-hints";
import { ADMIN_MFA_ONBOARDING_NOTICE, adminMfaRuleMessage, adminMfaStatusLabel, becomesAdmin, holdsAdmin, parseAdminMfaOverview } from "@/lib/mfa-policy";
import type { AdminMfaOverview } from "@/lib/mfa-policy";
import { generatePassword, PASSWORD_RULES, passwordProblem } from "@/lib/password";
import { PRODUCT } from "@/lib/product";
import { sectionsForRoles } from "@/lib/sections";
import { DESK_QUERY } from "@/lib/shell-status";
import {
  disableSignInConfirm, identityActions, SIGN_IN_CHECKING_LABEL, SIGN_IN_HELP, signInBadge, signInControls,
} from "@/lib/sign-in-access";
import type { ProtectedState, SignInState } from "@/lib/sign-in-access";
import { draftCompanies, planCompanyChanges } from "@/lib/company-access";
import type { CompanyAccess, CompanyDraft } from "@/lib/company-access";
import { isValidUsername, normaliseUsername, USERNAME_RULES } from "@/lib/username";
import type { UserRole } from "@/types";

import s from "./UsersPreview.module.css";

export type Role = UserRole;
export type Screen = "ready" | "loading" | "error" | "empty" | "checking" | "signin-unreadable" | "mfa-unreadable" | "flags-error" | "access-loading" | "access-error";

/* ---------- the real page's constants and wording (mirrored where the real file holds them inline; pinned by the test) ---------- */
export const COMPANY_NAME = "Fernhill Engineering Ltd";
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
export const ROLE_HELP: Record<Role, string> = {
  admin: "everything, including invoices, settings and users",
  office: "quotes, sales orders, invoices and payments, customers, suppliers, POs and jobs",
  workshop: "jobs, schedule and delivery notes",
  viewer: "read-only jobs and schedule",
};
export const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
/** The real submitAdd toast text, and what the native `required={!add.username.trim()}` on Full name and Email says in this form. */
export const ADD_NEEDS_PERSON = "Enter a name and an email, or the username of someone who already has a login.";
export const REQUIRED_UNLESS_USERNAME = "Required unless you enter a username.";
/** The browser's own type="email" check (the real field relies on it), mirrored: something, an @, something with a dot-free or dotted domain. */
export const EMAIL_PROBLEM = "Enter an email address with an @ in it.";
export const SELF_ADMIN_NOTE = "You can't remove your own admin rights; another admin can.";
/** The page sentence under the title, split: the first part is generic (a tooltip and a screen-reader description of the title), the second states a rule (kept visible). Together they are the real wording. */
export const USERS_INTRO_GENERIC = `Add people to ${COMPANY_NAME}, choose what they can open, and manage their passwords.`;
export const USERS_INTRO_RULE = "Nothing is e-mailed unless you press Send password reset e-mail.";
/** The real page's two long clock-in explanations (the tooltips of the two row switches), kept word for word. */
export const ON_SITE_RULE = "On site only: clock-ins from another network are flagged for the office (never refused) while the check is on in Settings.";
export const OFF_SITE_RULE = "While clock-in is locked to the workshop network (Settings), only people ticked here can clock in from another network.";
export const ON_SITE_LABEL = "On site only";
export const OFF_SITE_LABEL = "Can clock in off site (while the network lock is on)";
export const FLAGS_FALLBACK = "Couldn't load who can record inspections.";
export const ACCESS_LOAD_FALLBACK = "Couldn't load their access to your other companies.";
export const PREVIEW_ONLY_NOTE = "Preview only. Nothing is read from or saved to your account.";
/** components/authorised-inspectors.tsx: the limits and wording of the inspectors list (lib/inspectors.ts imports Supabase, so they are mirrored and pinned). */
export const REASON_MIN = 10;
export const REASON_MAX = 500;
export const SCOPE_MAX = 200;

export type SeedUser = {
  id: string; fullName: string; email: string; username: string; role: Role; secondary: Role | ""; lastLogin: string | null; active: boolean; hidden: string[];
  mustChange: boolean; support: boolean; expiresAt: string | null; inspector: boolean;
  /** The login's sign-in state when it belongs to this company alone (absent: it is shared with another company, so Deactivate is offered). */
  signIn?: SignInState;
  shield?: ProtectedState;
  /** Two-step sign-in, for people holding admin. */
  mfa?: { enrolled: boolean; enrolmentRequired: boolean };
  onSite: boolean; offSite: boolean;
  /** Their membership in the other companies this admin administers. */
  access?: CompanyAccess[];
};
export const ME = "u01";
export const nameOf = (u: Pick<SeedUser, "fullName" | "email">) => (hasDisplayName(u.fullName) ? u.fullName.trim() : u.email);

const OTHER = { fab: "o2", brook: "o3" };
const CO = (organizationId: string, name: string, extra: Partial<CompanyAccess> = {}): CompanyAccess => ({ organizationId, name, isCurrent: false, requireAdminMfa: false, member: false, role: null, secondary: "", active: false, support: false, ...extra });
export const MY_COMPANIES: CompanyAccess[] = [
  CO("o1", COMPANY_NAME, { isCurrent: true, member: true, active: true }), CO(OTHER.fab, "Fernhill Fabrication Ltd"), CO(OTHER.brook, "Brookside Machining Ltd"),
];
const memberIn = (fab: CompanyAccess["role"], brook: CompanyAccess["role"] | "support" = null): CompanyAccess[] => [
  MY_COMPANIES[0],
  CO(OTHER.fab, "Fernhill Fabrication Ltd", fab ? { member: true, role: fab, active: true } : {}),
  CO(OTHER.brook, "Brookside Machining Ltd", brook === "support" ? { member: true, role: "admin", active: true, support: true } : brook ? { member: true, role: brook, active: true } : {}),
];
const U = (id: string, fullName: string, email: string, username: string, role: Role, extra: Partial<SeedUser> = {}): SeedUser => ({
  id, fullName, email, username, role, secondary: "", lastLogin: "2026-11-21T09:12:00Z", active: true, hidden: [], mustChange: false, support: false, expiresAt: null,
  inspector: false, signIn: "on", onSite: false, offSite: false, ...extra,
});
/** 14 fictional people: every row state the real table can draw. */
export const SEED_USERS: SeedUser[] = [
  U("u01", "Priya Raman", "priya.raman@fernhill.example", "priyar", "admin", { lastLogin: "2026-11-23T08:41:00Z", mfa: { enrolled: true, enrolmentRequired: false }, access: memberIn("admin") }),
  U("u02", "Tomas Whitcombe", "tomas.whitcombe@fernhill.example", "twhitcombe", "admin", { secondary: "office", inspector: true, signIn: undefined, mfa: { enrolled: false, enrolmentRequired: true }, lastLogin: "2026-11-20T16:03:00Z", access: memberIn("admin") }),
  U("u03", "Elena Voss", "elena.voss@fernhill.example", "", "admin", { mustChange: true, lastLogin: null, mfa: { enrolled: false, enrolmentRequired: false }, access: memberIn(null) }),
  U("u04", "Callum Reeve", "callum.reeve@fernhill.example", "creeve", "office", { hidden: ["invoices", "approval"], inspector: true, onSite: true, lastLogin: "2026-11-23T07:55:00Z", access: memberIn("office", "support") }),
  U("u05", "Ngozi Adeyemi", "ngozi.adeyemi@fernhill.example", "nadeyemi", "office", { secondary: "workshop", offSite: true, lastLogin: "2026-11-22T17:20:00Z", access: memberIn(null, "viewer") }),
  U("u06", "Harvey Lindqvist", "harvey.lindqvist@fernhill.example", "hlindqvist", "workshop", { inspector: true, onSite: true, lastLogin: "2026-11-23T06:48:00Z", access: memberIn(null) }),
  U("u07", "Maya Castellano", "maya.castellano@fernhill.example", "mcastellano", "workshop", { lastLogin: null, onSite: true, access: memberIn(null) }),
  U("u08", "Idris Boateng", "idris.boateng@fernhill.example", "", "viewer", { lastLogin: "2026-11-19T13:30:00Z", access: memberIn(null) }),
  U("u09", "", "stores@fernhill.example", "stores", "workshop", { lastLogin: "2026-11-18T10:02:00Z", onSite: true, access: memberIn(null) }),
  U("u10", "Josefina Marlowe", "josefina.marlowe@fernhill.example", "jmarlowe", "office", { active: false, lastLogin: "2026-09-30T15:44:00Z", signIn: undefined, access: memberIn(null) }),
  U("u11", "Rafe Ostrander", "rafe.ostrander@fernhill.example", "rostrander", "workshop", { signIn: "off", lastLogin: "2026-10-12T11:16:00Z", access: memberIn(null) }),
  U("u12", "Wilhelmina Pryce", "wilhelmina.pryce@fernhill.example", "wpryce", "office", { signIn: "off_platform", lastLogin: "2026-08-04T09:01:00Z", access: memberIn(null) }),
  U("u13", "Bartholomew Featherstonehaugh-Cholmondeley", "bartholomew.featherstonehaugh-cholmondeley@fernhill-engineering.example", "bfeatherstonehaugh", "workshop", { lastLogin: "2026-11-21T14:09:00Z", access: memberIn(null) }),
  U("u14", "Orla Platform (sample owner)", "owner@platform.example", "", "admin", { shield: "protected", signIn: undefined, mfa: { enrolled: true, enrolmentRequired: false }, lastLogin: "2026-11-02T10:00:00Z" }),
  U("u15", "Tolra Support (sample)", "support@platform.example", "", "admin", { support: true, expiresAt: "2026-11-30T17:00:00Z", signIn: undefined, lastLogin: "2026-11-20T09:30:00Z" }),
];
export type InspectorChange = { id: string; userId: string; change: "added" | "removed"; scope: string | null; reason: string; changedBy: string | null; changedAt: string };
export const SEED_HISTORY: InspectorChange[] = [
  { id: "h3", userId: "u06", change: "added", scope: "Dimensional and visual checks", reason: "Trained on bore gauges and the CMM, signed off by the quality manager.", changedBy: "u01", changedAt: "2026-10-27T11:40:00Z" },
  { id: "h2", userId: "u04", change: "added", scope: null, reason: "Moved from workshop to goods-in inspection.", changedBy: "u01", changedAt: "2026-09-30T09:15:00Z" },
  { id: "h1", userId: "u02", change: "added", scope: "All inspections", reason: "Quality manager, ISO 9001 lead auditor course completed.", changedBy: "u01", changedAt: "2026-09-14T14:20:00Z" },
  { id: "h0", userId: "u08", change: "removed", scope: null, reason: "Left the inspection team.", changedBy: "u01", changedAt: "2026-09-02T16:05:00Z" },
];

/* ---------- pure logic ---------- */
export const canUseUsers = (r: Role) => r === "admin";
export const isLastAdminOf = (rows: readonly SeedUser[], u: SeedUser) =>
  u.active && !u.support && (u.role === "admin" || u.secondary === "admin") && rows.filter((x) => x.active && !x.support && (x.role === "admin" || x.secondary === "admin")).length <= 1;
export type Context = { signInChecking: boolean; protectedUnavailable: boolean; signIn: ReadonlyMap<string, SignInState>; shielded: ReadonlyMap<string, ProtectedState>; lastAdmin: (u: SeedUser) => boolean };
export type RowAction = {
  id: "edit" | "password" | "reset-email" | "reset-mfa" | "sign-in" | "deactivate" | "support-off";
  label: string; disabled: boolean; reason?: string | null; confirm?: string; destructive?: boolean; menu?: boolean;
};
export type RowPlan = { support: boolean; note: string | null; actions: RowAction[] };
/**
 * The real row's control rules (page.tsx lines ~537-633), worked out from the same pure functions it calls (signInControls, identityActions):
 * who gets Edit, Set password, Send password reset e-mail, Reset two-step, Enable / Disable sign-in, Deactivate / Reactivate, and which are off and why.
 */
export function planRowActions(u: SeedUser, ctx: Context): RowPlan {
  const isSelf = u.id === ME;
  if (u.support) {
    return { support: true, note: null, actions: [{ id: "support-off", label: "Switch off support access", disabled: false, destructive: true, confirm: `Switch off Tolra support access to ${COMPANY_NAME}? It ends straight away.` }] };
  }
  const name = nameOf(u);
  const controls = signInControls({ isSelf, isLastAdmin: ctx.lastAdmin(u), active: u.active, checking: ctx.signInChecking, state: ctx.signIn.get(u.id) });
  const identity = identityActions({ isSelf, checking: ctx.signInChecking, unavailable: ctx.protectedUnavailable, state: ctx.shielded.get(u.id) });
  const actions: RowAction[] = [{ id: "edit", label: "Edit", disabled: !identity.allowed, reason: identity.reason }];
  if (!isSelf) actions.push({ id: "password", label: "Set password", disabled: !u.active || !identity.allowed, reason: identity.reason, menu: true });
  if (!isSelf) {
    const resetReason = !u.email ? "No e-mail address on file: use Set password."
      : identity.reason ?? (ctx.signInChecking ? SIGN_IN_CHECKING_LABEL : ctx.signIn.get(u.id) !== "on" ? "Only available for a login that belongs to this company alone and can sign in: they can use Forgot password on the sign-in page." : null);
    actions.push({ id: "reset-email", label: "Send password reset e-mail", disabled: !u.active || resetReason !== null, reason: resetReason ?? "E-mail them a link to choose a new password", menu: true,
      confirm: `E-mail ${name} a link to choose a new password? Their current password keeps working until they use it.` });
  }
  if (!isSelf && u.role === "admin") {
    actions.push({ id: "reset-mfa", label: "Reset two-step", disabled: !u.active || !identity.allowed, reason: identity.reason, menu: true, destructive: true,
      confirm: `Reset two-step sign-in for ${name}? They will set up their authenticator app again at their next sign-in. Only do this once you are sure it is really them asking.` });
  }
  if (!(!identity.allowed && !ctx.signInChecking)) {
    if (controls.signIn === "checking") actions.push({ id: "sign-in", label: SIGN_IN_CHECKING_LABEL, disabled: true, reason: "Checking whether this person's sign-in can be disabled here", menu: true });
    else if (controls.signIn === "enable") actions.push({ id: "sign-in", label: "Enable sign-in", disabled: false, menu: true });
    else if (controls.signIn === "disable") actions.push({ id: "sign-in", label: "Disable sign-in", disabled: false, reason: `Leaver: stops them signing in to ${PRODUCT.name}`, menu: true, destructive: true, confirm: disableSignInConfirm(name, COMPANY_NAME) });
  }
  if (controls.deactivate && identity.allowed) {
    actions.push({ id: "deactivate", label: u.active ? "Deactivate" : "Reactivate", disabled: false, menu: true, destructive: u.active, confirm: u.active ? `Deactivate ${name}? They lose access to ${COMPANY_NAME} straight away.` : undefined });
  }
  return { support: false, note: identity.reason && !ctx.signInChecking ? identity.reason : null, actions };
}
export type StatusView = { tone: StatusTone; text: string; testId?: string };
/** The real Status cell's order of precedence. */
export function statusOf(u: SeedUser, o: { checking: boolean; state: SignInState | undefined }): StatusView {
  const isSelf = u.id === ME;
  if (u.support) return { tone: "warn", text: `Tolra support${u.expiresAt ? `, until ${fmtDateTime(u.expiresAt)}` : ""}` };
  if (!u.active) return { tone: "neutral", text: "Deactivated" };
  if (o.checking && !isSelf) return { tone: "neutral", text: SIGN_IN_CHECKING_LABEL, testId: "sign-in-checking" };
  const off = signInBadge(o.state);
  if (off) return { tone: "danger", text: off, testId: "sign-in-disabled" };
  if (u.mustChange) return { tone: "warn", text: "Must change password" };
  if (!u.lastLogin) return { tone: "neutral", text: "Not signed in yet" };
  return { tone: "ok", text: "Active" };
}
/** The real row rule (components/time/on-site-only.tsx, clock-in-off-site.tsx, page.tsx): the two clock-in switches are for an active person who is not Tolra support, each one only when the database has its migration (075, 114). Now drawn in the Edit user sheet. */
export const clockSwitchesFor = (u: Pick<SeedUser, "active" | "support">, db: { has075: boolean; has114: boolean }) => {
  const person = u.active && !u.support;
  return { onSite: person && db.has075, offSite: person && db.has114 };
};
export const pagesOf = (u: Pick<SeedUser, "role" | "secondary" | "hidden">) => {
  const available = sectionsForRoles([u.role, u.secondary]);
  const hiddenCount = available.filter((section) => u.hidden.includes(section.key)).length;
  return hiddenCount ? `${available.length - hiddenCount} of ${available.length}` : "All";
};
export const overviewOf = (rows: readonly SeedUser[]): AdminMfaOverview | null => parseAdminMfaOverview({
  require_admin_mfa: false, can_require: false,
  admins: rows.filter((r) => r.mfa).map((r) => ({ user_id: r.id, enrolled: r.mfa!.enrolled, enrolment_required: r.mfa!.enrolmentRequired })),
});

export type AddValues = { fullName: string; email: string; username: string; role: Role; secondary: Role | ""; hidden: string[]; password: string; mustChange: boolean };
export type AddErrors = Partial<Record<"fullName" | "email" | "username" | "password" | "form", string>>;
/** page.tsx submitAdd: the same checks in the same order, each shown beside its field (the real page shows the first one in a toast). */
export function validateAdd(v: AddValues): AddErrors {
  const e: AddErrors = {};
  const username = normaliseUsername(v.username);
  const email = v.email.trim();
  if ((!v.fullName.trim() || !email) && !username) {
    e.form = ADD_NEEDS_PERSON;
    if (!v.fullName.trim()) e.fullName = REQUIRED_UNLESS_USERNAME;
    if (!email) e.email = REQUIRED_UNLESS_USERNAME;
  }
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) e.email = EMAIL_PROBLEM;
  if (username && !isValidUsername(username)) e.username = `Username: ${USERNAME_RULES}`;
  const problem = email ? passwordProblem(v.password) : null;
  if (problem) e.password = problem;
  return e;
}
export type EditValues = { fullName: string; role: Role; secondary: Role | ""; username: string; hidden: string[]; inspector: boolean; onSite?: boolean; offSite?: boolean };
export type EditErrors = Partial<Record<"fullName" | "username", string>>;
/** page.tsx submitEdit: the username rule, then the display name rule only when the name changed. */
export function validateEdit(v: EditValues, original: Pick<SeedUser, "fullName">): EditErrors {
  const e: EditErrors = {};
  const username = normaliseUsername(v.username);
  if (username && !isValidUsername(username)) e.username = `Username: ${USERNAME_RULES}`;
  const fullName = normaliseDisplayName(v.fullName);
  if (fullName !== original.fullName) { const problem = displayNameProblem(fullName); if (problem) e.fullName = `Display name: ${problem}`; }
  return e;
}
/** What Save would change (the real patch), as words for the preview toast. */
export function editChanges(v: EditValues, original: SeedUser, o: { flagsError: boolean }): string[] {
  const out: string[] = [];
  if (normaliseDisplayName(v.fullName) !== original.fullName) out.push("display name");
  if (v.role !== original.role) out.push("role");
  const secondary = v.secondary && v.secondary !== v.role ? v.secondary : "";
  if (secondary !== original.secondary) out.push("second role");
  if (normaliseUsername(v.username) !== original.username) out.push("username");
  if ([...v.hidden].sort().join() !== [...original.hidden].sort().join()) out.push("page access");
  if (!o.flagsError && v.inspector !== original.inspector) out.push("inspection setting");
  if (v.onSite !== undefined && v.onSite !== original.onSite) out.push("on site only");
  if (v.offSite !== undefined && v.offSite !== original.offSite) out.push("off-site clock-in");
  return out;
}
export const passwordForm = (password: string): { password?: string } => { const p = passwordProblem(password); return p ? { password: p } : {}; };
export type InspectorValues = { mode: "add" | "remove"; personId: string; scope: string; reason: string };
export type InspectorErrors = Partial<Record<"person" | "reason" | "scope", string>>;
/** components/authorised-inspectors.tsx submit(): choose someone, a reason of 10 to 500 characters, a scope of up to 200. */
export function validateInspector(v: InspectorValues): InspectorErrors {
  const e: InspectorErrors = {};
  if (v.mode === "add" && !v.personId) e.person = "Choose who to add.";
  const reason = v.reason.trim();
  if (reason.length < REASON_MIN) e.reason = `Give the reason (at least ${REASON_MIN} characters), for example the training or experience it rests on.`;
  else if (reason.length > REASON_MAX) e.reason = `The reason is up to ${REASON_MAX} characters.`;
  if (v.mode === "add" && v.scope.trim().length > SCOPE_MAX) e.scope = `The scope is up to ${SCOPE_MAX} characters.`;
  return e;
}
export const eligibleForList = (u: SeedUser) => u.active && !u.support && [u.role, u.secondary].some((r) => r === "admin" || r === "office" || r === "workshop");

/* ---------- local pieces ---------- */
const SCREENS: Array<{ v: Screen; label: string }> = [
  { v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No users yet" },
  { v: "checking", label: "Sign-in and two-step still checking" }, { v: "signin-unreadable", label: "Sign-in answer unreadable" }, { v: "mfa-unreadable", label: "Two-step status unreadable" },
  { v: "flags-error", label: "Inspection flags failed to load" }, { v: "access-loading", label: "Other-company access loading" }, { v: "access-error", label: "Other-company access failed" },
];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: titleCase(r) }));
function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore((cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => window.matchMedia(query).matches, () => fallback);
}
const dash = <span className={s.none} aria-label="None">-</span>;
/** An address may break after its "@" (never in the middle of a word). */
const mail = (email: string) => { const at = email.indexOf("@"); return at < 0 ? email : <>{email.slice(0, at + 1)}<wbr />{email.slice(at + 1)}</>; };

type Dlg =
  | { kind: "add" } | { kind: "edit"; id: string } | { kind: "password"; id: string } | { kind: "shown" }
  | { kind: "confirm"; id: string; action: RowAction } | { kind: "inspector"; mode: "add" | "remove"; personId?: string };

export default function UsersPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  const [has083, setHas083] = useState(true);
  const [has075, setHas075] = useState(true);
  const [has114, setHas114] = useState(true);
  const [multi, setMulti] = useState(true);
  const [timer, setTimer] = useState<number | null>(null);
  const wide = useMedia(DESK_QUERY, true);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); }, [toast]);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);

  const loaded = screen !== "loading" && screen !== "error" && screen !== "empty";
  const rows = useMemo(() => (loaded ? SEED_USERS : []), [loaded]);
  const checking = screen === "checking";
  const signIn = useMemo(() => new Map<string, SignInState>(checking || screen === "signin-unreadable" ? [] : rows.filter((r) => r.signIn).map((r) => [r.id, r.signIn!])), [rows, checking, screen]);
  const shielded = useMemo(() => new Map<string, ProtectedState>(checking || screen === "signin-unreadable" ? [] : rows.filter((r) => r.shield).map((r) => [r.id, r.shield!])), [rows, checking, screen]);
  const mfa = useMemo(() => (checking || screen === "mfa-unreadable" ? null : overviewOf(rows)), [rows, checking, screen]);
  const flagsError = screen === "flags-error" ? FLAGS_FALLBACK : null;
  const ctx: Context = useMemo(() => ({ signInChecking: checking, protectedUnavailable: screen === "signin-unreadable", signIn, shielded, lastAdmin: (u) => isLastAdminOf(rows, u) }), [checking, screen, signIn, shielded, rows]);
  const missingNames = useMemo(() => countMissingNames(rows.filter((r) => r.active).map((r) => ({ fullName: r.fullName, support: r.support }))), [rows]);
  const mfaRule = useMemo(() => {
    if (!mfa) return null;
    const names = new Map(rows.map((r) => [r.id, nameOf(r)]));
    return adminMfaRuleMessage(mfa, (id) => names.get(id) ?? "An admin");
  }, [mfa, rows]);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseUsers(role);
  const mfaChecking = checking;
  const find = (id: string) => SEED_USERS.find((u) => u.id === id)!;
  const retry = () => { setScreen("loading"); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample users shown again. No server was contacted." }); }, 700)); };
  const resetAll = () => { setScreen("ready"); setRole("admin"); setHas083(true); setHas075(true); setHas114(true); setMulti(true); setDlgState(null); toast.clear(); };
  const pickScreen = (v: Screen) => { toast.clear(); setDlgState(null); setScreen(v); };
  const run = (u: SeedUser, a: RowAction) => {
    const name = nameOf(u);
    if (a.id === "edit") return setDlg({ kind: "edit", id: u.id });
    if (a.id === "password") return setDlg({ kind: "password", id: u.id });
    if (a.confirm) return setDlg({ kind: "confirm", id: u.id, action: a });
    if (a.id === "sign-in") return preview(`${name} would be able to sign in again.`);
    if (a.id === "deactivate") return preview(`${name} would be reactivated.`);
  };
  const showNotices = loaded;
  /** Only a message that asks for something counts: the missing-names note, and the two-step line unless it is the "all set" one or the still-checking one. */
  const mfaNeedsLook = !(mfaRule?.tone === "ok") && !(mfaChecking && !mfaRule);
  const attentionCount = (missingNames ? 1 : 0) + (mfaNeedsLook ? 1 : 0);
  const attentionSummary = attentionCount ? `${attentionCount} ${attentionCount === 1 ? "thing needs" : "things need"} attention` : mfaChecking && !mfaRule ? "Checking two-step sign-in status" : "Nothing needs attention";
  const inspectorsShown = has083 && loaded && !flagsError;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="users-preview" data-role={role}>
      <PreviewBar data-testid="preview-bar" controls={
        <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
          <div className={s.dock}>
            <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated, nothing is granted and no request is made.</p>
            <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
            <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={(v) => { setRole(v); setDlgState(null); toast.clear(); }} />
            <p className={s.dockLabel}>Screen state</p>
            <div className={s.dockStates} role="group" aria-label="Screen state">
              {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => pickScreen(x.v)}>{x.label}</button>)}
            </div>
            <p className={s.dockLabel}>Database features</p>
            <Switch label="Other companies" hint="Admins of more than one company (066)." checked={multi} onChange={(on) => { setMulti(on); setDlgState(null); }} data-testid="dock-multi" />
            <Switch label="Authorised inspectors list" hint="Migration 083." checked={has083} onChange={(on) => { setHas083(on); setDlgState(null); }} data-testid="dock-083" />
            <Switch label="On site only" hint="Migration 075." checked={has075} onChange={setHas075} data-testid="dock-075" />
            <Switch label="Off-site clock-in" hint="Migration 114." checked={has114} onChange={setHas114} data-testid="dock-114" />
            <p className={s.dockLabel}>Sample dialog</p>
            <Button size="sm" variant="secondary" data-testid="dock-shown" onClick={() => setDlg({ kind: "shown" })}>Show &quot;Give these details&quot;</Button>
            <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
          </div>
        </Popover>
      } />
      <PageHeader
        title={<span title={denied ? undefined : USERS_INTRO_GENERIC} data-testid="users-title">{denied ? "Access Denied" : "User Management"}</span>}
        description={denied ? "Redirecting you back to the dashboard." : <><span className={srOnly}>{USERS_INTRO_GENERIC} </span>{USERS_INTRO_RULE}</>}
        actions={denied ? undefined : <Button variant="primary" data-testid="new-user" onClick={() => setDlg({ kind: "add" })}>New user</Button>}
      />

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <p className={s.deniedNote}>Preview only: no redirect happens here. User Management is for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : (
        <>
          {screen === "error" ? <FailedState headingLevel={2} title="Couldn’t load users." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" /> : null}

          {showNotices ? (
            <Disclosure
              className={cx(s.attn, attentionCount ? s.attnWarn : s.attnQuiet)}
              data-testid="attention"
              summary={<span data-testid="attention-summary">{attentionSummary}</span>}
            >
              <ul className={s.attnList}>
                {missingNames ? (
                  <li data-testid="missing-names">
                    {missingNames === 1 ? "1 person has" : `${missingNames} people have`} no display name, so the Job Board can&apos;t say who a job is assigned to. Use Edit to add one, or ask them to add it in Account Settings.
                  </li>
                ) : null}
                <li data-testid="admin-mfa-rule" data-tone={mfaRule?.tone ?? (mfaChecking ? "neutral" : "warn")}>
                  {mfaRule ? mfaRule.text : mfaChecking ? "Checking two-step sign-in status for admins…" : "Two-step sign-in status for admins isn't available yet."}
                </li>
              </ul>
            </Disclosure>
          ) : null}

          <h2 className={s.srOnly}>People</h2>
          <p className={s.srOnly} role="status">{loaded ? `${rows.length} ${rows.length === 1 ? "person" : "people"} shown` : ""}</p>
          {screen === "loading" ? <LoadingState label="Loading users" rows={5} />
            : screen === "empty" ? <EmptyState headingLevel={3} title="No users yet" detail={usersEmptyHint()} action={<Button variant="primary" onClick={() => setDlg({ kind: "add" })}>New user</Button>} />
            : screen === "error" ? null
            : !wide ? (
              <div className={s.cards} data-testid="view-cards">
                {rows.map((u) => <UserCard key={u.id} u={u} ctx={ctx} mfa={mfa} run={run} />)}
              </div>
            ) : (
              <ScrollTable label="Users" className={s.table}>
                <thead><tr>
                  <th className={s.thFirst}>Name</th><th>Username</th><th>Roles</th><th>Pages</th><th>Status</th><th>Last login</th><th className={cx(s.right, s.thActions)}>Actions</th>
                </tr></thead>
                <tbody>{rows.map((u) => <UserRow key={u.id} u={u} ctx={ctx} mfa={mfa} run={run} />)}</tbody>
              </ScrollTable>
            )}

          {inspectorsShown ? <Inspectors rows={rows} onAdd={() => setDlg({ kind: "inspector", mode: "add" })} onRemove={(id) => setDlg({ kind: "inspector", mode: "remove", personId: id })} /> : null}

          {loaded ? (
            <div className={s.notes}>
              <p data-testid="sign-in-help">{SIGN_IN_HELP}</p>
              <p>Forgotten passwords: staff can use &quot;Forgot password?&quot; on the sign-in page, you can e-mail them a reset link, or you can set a new one here. Page access hides a page from that person; for quotes, invoices, sales orders, purchase orders, RFQs and emails their data is blocked too.</p>
              {has114 && rows.length ? <p data-testid="clock-in-off-site-note">A worker who forgets to clock out cannot clock out from home while locked; the office corrects it or an admin marks them off-site.</p> : null}
            </div>
          ) : null}
        </>
      )}

      {dlg?.kind === "add" && !denied ? <UserSheet key="add" mode="add" multi={multi} has083={has083} has075={has075} has114={has114} flagsError={flagsError} access={screen} onClose={() => setDlg(null)} preview={preview} /> : null}
      {dlg?.kind === "edit" && !denied ? <UserSheet key={`edit-${dlg.id}`} mode="edit" user={find(dlg.id)} multi={multi} has083={has083} has075={has075} has114={has114} flagsError={flagsError} access={screen} onClose={() => setDlg(null)} preview={preview} /> : null}
      {dlg?.kind === "password" && !denied ? <PasswordSheet key={dlg.id} user={find(dlg.id)} onClose={() => setDlg(null)} preview={preview} /> : null}
      {dlg?.kind === "shown" ? <ShownSheet onClose={() => setDlg(null)} preview={preview} /> : null}
      {dlg?.kind === "confirm" && !denied ? <ConfirmSheet action={dlg.action} user={find(dlg.id)} onClose={() => setDlg(null)} preview={preview} /> : null}
      {dlg?.kind === "inspector" && !denied ? <InspectorSheet key={`${dlg.mode}-${dlg.personId ?? ""}`} mode={dlg.mode} personId={dlg.personId} rows={rows} onClose={() => setDlg(null)} preview={preview} /> : null}
    </div>
  );
}

/* ---------- the table: one row per person (the clock-in switches are in the Edit user sheet) ---------- */
type RowProps = { u: SeedUser; ctx: Context; mfa: AdminMfaOverview | null; run: (u: SeedUser, a: RowAction) => void };

function NameBlock({ u, children }: { u: SeedUser; children?: ReactNode }) {
  const isSelf = u.id === ME;
  return (
    <span className={s.nameCell}>
      <span className={cx(typeScale.name, s.name, !u.active && s.nameOff)}>{u.fullName || <span className={s.noName}>No name</span>}{isSelf ? <span className={s.you}> (you)</span> : null}</span>
      <span className={cx(typeScale.secondary, s.email)}>{mail(u.email)}</span>
      {!u.fullName && !u.support ? <span data-testid="no-display-name" className={s.nameBadge}><StatusBadge tone="warn">No display name</StatusBadge></span> : null}
      {children}
    </span>
  );
}
/** One role pill style for every role (the first role, and "+ second role" in the same pill); the two-step state is a dot and a word under them. */
function RoleBlock({ u, mfa }: { u: SeedUser; mfa: AdminMfaOverview | null }) {
  const show = Boolean(mfa && u.active && !u.support && holdsAdmin({ role: u.role, secondary_role: u.secondary || null }));
  const status = show ? mfa!.admins.get(u.id) : undefined;
  return (
    <span className={s.roleCell}>
      <span className={s.roleRow}>
        <span className={s.role} data-testid="role-pill">{titleCase(u.role)}</span>
        {u.secondary ? <span className={s.role} data-testid="role-pill">+ {titleCase(u.secondary)}</span> : null}
      </span>
      {show ? <span data-testid="admin-mfa-status"><StatusBadge mode="text" tone={status?.enrolled ? "ok" : status ? "warn" : "neutral"} className={s.mfaWord}>{adminMfaStatusLabel(status)}</StatusBadge></span> : null}
    </span>
  );
}
function StatusBlock({ u, ctx }: { u: SeedUser; ctx: Context }) {
  const v = statusOf(u, { checking: ctx.signInChecking, state: ctx.signIn.get(u.id) });
  return <span data-testid={v.testId}><StatusBadge mode="text" tone={v.tone} className={s.statusWord}>{v.text}</StatusBadge></span>;
}
/** "23/11/2026, 08:41" as the date over the time (the same text, the same order). */
function LastLogin({ value }: { value: string | null }) {
  if (!value) return <>Never</>;
  const [date, time] = fmtDateTime(value).split(", ");
  return <span className={s.when}><span>{date}</span>{time ? <span className={cx(typeScale.secondary, s.whenTime)}>{time}</span> : null}</span>;
}
function UserRow({ u, ctx, mfa, run }: RowProps) {
  return (
    <tr data-testid="user-row" data-user={nameOf(u)} data-inactive={!u.active || undefined}>
      <td className={s.tdFirst}><NameBlock u={u} /></td>
      <td className={cx(s.mono, s.tdUser)}>{u.username || dash}</td>
      <td className={s.tdRoles}><RoleBlock u={u} mfa={mfa} /></td>
      <td className={cx(s.nowrap, s.muted2)}>{pagesOf(u)}</td>
      <td className={s.tdStatus}><StatusBlock u={u} ctx={ctx} /></td>
      <td className={cx(s.nowrap, tabularNumbers)}><LastLogin value={u.lastLogin} /></td>
      <td className={cx(s.right, s.tdActions)}><div className={s.rowActions}><Actions u={u} ctx={ctx} run={run} /></div></td>
    </tr>
  );
}
function UserCard({ u, ctx, mfa, run }: RowProps) {
  const name = nameOf(u);
  return (
    <article className={cx(s.card, !u.active && s.cardOff)} data-testid="user-row" aria-label={name} data-user={name}>
      <div className={s.cardHead}><NameBlock u={u} /></div>
      <dl className={s.dl}>
        <div><dt>Username</dt><dd className={s.mono}>{u.username || dash}</dd></div>
        <div><dt>Pages</dt><dd>{pagesOf(u)}</dd></div>
        <div className={s.dlWide}><dt>Roles</dt><dd><RoleBlock u={u} mfa={mfa} /></dd></div>
        <div><dt>Status</dt><dd><StatusBlock u={u} ctx={ctx} /></dd></div>
        <div><dt>Last login</dt><dd className={tabularNumbers}>{u.lastLogin ? fmtDateTime(u.lastLogin) : "Never"}</dd></div>
      </dl>
      <div className={s.cardActions}><Actions u={u} ctx={ctx} run={run} /></div>
    </article>
  );
}

/** ONE primary action per row (Edit, or Switch off support access on a support row); Set password and everything else sit in one "More" menu named for the person. */
function Actions({ u, ctx, run }: { u: SeedUser; ctx: Context; run: RowProps["run"] }) {
  const plan = planRowActions(u, ctx);
  const name = nameOf(u);
  if (plan.support) {
    const a = plan.actions[0];
    return <Button size="sm" variant="secondary" className={s.danger} data-action={a.label} aria-label={`${a.label}, ${name}`} onClick={() => run(u, a)}>{a.label}</Button>;
  }
  const direct = plan.actions.filter((a) => !a.menu);
  const menu = plan.actions.filter((a) => a.menu);
  return (
    <>
      <span className={s.btnRow}>
        {direct.map((a) => (
          <Button key={a.id} size="sm" variant="secondary" disabled={a.disabled} data-action={a.label} aria-label={`${a.label} ${name}`} onClick={() => run(u, a)}>{a.label}</Button>
        ))}
        {menu.length ? (
          <RowMenu label={`More actions for ${name}`} items={menu.map((a) => ({ id: a.id, label: a.label, hint: a.reason ?? undefined, disabled: a.disabled, destructive: a.destructive, testId: a.id === "reset-email" ? "send-reset-email" : undefined, onSelect: () => run(u, a) }))} />
        ) : null}
      </span>
      {plan.note ? <span data-testid="protected-login" className={s.rowNote}>{plan.note}</span> : null}
    </>
  );
}

/* ---------- a row menu named for its person (the shared Menu names every menu by its visible text; built locally, listed as a gap) ---------- */
type RowMenuItem = { id: string; label: string; hint?: string; disabled?: boolean; destructive?: boolean; testId?: string; onSelect: () => void };
function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<LayerPosition | null>(null);
  const [mounted, setMounted] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => { setMounted(true); }, []);
  const close = useCallback((refocus = false) => { setOpen(false); setPos(null); if (refocus) trigger.current?.focus(); }, []);
  const measure = useCallback(() => {
    const a = trigger.current; const l = layer.current;
    if (!a || !l) return;
    setPos(placeLayer(a.getBoundingClientRect(), { width: l.offsetWidth, height: l.scrollHeight + 10 }, { width: window.innerWidth, height: window.innerHeight }));
  }, []);
  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (layer.current?.contains(t) || trigger.current?.contains(t)) return; close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(true); } };
    window.addEventListener("pointerdown", onDown, true); window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [open, close, measure]);
  const buttons = () => Array.from(layer.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const disabledFlags = items.map((i) => !!i.disabled);
  const openAndFocus = (which: "first" | "last") => {
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => { const i = which === "first" ? nextMenuIndex(-1, disabledFlags, "Home") : nextMenuIndex(0, disabledFlags, "End"); if (i >= 0) buttons()[i]?.focus(); }));
  };
  return (
    <>
      <Button ref={trigger} size="sm" variant="secondary" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : openAndFocus("first"))}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); openAndFocus("first"); } if (e.key === "ArrowUp") { e.preventDefault(); openAndFocus("last"); } }}>
        More
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.6 5 6.6 8 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </Button>
      {mounted && open ? createPortal(
        <div ref={layer} id={id} role="menu" aria-label={label} className={cx(premiumTokens, s.menu)}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden", ["--origin" as string]: pos?.origin }}
          onKeyDown={(e) => {
            const idx = buttons().indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") { e.preventDefault(); const n = nextMenuIndex(idx, disabledFlags, e.key); if (n >= 0) buttons()[n]?.focus(); }
            if (e.key === "Tab") close(true);
          }}>
          {items.map((it, i) => (
            <div key={it.id} role="none">
              {it.destructive && i > 0 && !items[i - 1].destructive ? <div className={s.menuSep} role="separator" /> : null}
              <button type="button" role="menuitem" tabIndex={-1} aria-disabled={it.disabled || undefined} aria-describedby={it.hint ? `${id}-${it.id}` : undefined} data-testid={it.testId}
                className={cx(s.menuItem, it.destructive && s.menuDanger)} onClick={() => { if (it.disabled) return; close(true); it.onSelect(); }}>
                <span>{it.label}</span>
                {it.hint ? <span id={`${id}-${it.id}`} className={s.menuHint}>{it.hint}</span> : null}
              </button>
            </div>
          ))}
        </div>,
        trigger.current?.closest("main") ?? document.body,
      ) : null}
    </>
  );
}

/* ---------- Inspectors (083) ---------- */
function Inspectors({ rows, onAdd, onRemove }: { rows: SeedUser[]; onAdd: () => void; onRemove: (id: string) => void }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const who = (id: string | null) => (id ? (byId.get(id) ? nameOf(byId.get(id)!) : "Former member") : "System");
  const onList = rows.filter((r) => r.inspector && !r.support);
  const addable = rows.filter((r) => eligibleForList(r) && !r.inspector);
  const latest = new Map<string, InspectorChange>();
  for (const h of [...SEED_HISTORY].sort((a, b) => (a.changedAt < b.changedAt ? -1 : 1))) { if (h.change === "added") latest.set(h.userId, h); else latest.delete(h.userId); }
  const [open, setOpen] = useState(false);
  return (
    <section className={s.inspectors} data-testid="authorised-inspectors" aria-labelledby="insp-h">
      <div className={s.inspHead}>
        <div>
          <h2 id="insp-h" className={cx(typeScale.section, s.h2)}>Inspectors</h2>
          <p className={s.inspText}>Only the people on this list can record an inspection pass or co-sign as the inspector. Each change needs a reason and is kept.</p>
        </div>
        <Button variant="secondary" disabled={!addable.length} onClick={onAdd}>Add inspector</Button>
      </div>
      <div className={s.inspList}>
        {onList.length ? (
          <ul>
            {onList.map((p) => {
              const since = latest.get(p.id);
              return (
                <li key={p.id} data-testid="inspector-row" className={s.inspRow}>
                  <div className={s.inspWho}>
                    <p className={s.inspName}>{nameOf(p)}</p>
                    <p className={s.inspMeta}>{since ? `Added ${fmtDateTime(since.changedAt)} by ${who(since.changedBy)}` : "Added before the list's history began"}{since?.scope ? ` · Scope: ${since.scope}` : ""}</p>
                    {since ? <p className={s.inspReason}>Reason: {since.reason}</p> : null}
                  </div>
                  <Button size="sm" variant="secondary" aria-label={`Remove ${nameOf(p)} from the inspectors list`} onClick={() => onRemove(p.id)}>Remove</Button>
                </li>
              );
            })}
          </ul>
        ) : <p className={s.inspEmpty}>Nobody is on the list yet, so nobody can record an inspection pass.</p>}
      </div>
      <Disclosure summary={`History (${SEED_HISTORY.length})`} open={open} onToggle={setOpen} data-testid="inspector-history">
        <ul className={s.histList}>
          {SEED_HISTORY.map((h) => (
            <li key={h.id} data-testid="inspector-history-row">
              <span className={cx(s.histWhen, tabularNumbers)}>{fmtDateTime(h.changedAt)}</span> · {who(h.userId)} {h.change === "added" ? "added" : "removed"} by {who(h.changedBy)}{h.scope ? ` (scope: ${h.scope})` : ""}: {h.reason}
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}

/* ---------- sheets ---------- */
const failCount = (n: number) => (n === 1 ? "1 field needs attention" : `${n} fields need attention`);
const firstInvalid = (root: HTMLElement | null) => requestAnimationFrame(() => root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());

/** Tick boxes for the sections the person's roles give them; unticked = hidden for them. */
function PageAccess({ roles, hidden, onChange }: { roles: (Role | "")[]; hidden: string[]; onChange: (h: string[]) => void }) {
  const sections = sectionsForRoles(roles);
  if (!sections.length) return <p className={s.hint}>This role has no optional pages.</p>;
  return (
    <div className={s.pages}>
      {sections.map((section) => {
        const visible = !hidden.includes(section.key);
        return (
          <label key={section.key} className={s.pageRow}>
            <Checkbox checked={visible} onChange={() => onChange(visible ? [...hidden, section.key] : hidden.filter((k) => k !== section.key))} />
            <span>{section.label}</span>
          </label>
        );
      })}
    </div>
  );
}
function CompanyAccessFields({ drafts, onChange, self, loading, error }: { drafts: CompanyDraft[]; onChange: (d: CompanyDraft[]) => void; self?: boolean; loading?: boolean; error?: string | null }) {
  if (loading) return <div role="status" aria-label="Loading their access to your other companies" className={s.accessLoading}><i /><i /></div>;
  if (error) return <p role="alert" className={s.inlineError}>{error}</p>;
  if (!drafts.length) return null;
  const update = (index: number, next: Partial<CompanyDraft>) => onChange(drafts.map((d, i) => (i === index ? { ...d, ...next } : d)));
  return (
    <div role="group" aria-labelledby="g-companies" data-testid="company-access" className={s.group}>
      <h3 id="g-companies" className={s.legend}>Other companies you manage</h3>
      <div className={s.companies}>
        {drafts.map((d, index) => (
          <div key={d.organizationId} data-testid="company-access-row" className={s.company}>
            <label className={s.companyName}>
              <Checkbox aria-label={`Access to ${d.name}`} checked={d.on} disabled={d.locked || (self && d.on)} onChange={(e) => update(index, { on: e.target.checked })} />
              <span>{d.name}</span>{d.locked ? <StatusBadge tone="warn">Tolra support</StatusBadge> : null}
            </label>
            <Select aria-label={`Role in ${d.name}`} value={d.role} disabled={!d.on || d.locked} onChange={(e) => update(index, { role: e.target.value as Role, secondary: d.secondary === e.target.value ? "" : d.secondary })}>
              {ROLES.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
            </Select>
            <Select aria-label={`Also has role in ${d.name}`} value={d.secondary} disabled={!d.on || d.locked} onChange={(e) => update(index, { secondary: e.target.value as Role | "" })}>
              <option value="">No second role</option>{ROLES.filter((r) => r !== d.role).map((r) => <option key={r} value={r}>+ {titleCase(r)}</option>)}
            </Select>
          </div>
        ))}
      </div>
      <p className={s.hint}>Tick a company to give this login access there with the role shown; untick to remove it. Everyone keeps at least one company, and each change is recorded in that company&apos;s activity.{self ? " You can't remove your own access; another admin can." : ""}</p>
    </div>
  );
}
function PasswordField({ value, onChange, error, label = "Password" }: { value: string; onChange: (v: string) => void; error?: string; label?: string }) {
  return (
    <Field label={label} hint={PASSWORD_RULES} error={error}>
      <div className={s.pwRow}>
        <Input value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" spellCheck={false} className={s.mono} placeholder="Type a password or generate one" name="password" />
        <Button variant="secondary" onClick={() => onChange(generatePassword())}>Generate</Button>
      </div>
    </Field>
  );
}
function MustChange({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={s.checkRow}>
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><span className={s.checkTitle}>Must change password at first sign-in</span><span className={s.checkHint}>Recommended. They choose their own password before they can use {PRODUCT.name}.</span></span>
    </label>
  );
}
const Callout = ({ children, testId }: { children: ReactNode; testId?: string }) => <p className={s.sheetWarn} data-testid={testId}>{children}</p>;

/** Add user and Edit user: the real fields in the real order, grouped; checks run on submit and then live, each beside its field. */
function UserSheet({ mode, user, multi, has083, has075, has114, flagsError, access, onClose, preview }: {
  mode: "add" | "edit"; user?: SeedUser; multi: boolean; has083: boolean; has075: boolean; has114: boolean; flagsError: string | null; access: Screen; onClose: () => void; preview: (d: string) => void;
}) {
  const adding = mode === "add";
  const self = user?.id === ME;
  const [v, setV] = useState({
    fullName: user?.fullName ?? "", email: "", username: user?.username ?? "", role: (user?.role ?? "workshop") as Role, secondary: (user?.secondary ?? "") as Role | "",
    hidden: user?.hidden ?? ([] as string[]), password: adding ? generatePassword() : "", mustChange: true, inspector: user?.inspector ?? false,
    onSite: user?.onSite ?? false, offSite: user?.offSite ?? false,
  });
  /** The real row rule: the two clock-in switches are for an active person who is not Tolra support, and each one only when the database has its migration (075, 114). */
  const { onSite: clockOn, offSite: clockOff } = adding || !user ? { onSite: false, offSite: false } : clockSwitchesFor(user, { has075, has114 });
  const accessRows = user?.access ?? MY_COMPANIES;
  const [drafts, setDrafts] = useState<CompanyDraft[]>(() => (multi ? draftCompanies(adding ? MY_COMPANIES : accessRows) : []));
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>(adding ? 'input[name="fullName"]' : 'input[name="displayName"]')?.focus(); }, [adding]);
  const addErrors = useMemo(() => (adding ? validateAdd(v) : {}), [adding, v]) as AddErrors;
  const editErrors = useMemo(() => (!adding && user ? validateEdit(v, user) : {}), [adding, user, v]) as EditErrors;
  const errors = (adding ? addErrors : editErrors) as Record<string, string | undefined>;
  const shown = (k: string) => (submitted || touched[k] ? errors[k] : undefined);
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((p) => ({ ...p, [k]: value }));
  const accessLoading = !adding && multi && access === "access-loading";
  const accessError = !adding && multi && access === "access-error" ? ACCESS_LOAD_FALLBACK : null;
  const roles: (Role | "")[] = [v.role, v.secondary];
  const names: Record<string, string> = { fullName: adding ? "Full name" : "Display name", email: "Email", username: "Username for sign-in", password: "Password" };
  const failing = Object.keys(errors).filter((k) => k !== "form" && submitted && errors[k]);
  const admin = adding ? v.role === "admin" || v.secondary === "admin"
    : user ? becomesAdmin({ role: user.role, secondary_role: user.secondary || null, active: user.active }, { role: v.role, secondary_role: v.secondary || null, active: user.active }) : false;
  const inspectorRoles = roles.includes("admin") || roles.includes("office") || roles.includes("workshop");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).some((k) => errors[k])) { firstInvalid(form.current); return; }
    if (adding) {
      const who = v.fullName.trim() || normaliseUsername(v.username);
      const extra = planCompanyChanges([], drafts).length;
      onClose();
      preview(`${who} would be added as ${titleCase(v.role)}${v.secondary ? ` + ${titleCase(v.secondary)}` : ""}${extra ? `, with access to ${extra} other ${extra === 1 ? "company" : "companies"}` : ""}. No e-mail would be sent.`);
      return;
    }
    const changed = editChanges({ ...v, onSite: clockOn ? v.onSite : undefined, offSite: clockOff ? v.offSite : undefined }, user!, { flagsError: Boolean(flagsError) });
    const companies = accessLoading || accessError ? [] : planCompanyChanges(accessRows, drafts);
    if (companies.length) changed.push(`access to ${companies.length} other ${companies.length === 1 ? "company" : "companies"}`);
    onClose();
    if (changed.length) preview(`Changes to ${nameOf(user!)} would be saved: ${changed.join(", ")}.`);
  };
  const title = adding ? "Add user" : `Edit ${nameOf(user!)}`;
  const formId = adding ? "add-user-form" : "edit-user-form";
  return (
    <Sheet open size="md" title={title} description={adding ? "The account works straight away. Give them their username and password yourself; no email is sent." : user!.email} onClose={onClose} closeButton={false} testId={adding ? "dlg-add-user" : "dlg-edit-user"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form={formId} data-testid="save-user">{adding ? "Create user" : "Save changes"}</Button></>}>
      <form id={formId} ref={form} onSubmit={submit} noValidate className={s.form} aria-label={title}>
        {submitted && (failing.length || errors.form) ? (
          <div className={s.summary} role="alert" data-testid="form-summary">
            {errors.form ? <p>{errors.form}</p> : null}
            {failing.length ? <p>{failCount(failing.length)}: {failing.map((k) => names[k]).join(", ")}.</p> : null}
          </div>
        ) : null}
        <div role="group" aria-labelledby="g-person" className={s.group}>
          <h3 id="g-person" className={s.legend}>{adding ? "Person" : "Name and sign-in"}</h3>
          {adding ? (
            <div className={s.pair}>
              <Field label="Full name" required={!v.username.trim()} error={shown("fullName")}><Input name="fullName" autoComplete="off" value={v.fullName} onChange={(e) => set("fullName", e.target.value)} onBlur={blur("fullName")} /></Field>
              <Field label="Email" required={!v.username.trim()} error={shown("email")}><Input name="email" type="email" autoComplete="off" value={v.email} onChange={(e) => set("email", e.target.value)} onBlur={blur("email")} /></Field>
            </div>
          ) : (
            <Field label="Display name" hint="Shown on the Job Board, the schedule and in who-did-what. A login shared with another company can only be renamed by its owner." error={shown("fullName")}>
              <Input name="displayName" autoComplete="off" maxLength={80} placeholder="e.g. Dave Smith" value={v.fullName} onChange={(e) => set("fullName", e.target.value)} onBlur={blur("fullName")} />
            </Field>
          )}
          <Field label={adding ? "Username for sign-in" : "Username (sign-in)"} error={shown("username")}
            hint={adding ? `Optional. ${USERNAME_RULES} They can also sign in with their email. Already have a ${PRODUCT.name} login in another company? Enter just their username (name and email can stay empty) and they are added here with their existing password.`
              : `${USERNAME_RULES} Leave empty to remove it (they can still sign in with their email).`}>
            <Input name="username" maxLength={32} placeholder="e.g. jsmith" autoCapitalize="none" spellCheck={false} autoComplete="off" value={v.username} onChange={(e) => set("username", e.target.value)} onBlur={blur("username")} />
          </Field>
        </div>

        <div role="group" aria-labelledby="g-role" className={s.group}>
          <h3 id="g-role" className={s.legend}>Role</h3>
          <div className={s.pair}>
            <Field label="Role" hint={`${titleCase(v.role)}: ${ROLE_HELP[v.role]}.`}>
              <Select name="role" value={v.role} onChange={(e) => set("role", e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</Select>
            </Field>
            <Field label="Also has role" hint={adding ? "Optional second role, e.g. office + workshop." : undefined}>
              <Select name="secondary" value={v.secondary} onChange={(e) => set("secondary", e.target.value as Role | "")}>
                <option value="">None</option>{ROLES.filter((r) => r !== v.role).map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
              </Select>
            </Field>
          </div>
          {!adding && self ? <p className={s.hint}>{SELF_ADMIN_NOTE}</p> : null}
          {admin ? <Callout testId="admin-mfa-notice">{ADMIN_MFA_ONBOARDING_NOTICE}</Callout> : null}
        </div>

        {multi ? <CompanyAccessFields drafts={drafts} onChange={setDrafts} self={!adding && self} loading={accessLoading} error={accessError} /> : null}

        {!adding && inspectorRoles ? (
          <div role="group" aria-labelledby="g-insp" className={s.group}>
            <h3 id="g-insp" className={s.legend}>Inspections</h3>
            {has083 ? (
              <p data-testid="inspector-list-note" className={s.inspNote}>Can record inspections: {user!.inspector ? "yes" : "no"}<span className={s.hint}>Changed under Inspectors on this page, with a reason.</span></p>
            ) : (
              <label className={s.checkRow}>
                <Checkbox aria-label="Can record inspections" checked={!flagsError && (v.inspector || roles.includes("admin"))} disabled={roles.includes("admin") || !!flagsError} onChange={(e) => set("inspector", e.target.checked)} />
                <span><span className={s.checkTitle}>Can record inspections</span><span className={s.checkHint}>Passes, failures and concessions are recorded in their name. Admins always can; for everyone else this is off until you tick it.</span></span>
              </label>
            )}
            {!has083 && flagsError && (roles.includes("office") || roles.includes("workshop")) && !roles.includes("admin") ? (
              <div role="alert" data-testid="inspector-flags-error" className={s.inlineErrorRow}>
                <span>{flagsError} This setting can&apos;t be changed until it loads.</span>
                <Button size="sm" variant="secondary" onClick={() => preview("The inspection flags would be read again.")}>Retry</Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div role="group" aria-labelledby="g-pages" className={s.group}>
          <h3 id="g-pages" className={s.legend}>Pages they can open</h3>
          <PageAccess roles={roles} hidden={v.hidden} onChange={(h) => set("hidden", h)} />
        </div>

        {clockOn || clockOff ? (
          <div role="group" aria-labelledby="g-clock" className={s.group} data-testid="clock-in-settings">
            <h3 id="g-clock" className={s.legend}>Clock-in</h3>
            {clockOn ? (
              <label className={s.checkRow} data-testid="on-site-only">
                <Checkbox aria-label={ON_SITE_LABEL} aria-describedby="clock-on-hint" checked={v.onSite} onChange={(e) => set("onSite", e.target.checked)} />
                <span><span className={s.checkTitle}>{ON_SITE_LABEL}</span><span id="clock-on-hint" className={s.checkHint}>{ON_SITE_RULE}</span></span>
              </label>
            ) : null}
            {clockOff ? (
              <label className={s.checkRow} data-testid="clock-in-off-site">
                <Checkbox aria-label={OFF_SITE_LABEL} aria-describedby="clock-off-hint" checked={v.offSite} onChange={(e) => set("offSite", e.target.checked)} />
                <span><span className={s.checkTitle}>{OFF_SITE_LABEL}</span><span id="clock-off-hint" className={s.checkHint}>{OFF_SITE_RULE}</span></span>
              </label>
            ) : null}
          </div>
        ) : null}

        {adding ? (
          <div role="group" aria-labelledby="g-pw" className={s.group}>
            <h3 id="g-pw" className={s.legend}>Password</h3>
            <PasswordField value={v.password} onChange={(p) => set("password", p)} error={shown("password")} />
            <MustChange checked={v.mustChange} onChange={(m) => set("mustChange", m)} />
          </div>
        ) : null}
      </form>
      <p className={s.sheetNote}>{PREVIEW_ONLY_NOTE}</p>
    </Sheet>
  );
}

function PasswordSheet({ user, onClose, preview }: { user: SeedUser; onClose: () => void; preview: (d: string) => void }) {
  const [pw, setPw] = useState({ password: generatePassword(), mustChange: true });
  const [submitted, setSubmitted] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>('input[name="password"]')?.focus(); }, []);
  const errors = passwordForm(pw.password);
  const submit = (e: FormEvent) => {
    e.preventDefault(); setSubmitted(true);
    if (errors.password) { firstInvalid(form.current); return; }
    onClose(); preview(`A new password would be set for ${nameOf(user)}. Their old password would stop working straight away.`);
  };
  return (
    <Sheet open size="sm" title="Set a new password" description={`For ${nameOf(user)}. Their old password stops working straight away.`} onClose={onClose} closeButton={false} testId="dlg-password"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="password-form" data-testid="save-password">Set password</Button></>}>
      <form id="password-form" ref={form} onSubmit={submit} noValidate className={s.form} aria-label="Set a new password">
        {submitted && errors.password ? <p className={s.summary} role="alert">{failCount(1)}: Password.</p> : null}
        <PasswordField value={pw.password} onChange={(password) => setPw({ ...pw, password })} error={submitted ? errors.password : undefined} />
        <MustChange checked={pw.mustChange} onChange={(mustChange) => setPw({ ...pw, mustChange })} />
      </form>
      <p className={s.sheetNote}>{PREVIEW_ONLY_NOTE}</p>
    </Sheet>
  );
}

/** "Give {name} these details": the real dialog, opened only from Preview controls with obviously sample values (no account is created, nothing is copied). */
function ShownSheet({ onClose, preview }: { onClose: () => void; preview: (d: string) => void }) {
  return (
    <Sheet open size="sm" title="Give Sample Person these details" description={`This password is shown only now. ${PRODUCT.name} doesn't keep a copy.`} onClose={onClose} closeButton={false} testId="dlg-shown"
      footer={<><Button variant="secondary" onClick={() => { onClose(); preview("Nothing was copied."); }}>Copy password</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <dl className={s.creds}>
        <div><dt>Sign in with</dt><dd className={s.mono}>sample.person@fernhill.example</dd></div>
        <div><dt>Password</dt><dd className={s.mono}>SAMPLE-not-a-real-password</dd></div>
      </dl>
      <p className={s.hint}>They&apos;ll be asked to choose their own password when they first sign in.</p>
      <Callout testId="admin-mfa-notice">{ADMIN_MFA_ONBOARDING_NOTICE}</Callout>
      <p className={s.sheetNote}>Preview only. These are sample values: no account exists and nothing is stored.</p>
    </Sheet>
  );
}

/** The real page confirms with the browser's own box; here it is one sheet with the same words, then only the neutral toast. */
function ConfirmSheet({ action, user, onClose, preview }: { action: RowAction; user: SeedUser; onClose: () => void; preview: (d: string) => void }) {
  const name = nameOf(user);
  const outcome: Record<RowAction["id"], string> = {
    "support-off": "Tolra support access would be switched off.", "reset-email": `A password reset e-mail would be sent to ${name}.`, "reset-mfa": `Two-step sign-in would be reset for ${name}.`,
    "sign-in": `Sign-in would be disabled for ${name}.`, deactivate: `${name} would be deactivated.`, edit: "", password: "",
  };
  return (
    <Sheet open size="sm" title={action.label} description={action.confirm} onClose={onClose} closeButton={false} testId="dlg-confirm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={action.destructive ? "secondary" : "primary"} className={action.destructive ? s.danger : undefined} data-testid="confirm-action" onClick={() => { onClose(); preview(outcome[action.id]); }}>{action.label}</Button>
      </>}>
      <p className={s.sheetNote}>{PREVIEW_ONLY_NOTE}</p>
    </Sheet>
  );
}

function InspectorSheet({ mode, personId, rows, onClose, preview }: { mode: "add" | "remove"; personId?: string; rows: SeedUser[]; onClose: () => void; preview: (d: string) => void }) {
  const addable = rows.filter((r) => eligibleForList(r) && !r.inspector);
  const person = rows.find((r) => r.id === personId);
  const [v, setV] = useState<InspectorValues>({ mode, personId: mode === "add" ? addable[0]?.id ?? "" : personId ?? "", scope: "", reason: "" });
  const [submitted, setSubmitted] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const errors = validateInspector(v);
  useEffect(() => { form.current?.querySelector<HTMLElement>(mode === "add" ? 'select' : 'textarea')?.focus(); }, [mode]);
  const remove = mode === "remove";
  const submit = (e: FormEvent) => {
    e.preventDefault(); setSubmitted(true);
    if (Object.keys(errors).length) { firstInvalid(form.current); return; }
    const target = rows.find((r) => r.id === v.personId);
    onClose(); preview(`${target ? nameOf(target) : "They"} would be ${remove ? "removed from" : "added to"} the inspectors list.`);
  };
  const failing = (Object.keys(errors) as Array<keyof InspectorErrors>).filter((k) => submitted && errors[k]);
  return (
    <Sheet open size="sm" title={remove ? `Remove ${person ? nameOf(person) : ""} from the inspectors list` : "Add an inspector"}
      description={remove ? "They can no longer record a pass. Passes they recorded before stay as they are." : "They can record inspection passes and co-sign as the inspector."}
      onClose={onClose} closeButton={false} testId="dlg-inspector"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={remove ? "secondary" : "primary"} className={remove ? s.danger : undefined} type="submit" form="inspector-form" data-testid="save-inspector">{remove ? "Remove" : "Add"}</Button></>}>
      <form id="inspector-form" ref={form} onSubmit={submit} noValidate className={s.form} aria-label={remove ? "Remove inspector" : "Add an inspector"}>
        {failing.length ? <p className={s.summary} role="alert">{failCount(failing.length)}.</p> : null}
        {!remove ? (
          <>
            <Field label="Person" error={submitted ? errors.person : undefined}>
              <Select aria-label="Person to add" value={v.personId} onChange={(e) => setV({ ...v, personId: e.target.value })}>{addable.map((r) => <option key={r.id} value={r.id}>{nameOf(r)}</option>)}</Select>
            </Field>
            <Field label="Scope" optional error={submitted ? errors.scope : undefined}>
              <Input aria-label="Scope" value={v.scope} maxLength={SCOPE_MAX} placeholder="e.g. Dimensional and visual checks" onChange={(e) => setV({ ...v, scope: e.target.value })} />
            </Field>
          </>
        ) : null}
        <Field label="Reason" error={submitted ? errors.reason : undefined}>
          <Textarea aria-label="Reason" value={v.reason} maxLength={REASON_MAX} rows={3}
            placeholder={remove ? "e.g. Moved to stores, no longer inspecting" : "e.g. Trained on bore gauges and the CMM, signed off by the JNR controller"} onChange={(e) => setV({ ...v, reason: e.target.value })} />
        </Field>
      </form>
      <p className={s.sheetNote}>{PREVIEW_ONLY_NOTE}</p>
    </Sheet>
  );
}
