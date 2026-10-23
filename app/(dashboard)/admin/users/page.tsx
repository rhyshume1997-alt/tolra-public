"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListSkeleton } from "@/components/list-skeleton";
import { usersEmptyHint } from "@/lib/empty-hints";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Plus, RefreshCw, Shield } from "lucide-react";

import { RoleGate } from "@/components/role-gate";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompanyProfile } from "@/lib/company";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { generatePassword, PASSWORD_RULES, passwordProblem } from "@/lib/password";
import { sectionsForRoles } from "@/lib/sections";
import { supabase } from "@/lib/supabase";
import { useSaving } from "@/lib/use-saving";
import { useUser } from "@/lib/use-user";
import type { UserRole } from "@/types";
import { isValidUsername, normaliseUsername, USERNAME_RULES } from "@/lib/username";
import { PRODUCT } from "@/lib/product";
import { countMissingNames, displayNameProblem, hasDisplayName } from "@/lib/display-name";
import { apiErrorFrom, describePartial, inspectorFlags, saveMemberEdit } from "@/lib/admin-user-save";
import { ADMIN_MFA_ONBOARDING_NOTICE, type AdminMfaOverview, adminMfaRuleMessage, adminMfaStatusLabel, becomesAdmin, holdsAdmin, parseAdminMfaOverview } from "@/lib/mfa-policy";
import { disableSignInConfirm, identityActions, parseProtectedList, parseSignInList, type ProtectedState, SIGN_IN_CHECKING_LABEL, SIGN_IN_HELP, type SignInState, signInBadge, signInControls } from "@/lib/sign-in-access";
import { OnSiteOnlyToggle, useOnSiteOnly } from "@/components/time/on-site-only";
import { AuthorisedInspectors } from "@/components/authorised-inspectors";
import { databaseHas083 } from "@/lib/inspectors";
import { type CompanyAccess, type CompanyChange, type CompanyDraft, type CompanyResult, draftCompanies, parseCompanyAccess, parseCompanyResults, planCompanyChanges, summariseCompanyResults } from "@/lib/company-access";

type OrgMemberRow = {
  user_id: string; email: string; full_name: string | null; username?: string | null; role: string; secondary_role: string | null;
  active: boolean; last_login_at: string | null; hidden_sections?: string[] | null; must_change_password?: boolean | null;
  support?: boolean | null; expires_at?: string | null;
};
type UserRow = {
  id: string; name: string; email: string; username: string;
  /** The display name as stored ("" when there is none usable: the Job Board would show "—"). */
  fullName: string; role: UserRole; secondary: UserRole | ""; lastLogin: string | null;
  active: boolean; hidden: string[]; mustChange: boolean;
  /** Tolra support (the platform owner), with the end of the window: not a member of the company, never counted as an admin. */
  support: boolean; expiresAt: string | null;
  /** May record inspections (migration 034): on the authorised inspectors list (083); before 083 admins always may, office and workshop
   * only when an admin has ticked this. */
  inspector: boolean;
};

const ROLES: UserRole[] = ["admin", "office", "workshop", "viewer"];
const ROLE_HELP: Record<UserRole, string> = {
  admin: "everything, including invoices, settings and users",
  office: "quotes, sales orders, invoices and payments, customers, suppliers, POs and jobs",
  workshop: "jobs, schedule and delivery notes",
  viewer: "read-only jobs and schedule",
};
const selectClass = "h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm";
const labelClass = "grid gap-1.5 text-sm font-medium text-slate-700";

/** The admin API returns short, fixed messages; anything else gets the generic text. */
async function callApi<T extends Record<string, unknown>>(url: string, method: "POST" | "PATCH", payload: Record<string, unknown>) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = (await response.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!response.ok || result.error || !result.ok) throw apiErrorFrom(result, "Something went wrong. Try again.");
  return result;
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Tick boxes for the sections the person's roles give them; unticked = hidden for them. */
function PageAccess({ roles, hidden, onChange }: { roles: (UserRole | "")[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  const sections = sectionsForRoles(roles);
  if (!sections.length) return <p className="text-sm text-slate-500">This role has no optional pages.</p>;
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {sections.map((section) => {
        const visible = !hidden.includes(section.key);
        return (
          <label key={section.key} className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm text-slate-700 hover:bg-slate-50">
            <input type="checkbox" className="size-4 accent-brand" checked={visible}
              onChange={() => onChange(visible ? [...hidden, section.key] : hidden.filter((key) => key !== section.key))} />
            {section.label}
          </label>
        );
      })}
    </div>
  );
}

/** Password field with "Generate"; the value is visible so the admin can pass it on (it's shown only here). */
function PasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex gap-2">
        <Input value={value} onChange={(event) => onChange(event.target.value)} autoComplete="new-password" spellCheck={false}
          className="h-11 font-mono" placeholder="Type a password or generate one" aria-label="Password" />
        <Button type="button" variant="outline" className="h-11 shrink-0" onClick={() => onChange(generatePassword())}>
          <RefreshCw className="size-4" /> Generate
        </Button>
      </div>
      <span className="text-xs text-slate-500">{PASSWORD_RULES}</span>
    </div>
  );
}

function MustChange({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-700">
      <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>Must change password at first sign-in<span className="block text-xs text-slate-500">Recommended. They choose their own password before they can use {PRODUCT.name}.</span></span>
    </label>
  );
}

/**
 * Access to the OTHER companies this admin administers (migration 066): a switch and a role per company. The current company's access
 * is the Role fields above. Shown only when the admin administers more than one company.
 */
function CompanyAccessFields({ drafts, onChange, self, loading, error }: { drafts: CompanyDraft[]; onChange: (drafts: CompanyDraft[]) => void; self?: boolean; loading?: boolean; error?: string | null }) {
  if (loading) return <Skeleton className="h-16" />;
  if (error) return <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>;
  if (!drafts.length) return null;
  const update = (index: number, next: Partial<CompanyDraft>) => onChange(drafts.map((draft, i) => (i === index ? { ...draft, ...next } : draft)));
  return (
    <fieldset data-testid="company-access" className="grid gap-2">
      <legend className="mb-1 text-sm font-medium text-slate-700">Other companies you manage</legend>
      {drafts.map((draft, index) => (
        <div key={draft.organizationId} data-testid="company-access-row" className="grid gap-2 rounded-lg border border-slate-200 p-2.5 sm:grid-cols-[1fr_auto_auto] sm:items-center">
          <label className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-slate-700">
            <input type="checkbox" className="size-4 accent-brand" aria-label={`Access to ${draft.name}`} checked={draft.on}
              disabled={draft.locked || (self && draft.on)} onChange={(event) => update(index, { on: event.target.checked })} />
            <span className="font-medium">{draft.name}</span>
            {draft.locked ? <Badge className="bg-amber-100 text-amber-800">Tolra support</Badge> : null}
          </label>
          <select aria-label={`Role in ${draft.name}`} className={cn(selectClass, "sm:w-36")} value={draft.role} disabled={!draft.on || draft.locked}
            onChange={(event) => update(index, { role: event.target.value as UserRole, secondary: draft.secondary === event.target.value ? "" : draft.secondary })}>
            {ROLES.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}
          </select>
          <select aria-label={`Also has role in ${draft.name}`} className={cn(selectClass, "sm:w-36")} value={draft.secondary} disabled={!draft.on || draft.locked}
            onChange={(event) => update(index, { secondary: event.target.value as UserRole | "" })}>
            <option value="">No second role</option>{ROLES.filter((role) => role !== draft.role).map((role) => <option key={role} value={role}>+ {titleCase(role)}</option>)}
          </select>
        </div>
      ))}
      <span className="text-xs text-slate-500">Tick a company to give this login access there with the role shown; untick to remove it. Everyone keeps at least one company, and each change is recorded in that company&apos;s activity.{self ? " You can't remove your own access; another admin can." : ""}</span>
    </fieldset>
  );
}

/** Sends company access changes; every company's outcome comes back, whatever the status. Throws only when there is no answer. */
async function saveCompanyAccess(userId: string, changes: CompanyChange[]): Promise<{ results: CompanyResult[]; loginDisabled: boolean }> {
  const response = await fetch("/api/admin/users/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId, changes }) });
  const body = (await response.json().catch(() => null)) as { login_disabled?: boolean; error?: string } | null;
  const results = parseCompanyResults(body);
  if (!results.length) throw new Error(body?.error || "Couldn't save company access. Reload to check what is stored.");
  return { results, loginDisabled: body?.login_disabled === true };
}

type Shown = { who: string; signIn: string; password: string; mustChange: boolean; adminMfa?: boolean };

export default function UsersPage() {
  const { user: me } = useUser();
  const { profile: company } = useCompanyProfile();
  const { saving, run } = useSaving();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The inspector flags are a separate read; when it fails, nobody's flag is known, so the checkbox can't be edited.
  const [flagsError, setFlagsError] = useState<string | null>(null);

  // Add user
  const [addOpen, setAddOpen] = useState(false);
  const [add, setAdd] = useState({ full_name: "", email: "", username: "", role: "workshop" as UserRole, secondary: "" as UserRole | "", hidden: [] as string[], password: "", mustChange: true });
  // Edit
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [edit, setEdit] = useState({ fullName: "", role: "viewer" as UserRole, secondary: "" as UserRole | "", username: "", hidden: [] as string[], inspector: false });
  // Set password
  const [pwFor, setPwFor] = useState<UserRow | null>(null);
  const [pw, setPw] = useState({ password: "", mustChange: true });
  // A password just set, shown once
  const [shown, setShown] = useState<Shown | null>(null);
  const [copied, setCopied] = useState(false);
  // Who holds admin and has set up two-step sign-in (migration 065); null when it could not be read (e.g. before 065 is applied).
  const [mfa, setMfa] = useState<AdminMfaOverview | null>(null);
  // 075: "On site only" per person (hidden until the database has 075).
  const onSite = useOnSiteOnly();
  // 083: the authorised inspectors list (its own section, a reason for every change); null while asking.
  const [has083, setHas083] = useState<boolean | null>(null);
  useEffect(() => { let active = true; void databaseHas083().then((value) => { if (active) setHas083(value); }); return () => { active = false; }; }, []);
  // The companies this admin administers (migration 066); empty before 066 or for a single-company admin (no section is shown).
  const [myCompanies, setMyCompanies] = useState<CompanyAccess[]>([]);
  // Logins that belong to this company alone (offboarding with Disable sign-in instead of Deactivate), and whether they can sign in.
  const [signIn, setSignIn] = useState<Map<string, SignInState>>(new Map());
  // The sign-in answer and the two-step overview arrive after the table (they are slower): until they do, the page says so rather than guess.
  const [signInChecking, setSignInChecking] = useState(true);
  // 093: logins no company admin may touch (platform owner / support), from the same answer; `protectedUnavailable` when it couldn't
  // be read at all (fail closed: every other row's identity actions are then off).
  const [shielded, setShielded] = useState<Map<string, ProtectedState>>(new Map());
  const [protectedUnavailable, setProtectedUnavailable] = useState(false);
  const [mfaChecking, setMfaChecking] = useState(true);
  // Only the latest load's slower answers are kept (a reload while an older one is still running must not be overwritten by it).
  const loadSeq = useRef(0);
  const [addCompanies, setAddCompanies] = useState<CompanyDraft[]>([]);
  const [editAccess, setEditAccess] = useState<{ rows: CompanyAccess[]; drafts: CompanyDraft[]; loading: boolean; error: string | null }>({ rows: [], drafts: [], loading: false, error: null });

  const load = useCallback(async (): Promise<UserRow[] | null> => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    setSignInChecking(true);
    setMfaChecking(true);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      // org_members() returns the members of the signed-in admin's current organisation (a person can belong to several). It and the
      // inspector flags are all the table needs, so the table shows as soon as they are in; the rest is read beside it, below.
      const [{ data, error: queryError }, { data: flags, error: flagsReadError }] = await Promise.all([
        supabase.rpc("org_members"),
        supabase.from("organization_members").select("user_id, can_inspect"),
      ]);
      if (queryError) throw queryError;
      const inspectors = inspectorFlags(flags, flagsReadError);
      setFlagsError(inspectors ? null : friendlyError(flagsReadError, "Couldn't load who can record inspections."));
      const next: UserRow[] = ((data ?? []) as OrgMemberRow[]).map((row) => ({
        id: String(row.user_id),
        name: hasDisplayName(row.full_name) ? row.full_name!.trim() : row.email,
        fullName: hasDisplayName(row.full_name) ? row.full_name!.trim() : "",
        email: row.email,
        username: row.username || "",
        role: row.role as UserRole,
        secondary: (row.secondary_role || "") as UserRole | "",
        lastLogin: row.last_login_at,
        active: row.active !== false,
        hidden: Array.isArray(row.hidden_sections) ? row.hidden_sections : [],
        mustChange: row.must_change_password === true,
        support: row.support === true,
        expiresAt: row.expires_at ?? null,
        inspector: inspectors?.has(String(row.user_id)) ?? false,
      }));
      setRows(next);
      setLoading(false);
      // Side by side, each filling its own part of the page when it arrives; none of them can hold the table back or fail the load.
      const client = supabase;
      void Promise.resolve(client.rpc("admin_mfa_overview")).then(({ data: overview, error: overviewError }) => {
        if (seq !== loadSeq.current) return;
        setMfa(overviewError ? null : parseAdminMfaOverview(overview));
      }, () => { if (seq === loadSeq.current) setMfa(null); }).finally(() => { if (seq === loadSeq.current) setMfaChecking(false); });
      void Promise.resolve(client.rpc("my_admin_companies")).then(({ data: companies, error: companiesError }) => {
        if (seq !== loadSeq.current) return;
        setMyCompanies(companiesError ? [] : parseCompanyAccess(companies));
      }, () => { if (seq === loadSeq.current) setMyCompanies([]); });
      // Unreadable: nobody is offered Disable sign-in, and Deactivate explains when it can't remove someone's only company.
      void fetch("/api/admin/users/sign-in").then(async (response) => (response.ok ? await response.json().catch(() => null) : null), () => null).then((body: unknown) => {
        if (seq !== loadSeq.current) return;
        setSignIn(parseSignInList(body));
        setShielded(parseProtectedList(body));
        setProtectedUnavailable(!body || typeof body !== "object" || !Array.isArray((body as { protected?: unknown }).protected));
        setSignInChecking(false);
      });
      return inspectors ? next : null;
    } catch (err) {
      if (seq === loadSeq.current) {
        setError(friendlyError(err, "Couldn't load users."));
        setLoading(false);
        setSignInChecking(false);
        setMfaChecking(false);
      }
      return null;
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Retry from the Edit dialog: once the flags load, the open dialog takes the member's real inspector setting. */
  async function retryFlags() {
    const fresh = await load();
    const id = editing?.id;
    const row = id ? fresh?.find((candidate) => candidate.id === id) : undefined;
    if (!row) return;
    setEditing(row);
    setEdit((current) => ({ ...current, inspector: row.inspector }));
  }

  const missingNames = useMemo(() => countMissingNames(rows.filter((row) => row.active).map((row) => ({ fullName: row.fullName, support: row.support }))), [rows]);
  const mfaRule = useMemo(() => {
    if (!mfa) return null;
    const names = new Map(rows.map((row) => [row.id, row.name]));
    return adminMfaRuleMessage(mfa, (id) => names.get(id) ?? "An admin");
  }, [mfa, rows]);
  const activeAdmins = useMemo(() => rows.filter((row) => row.active && !row.support && (row.role === "admin" || row.secondary === "admin")).length, [rows]);

  function openAdd() {
    setAdd({ full_name: "", email: "", username: "", role: "workshop", secondary: "", hidden: [], password: generatePassword(), mustChange: true });
    setAddCompanies(draftCompanies(myCompanies));
    setAddOpen(true);
  }

  function submitAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = normaliseUsername(add.username);
    // A new person needs a name and an email. Someone who already has a login (in another company) can be added by username alone.
    if ((!add.full_name.trim() || !add.email.trim()) && !username) { toast.error("Enter a name and an email, or the username of someone who already has a login."); return; }
    if (username && !isValidUsername(username)) { toast.error(`Username: ${USERNAME_RULES}`); return; }
    // The password is only used for a brand-new login (which needs an email); an existing login keeps its own.
    const problem = add.email.trim() ? passwordProblem(add.password) : null;
    if (problem) { toast.error(problem); return; }
    const allowed = new Set(sectionsForRoles([add.role, add.secondary]).map((section) => section.key));
    void run(async () => {
      try {
        const result = await callApi<{ existing_login?: boolean; message?: string; login_disabled?: boolean; admin_mfa_onboarding?: boolean; user?: { id?: string } }>("/api/admin/users", "POST", {
          ...(add.full_name.trim() ? { full_name: add.full_name.trim() } : {}),
          ...(add.email.trim() ? { email: add.email.trim() } : {}),
          role: add.role,
          secondary_role: add.secondary || null,
          hidden_sections: add.hidden.filter((key) => allowed.has(key)),
          password: add.password,
          must_change_password: add.mustChange,
          ...(username ? { username } : {}),
        });
        setAddOpen(false);
        if (result.existing_login) {
          toast.success(result.message ?? `${add.full_name.trim() || username} already has a ${PRODUCT.name} login, so they were added with their existing password.`);
          if (result.login_disabled) toast.warning(`Their login is disabled. Contact ${PRODUCT.name} support to re-enable it.`);
          if (result.admin_mfa_onboarding) toast.info(`${add.full_name.trim() || username}: ${ADMIN_MFA_ONBOARDING_NOTICE}`);
        } else {
          setShown({ who: add.full_name.trim(), signIn: username || add.email.trim(), password: add.password, mustChange: add.mustChange, adminMfa: result.admin_mfa_onboarding === true });
        }
        // Access to the other companies ticked: only once the login exists here, each company decided by the database.
        const companyChanges = planCompanyChanges([], addCompanies);
        if (companyChanges.length && result.user?.id) await applyCompanyChanges({ id: result.user.id, name: add.full_name.trim() || username || "They" }, companyChanges);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : friendlyError(err));
      }
    });
  }

  function openEdit(user: UserRow) {
    setEdit({ fullName: user.fullName, role: user.role, secondary: user.secondary, username: user.username, hidden: user.hidden, inspector: user.inspector });
    setEditing(user);
    // Their access in the other companies this admin administers (none to show for a single-company admin).
    if (!supabase || myCompanies.filter((company) => !company.isCurrent).length === 0) { setEditAccess({ rows: [], drafts: [], loading: false, error: null }); return; }
    setEditAccess({ rows: [], drafts: [], loading: true, error: null });
    void supabase.rpc("admin_company_access", { p_user: user.id }).then(({ data, error: accessError }) => {
      const rows = accessError ? [] : parseCompanyAccess(data);
      setEditAccess({ rows, drafts: draftCompanies(rows), loading: false, error: accessError ? friendlyError(accessError, "Couldn't load their access to your other companies.") : null });
    });
  }

  /** Saves company access changes and says what happened per company. True unless nothing at all was saved. */
  async function applyCompanyChanges(target: { id: string; name: string }, changes: CompanyChange[]): Promise<boolean> {
    try {
      const { results, loginDisabled } = await saveCompanyAccess(target.id, changes);
      const summary = summariseCompanyResults(results);
      if (summary.tone === "ok") toast.success(summary.text);
      else if (summary.tone === "partial") toast.warning(summary.text);
      else if (summary.tone === "error") toast.error(summary.text);
      if (results.some((r) => r.admin_mfa_onboarding)) toast.info(`${target.name}: ${ADMIN_MFA_ONBOARDING_NOTICE}`);
      if (loginDisabled) toast.warning(`Their login is disabled. Contact ${PRODUCT.name} support to re-enable it.`);
      return summary.tone !== "error";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : friendlyError(err));
      return false;
    }
  }

  function submitEdit() {
    if (!editing) return;
    const username = normaliseUsername(edit.username);
    if (username && !isValidUsername(username)) { toast.error(`Username: ${USERNAME_RULES}`); return; }
    const secondary = edit.secondary && edit.secondary !== edit.role ? edit.secondary : "";
    const patch: Record<string, unknown> = {};
    const fullName = edit.fullName.trim().replace(/\s+/g, " ");
    if (fullName !== editing.fullName) {
      const problem = displayNameProblem(fullName);
      if (problem) { toast.error(`Display name: ${problem}`); return; }
      patch.full_name = fullName;
    }
    if (edit.role !== editing.role) patch.role = edit.role;
    if (secondary !== editing.secondary) patch.secondary_role = secondary || null;
    if (username !== editing.username) patch.username = username || null;
    const sortedHidden = [...edit.hidden].sort();
    if (sortedHidden.join() !== [...editing.hidden].sort().join()) patch.hidden_sections = sortedHidden;
    // An unknown flag (its read failed) is never written.
    const inspectorChanged = !flagsError && edit.inspector !== editing.inspector;
    // Other companies (migration 066): applied after this company's changes have saved, each one decided by the database.
    const companyChanges = editAccess.loading || editAccess.error ? [] : planCompanyChanges(editAccess.rows, editAccess.drafts);
    const target = editing;
    const afterSave = companyChanges.length ? () => applyCompanyChanges(target, companyChanges) : undefined;
    if (!Object.keys(patch).length && !inspectorChanged) {
      if (!afterSave) { setEditing(null); return; }
      void run(async () => {
        if (await afterSave()) setEditing(null);
        await load();
      });
      return;
    }
    if (!inspectorChanged) { patchUser(editing, patch, "User updated", afterSave); return; }
    // Who may record inspections is a database setting of its own (set_member_inspector, admin only, audited). The member update goes
    // first; the flag is only changed once it has succeeded, and a failure says exactly what was applied.
    void run(async () => {
      let onboarding = false;
      const result = await saveMemberEdit({
        hasPatch: Object.keys(patch).length > 0,
        inspectorChange: edit.inspector,
        patch: async () => {
          const saved = await callApi<{ admin_mfa_onboarding?: boolean }>("/api/admin/users", "PATCH", { user_id: target.id, ...patch });
          onboarding = saved.admin_mfa_onboarding === true;
          return saved;
        },
        setInspector: async (value) => {
          if (!supabase) throw new Error("Supabase is not configured.");
          const { error: rpcError } = await supabase.rpc("set_member_inspector", { p_user: target.id, p_value: value });
          if (rpcError) throw rpcError;
        },
        describe: (err) => (err instanceof Error ? friendlyError(err, err.message) : friendlyError(err)),
      });
      if (result.status === "ok") {
        toast.success("User updated");
        if (onboarding) toast.info(`${target.name}: ${ADMIN_MFA_ONBOARDING_NOTICE}`);
        if (afterSave) await afterSave();
        setEditing(null);
      } else if (result.status === "partial") {
        toast.warning(result.message);
        setEditing(null);
      } else {
        toast.error(result.message);
      }
      // Always show what is stored now, so the table matches what was actually saved. A clean failure keeps the dialog open.
      await load();
    });
  }

  function patchUser(user: UserRow, patch: Record<string, unknown>, success: string, afterSave?: () => Promise<boolean>) {
    void run(async () => {
      try {
        const result = await callApi<{ login_disabled?: boolean; admin_mfa_onboarding?: boolean }>("/api/admin/users", "PATCH", { user_id: user.id, ...patch });
        toast.success(success);
        if (result.login_disabled) toast.warning(`Their login is disabled. Contact ${PRODUCT.name} support to re-enable it.`);
        if (result.admin_mfa_onboarding) toast.info(`${user.name}: ${ADMIN_MFA_ONBOARDING_NOTICE}`);
        if (afterSave) await afterSave();
        setEditing(null);
        await load();
      } catch (err) {
        const why = err instanceof Error ? err.message : friendlyError(err);
        const partial = describePartial(err, why);
        if (partial) {
          // Part of the change did reach the server: close the dialog and reload so the table shows exactly what is saved now.
          toast.warning(partial);
          setEditing(null);
        } else toast.error(why);
        await load();
      }
    });
  }

  /** Disable (leaver: stops them signing in to Tolra) or enable sign-in for a login that belongs to this company alone. */
  function setSignInFor(user: UserRow, enabled: boolean) {
    if (!enabled && !window.confirm(disableSignInConfirm(user.name, company?.name ?? "this company"))) return;
    void run(async () => {
      try {
        const result = await callApi<{ changed?: boolean }>("/api/admin/users/sign-in", "POST", { user_id: user.id, enabled });
        toast.success(enabled ? `${user.name} can sign in again` : `${user.name} can no longer sign in`);
        if (result.changed === false) toast.info("Nothing needed changing.");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : friendlyError(err));
      }
      await load();
    });
  }

  function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pwFor) return;
    const problem = passwordProblem(pw.password);
    if (problem) { toast.error(problem); return; }
    const target = pwFor;
    void run(async () => {
      try {
        await callApi("/api/admin/users/password", "POST", { user_id: target.id, password: pw.password, must_change_password: pw.mustChange });
        setPwFor(null);
        setShown({ who: target.name, signIn: target.username || target.email, password: pw.password, mustChange: pw.mustChange });
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : friendlyError(err));
      }
    });
  }

  async function copyPassword() {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy. Select the password and copy it by hand.");
    }
  }

  const editRoles: (UserRole | "")[] = [edit.role, edit.secondary];

  return (
    <RoleGate allowed={["admin"]}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="page-title">User Management</h1>
            <p className="mt-2 text-sm text-slate-500">Add people to {company?.name ?? "your company"}, choose what they can open, and manage their passwords. No emails are sent.</p>
          </div>
          <Button className="bg-brand text-brand-ink" onClick={openAdd}><Plus className="size-4" /> New user</Button>
        </div>

        {error ? <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-red-700">{error}</p><Button variant="outline" onClick={() => void load()}>Retry</Button></CardContent></Card> : null}

        {!loading && missingNames ? (
          <p data-testid="missing-names" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            {missingNames === 1 ? "1 person has" : `${missingNames} people have`} no display name, so the Job Board can&apos;t say who a job is assigned to. Use Edit to add one, or ask them to add it in Account Settings.
          </p>
        ) : null}

        {!loading && !error ? (
          <p data-testid="admin-mfa-rule" className={cn("rounded-lg border p-3 text-sm", mfaRule?.tone === "ok" ? "border-green-200 bg-green-50 text-green-900" : mfaChecking && !mfaRule ? "border-slate-200 bg-slate-50 text-slate-600" : "border-amber-300 bg-amber-50 text-amber-950")}>
            {mfaRule ? mfaRule.text : mfaChecking ? "Checking two-step sign-in status for admins\u2026" : "Two-step sign-in status for admins isn't available yet."}
          </p>
        ) : null}

        {loading ? <ListSkeleton label="Loading users" rows={5} /> : (
          <Card><CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table data-tablet-cards>
                <TableHeader className="hidden md:table-header-group"><TableRow><TableHead>Name</TableHead><TableHead>Username</TableHead><TableHead>Roles</TableHead><TableHead>Pages</TableHead><TableHead>Status</TableHead><TableHead>Last login</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {rows.map((user) => {
                    const isSelf = user.id === me?.id;
                    const isLastAdmin = user.active && !user.support && (user.role === "admin" || user.secondary === "admin") && activeAdmins <= 1;
                    const controls = signInControls({ isSelf, isLastAdmin, active: user.active, checking: signInChecking, state: signIn.get(user.id) });
                    // 093: Edit, Set password, Reset two-step and sign-in are off for a platform owner / support login (and while unknown).
                    const identity = identityActions({ isSelf, checking: signInChecking, unavailable: protectedUnavailable, state: shielded.get(user.id) });
                    const available = sectionsForRoles([user.role, user.secondary]);
                    const hiddenCount = available.filter((section) => user.hidden.includes(section.key)).length;
                    return (
                      <TableRow key={user.id} data-testid="user-row" className={cn("block md:table-row", !user.active ? "opacity-60" : "")}>
                        <TableCell data-label="Name" className="block md:table-cell"><p className="font-semibold text-slate-900">{user.fullName || <span className="font-normal italic text-slate-500">No name</span>}{isSelf ? <span className="ml-2 text-xs font-normal text-slate-400">(you)</span> : null}</p><p className="text-xs text-slate-500">{user.email}</p>{!user.fullName && !user.support ? <Badge data-testid="no-display-name" className="mt-1 bg-amber-100 text-amber-800">No display name</Badge> : null}</TableCell>
                        <TableCell data-label="Username" className="block font-mono text-sm md:table-cell">{user.username || <span className="font-sans text-slate-400">—</span>}</TableCell>
                        <TableCell data-label="Roles" className="block md:table-cell md:whitespace-nowrap"><Badge><Shield className="size-3" />{titleCase(user.role)}</Badge>{user.secondary ? <Badge className="ml-1.5 bg-brand-accent text-brand-ink">+ {titleCase(user.secondary)}</Badge> : null}
                          {mfa && user.active && !user.support && holdsAdmin({ role: user.role, secondary_role: user.secondary || null }) ? (() => {
                            const status = mfa.admins.get(user.id);
                            return <Badge data-testid="admin-mfa-status" className={cn("mt-1 block w-fit md:ml-1.5 md:mt-0 md:inline-flex", status?.enrolled ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800")}>{adminMfaStatusLabel(status)}</Badge>;
                          })() : null}</TableCell>
                        <TableCell data-label="Pages" className="block text-sm text-slate-600 md:table-cell">{hiddenCount ? `${available.length - hiddenCount} of ${available.length}` : "All"}</TableCell>
                        <TableCell data-label="Status" className="block md:table-cell md:whitespace-nowrap">
                          {user.support ? <Badge className="bg-amber-100 text-amber-800">Tolra support{user.expiresAt ? `, until ${fmtDateTime(user.expiresAt)}` : ""}</Badge>
                            : !user.active ? <Badge variant="outline">Deactivated</Badge>
                            : signInChecking && !isSelf ? <Badge data-testid="sign-in-checking" variant="outline" className="text-slate-500">{SIGN_IN_CHECKING_LABEL}</Badge>
                            : signInBadge(signIn.get(user.id)) ? <Badge data-testid="sign-in-disabled" className="bg-red-100 text-red-800">{signInBadge(signIn.get(user.id))}</Badge>
                            : user.mustChange ? <Badge className="bg-amber-100 text-amber-800">Must change password</Badge>
                            : !user.lastLogin ? <Badge className="bg-slate-100 text-slate-700">Not signed in yet</Badge>
                            : <Badge className="bg-green-600 text-white">Active</Badge>}
                          {user.active && !user.support ? <OnSiteOnlyToggle userId={user.id} name={user.name} state={onSite} /> : null}
                        </TableCell>
                        <TableCell data-label="Last login" className="block text-sm md:table-cell md:whitespace-nowrap">{user.lastLogin ? fmtDateTime(user.lastLogin) : "Never"}</TableCell>
                        <TableCell data-actions className="block md:table-cell">
                          {user.support ? (
                            <div className="flex flex-wrap gap-2 md:justify-end">
                              <Button variant="outline" size="sm" disabled={saving} onClick={() => {
                                if (!window.confirm(`Switch off Tolra support access to ${company?.name ?? "this company"}? It ends straight away.`)) return;
                                patchUser(user, { active: false }, "Support access switched off");
                              }}>Revoke support access</Button>
                            </div>
                          ) : (
                          <div className="flex flex-wrap items-center gap-2 md:justify-end">
                            {identity.reason && !signInChecking ? <span data-testid="protected-login" className="text-xs text-slate-500">{identity.reason}</span> : null}
                            <Button variant="outline" size="sm" disabled={saving || !identity.allowed} title={identity.reason ?? undefined} onClick={() => openEdit(user)}>Edit</Button>
                            {isSelf ? null : (
                              <Button variant="outline" size="sm" disabled={saving || !user.active || !identity.allowed} title={identity.reason ?? undefined} onClick={() => { setPw({ password: generatePassword(), mustChange: true }); setPwFor(user); }}>
                                <KeyRound className="size-3.5" /> Set password
                              </Button>
                            )}
                            {isSelf || user.role !== "admin" ? null : (
                              <Button variant="outline" size="sm" disabled={saving || !user.active || !identity.allowed} title={identity.reason ?? undefined} onClick={() => {
                                if (!window.confirm(`Reset two-step sign-in for ${user.name}? They will set up their authenticator app again at their next sign-in. Only do this once you are sure it is really them asking.`)) return;
                                void run(async () => {
                                  try {
                                    await callApi("/api/admin/users/mfa-reset", "POST", { userId: user.id });
                                    toast.success(`Two-step sign-in reset for ${user.name}. They will set up an authenticator app again at their next sign-in.`);
                                    await load();
                                  } catch (err) {
                                    toast.error(err instanceof Error ? err.message : friendlyError(err));
                                  }
                                });
                              }}>Reset two-step</Button>
                            )}
                            {!identity.allowed && !signInChecking ? null : controls.signIn === "checking" ? (
                              <Button variant="outline" size="sm" disabled title="Checking whether this person's sign-in can be disabled here">{SIGN_IN_CHECKING_LABEL}</Button>
                            ) : controls.signIn === "enable" ? (
                              <Button variant="outline" size="sm" disabled={saving} onClick={() => setSignInFor(user, true)}>Enable sign-in</Button>
                            ) : controls.signIn === "disable" ? (
                              <Button variant="outline" size="sm" disabled={saving} title={`Leaver: stops them signing in to ${PRODUCT.name}`} onClick={() => setSignInFor(user, false)}>Disable sign-in</Button>
                            ) : null}
                            {/* 093: a platform owner's ordinary row offers no Deactivate here either: only a support row's Revoke switches off. */}
                            {controls.deactivate && identity.allowed ? (
                              <Button variant="outline" size="sm" disabled={saving} onClick={() => {
                                if (user.active && !window.confirm(`Deactivate ${user.name}? They lose access to ${company?.name ?? "this company"} straight away.`)) return;
                                patchUser(user, { active: !user.active }, user.active ? `${user.name} deactivated` : `${user.name} reactivated`);
                              }}>{user.active ? "Deactivate" : "Reactivate"}</Button>
                            ) : null}
                          </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!rows.length && !error ? <TableRow><TableCell colSpan={7} className="py-8 text-center text-slate-500">No users yet. {usersEmptyHint()}</TableCell></TableRow> : null}
                </TableBody>
              </Table>
            </div>
          </CardContent></Card>
        )}

        {has083 && !loading && !error && !flagsError ? (
          <AuthorisedInspectors people={rows.map((row) => ({ id: row.id, name: row.name, roles: [row.role, row.secondary].filter(Boolean), active: row.active, support: row.support, inspector: row.inspector }))}
            onChanged={() => void load()} />
        ) : null}
        <p data-testid="sign-in-help" className="text-xs text-slate-500">{SIGN_IN_HELP}</p>
        <p className="text-xs text-slate-500">Forgotten passwords: staff can use &quot;Forgot password?&quot; on the sign-in page, or you can set a new one here. Page access hides a page from that person; for quotes, invoices, sales orders, purchase orders, RFQs and emails their data is blocked too.</p>

        {/* Add user */}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader><DialogTitle>Add user</DialogTitle><DialogDescription>The account works straight away. Give them their username and password yourself; no email is sent.</DialogDescription></DialogHeader>
            <form onSubmit={submitAdd} className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className={labelClass}>Full name<Input value={add.full_name} onChange={(e) => setAdd({ ...add, full_name: e.target.value })} required={!add.username.trim()} className="h-11" /></label>
                <label className={labelClass}>Email<Input type="email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} required={!add.username.trim()} className="h-11" /></label>
              </div>
              <label className={labelClass}>Username for sign-in
                <Input aria-label="Username for sign-in" value={add.username} onChange={(e) => setAdd({ ...add, username: e.target.value })} maxLength={32} placeholder="e.g. jsmith" autoCapitalize="none" spellCheck={false} className="h-11" />
                <span className="text-xs font-normal text-slate-500">Optional. {USERNAME_RULES} They can also sign in with their email. Already have a {PRODUCT.name} login in another company? Enter just their username (name and email can stay empty) and they are added here with their existing password.</span>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className={labelClass}>Role
                  <select aria-label="Role" className={selectClass} value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value as UserRole })}>{ROLES.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</select>
                  <span className="text-xs font-normal text-slate-500">{titleCase(add.role)}: {ROLE_HELP[add.role]}.</span>
                </label>
                <label className={labelClass}>Also has role
                  <select aria-label="Also has role" className={selectClass} value={add.secondary} onChange={(e) => setAdd({ ...add, secondary: e.target.value as UserRole | "" })}>
                    <option value="">None</option>{ROLES.filter((role) => role !== add.role).map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}
                  </select>
                  <span className="text-xs font-normal text-slate-500">Optional second role, e.g. office + workshop.</span>
                </label>
              </div>
              {add.role === "admin" || add.secondary === "admin" ? <p data-testid="admin-mfa-notice" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">{ADMIN_MFA_ONBOARDING_NOTICE}</p> : null}
              <CompanyAccessFields drafts={addCompanies} onChange={setAddCompanies} />
              <fieldset className="grid gap-2"><legend className="mb-1 text-sm font-medium text-slate-700">Pages they can open</legend>
                <PageAccess roles={[add.role, add.secondary]} hidden={add.hidden} onChange={(hidden) => setAdd({ ...add, hidden })} />
              </fieldset>
              <div className="grid gap-1.5"><span className="text-sm font-medium text-slate-700">Password</span><PasswordField value={add.password} onChange={(password) => setAdd({ ...add, password })} /></div>
              <MustChange checked={add.mustChange} onChange={(mustChange) => setAdd({ ...add, mustChange })} />
              <Button type="submit" disabled={saving} className="h-11 bg-brand text-brand-ink">{saving ? "Creating..." : "Create user"}</Button>
            </form>
          </DialogContent>
        </Dialog>

        {/* Edit */}
        <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader><DialogTitle>Edit {editing?.name}</DialogTitle><DialogDescription>{editing?.email}</DialogDescription></DialogHeader>
            {editing ? (
              <div className="grid gap-4">
                <label className={labelClass}>Display name
                  <Input aria-label="Display name" value={edit.fullName} maxLength={80} placeholder="e.g. Dave Smith" className="h-11" onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} />
                  <span className="text-xs font-normal text-slate-500">Shown on the Job Board, the schedule and in who-did-what. A login shared with another company can only be renamed by its owner.</span>
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className={labelClass}>Role
                    <select aria-label="Role" className={selectClass} value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as UserRole })}>{ROLES.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</select>
                    <span className="text-xs font-normal text-slate-500">{titleCase(edit.role)}: {ROLE_HELP[edit.role]}.</span>
                  </label>
                  <label className={labelClass}>Also has role
                    <select aria-label="Also has role" className={selectClass} value={edit.secondary} onChange={(e) => setEdit({ ...edit, secondary: e.target.value as UserRole | "" })}>
                      <option value="">None</option>{ROLES.filter((role) => role !== edit.role).map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}
                    </select>
                  </label>
                </div>
                {editing.id === me?.id ? <p className="-mt-2 text-xs text-slate-500">You can&apos;t remove your own admin rights; another admin can.</p> : null}
                {becomesAdmin({ role: editing.role, secondary_role: editing.secondary || null, active: editing.active }, { role: edit.role, secondary_role: edit.secondary || null, active: editing.active })
                  ? <p data-testid="admin-mfa-notice" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">{ADMIN_MFA_ONBOARDING_NOTICE}</p> : null}
                <CompanyAccessFields drafts={editAccess.drafts} onChange={(drafts) => setEditAccess((current) => ({ ...current, drafts }))}
                  self={editing.id === me?.id} loading={editAccess.loading} error={editAccess.error} />
                <label className={labelClass}>Username (sign-in)
                  <Input aria-label="Username for sign-in" value={edit.username} maxLength={32} placeholder="e.g. jsmith" autoCapitalize="none" spellCheck={false} className="h-11" onChange={(e) => setEdit({ ...edit, username: e.target.value })} />
                  <span className="text-xs font-normal text-slate-500">{USERNAME_RULES} Leave empty to remove it (they can still sign in with their email).</span>
                </label>
                {has083 && (editRoles.includes("admin") || editRoles.includes("office") || editRoles.includes("workshop")) ? (
                  <p data-testid="inspector-list-note" className="text-sm text-slate-700">Can record inspections: {editing.inspector ? "yes" : "no"}<span className="block text-xs text-slate-500">Changed under Inspectors on this page, with a reason.</span></p>
                ) : editRoles.includes("admin") || editRoles.includes("office") || editRoles.includes("workshop") ? (
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" aria-label="Can record inspections" className="mt-1 size-4" checked={!flagsError && (edit.inspector || editRoles.includes("admin"))} disabled={editRoles.includes("admin") || !!flagsError} onChange={(e) => setEdit({ ...edit, inspector: e.target.checked })} />
                    <span>Can record inspections<span className="block text-xs text-slate-500">Passes, failures and concessions are recorded in their name. Admins always can; for everyone else this is off until you tick it.</span></span>
                  </label>
                ) : null}
                {!has083 && flagsError && (editRoles.includes("office") || editRoles.includes("workshop")) && !editRoles.includes("admin") ? (
                  <div role="alert" data-testid="inspector-flags-error" className="-mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    <span>{flagsError} This setting can&apos;t be changed until it loads.</span>
                    <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void retryFlags()}>Retry</Button>
                  </div>
                ) : null}
                <fieldset className="grid gap-2"><legend className="mb-1 text-sm font-medium text-slate-700">Pages they can open</legend>
                  <PageAccess roles={editRoles} hidden={edit.hidden} onChange={(hidden) => setEdit({ ...edit, hidden })} />
                </fieldset>
                <Button disabled={saving} className="h-11 bg-brand text-brand-ink" onClick={submitEdit}>{saving ? "Saving..." : "Save changes"}</Button>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>

        {/* Set password */}
        <Dialog open={Boolean(pwFor)} onOpenChange={(open) => !open && setPwFor(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Set a new password</DialogTitle><DialogDescription>For {pwFor?.name}. Their old password stops working straight away.</DialogDescription></DialogHeader>
            <form onSubmit={submitPassword} className="grid gap-4">
              <PasswordField value={pw.password} onChange={(password) => setPw({ ...pw, password })} />
              <MustChange checked={pw.mustChange} onChange={(mustChange) => setPw({ ...pw, mustChange })} />
              <Button type="submit" disabled={saving} className="h-11 bg-brand text-brand-ink">{saving ? "Saving..." : "Set password"}</Button>
            </form>
          </DialogContent>
        </Dialog>

        {/* Password shown once */}
        <Dialog open={Boolean(shown)} onOpenChange={(open) => { if (!open) { setShown(null); setCopied(false); } }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Give {shown?.who} these details</DialogTitle><DialogDescription>This password is shown only now. {PRODUCT.name} doesn&apos;t keep a copy.</DialogDescription></DialogHeader>
            {shown ? (
              <div className="grid gap-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
                  <p className="field-label ">Sign in with</p><p className="font-mono text-base font-semibold text-slate-900">{shown.signIn}</p>
                  <p className="field-label mt-3 ">Password</p><p className="select-all break-all font-mono text-base font-semibold text-slate-900">{shown.password}</p>
                </div>
                <p className="text-xs text-slate-500">{shown.mustChange ? "They'll be asked to choose their own password when they first sign in." : "They can keep this password."}</p>
                {shown.adminMfa ? <p data-testid="admin-mfa-notice" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">{ADMIN_MFA_ONBOARDING_NOTICE}</p> : null}
                <div className="flex gap-2">
                  <Button variant="outline" className="h-11 flex-1" onClick={() => void copyPassword()}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy password"}</Button>
                  <Button className="h-11 flex-1 bg-brand text-brand-ink" onClick={() => { setShown(null); setCopied(false); }}>Done</Button>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </RoleGate>
  );
}

