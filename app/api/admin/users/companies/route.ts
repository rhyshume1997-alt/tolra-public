import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, mfaRecentRequired, readJson } from "@/lib/server/auth";
import { guard, liftDeactivationBan, banState, requireRecentAal2 } from "@/lib/server/admin-users";
import { changesAdmin } from "@/lib/mfa-policy";
import { COMPANY_ROLES, type CompanyResult, companyAccessErrorMessage, OTHER_COMPANY_LOGIN } from "@/lib/company-access";

// Admin > Users, per-company access (migration 066). POST { user_id, changes: [{ organization_id, active, role?, secondary_role? }] }
// applies each change with public.admin_set_company_access() called with the CALLER's own client, so the database decides every
// one (admin of that company, its two-step rule, last admin, no self-demotion or self-removal, a login keeps one company, support
// memberships untouched) and records it in that company's audit log. Each change is its own transaction: the response lists every
// company's outcome. The service role is used only afterwards, for the Auth sign-in ban, as the add and PATCH paths do it: the
// app's own deactivation ban is lifted only when a company switches its OWN former member back on (the database says `reactivated`),
// never for a login new to that company, so a ban another company set stays. Nothing here bans anyone: the database never leaves a
// login without an active company (last_company).

const ROLE = z.enum(COMPANY_ROLES as [string, ...string[]]);

const schema = z.object({
  user_id: z.string().uuid(),
  changes: z
    .array(z.object({ organization_id: z.string().uuid(), active: z.boolean(), role: ROLE.optional(), secondary_role: ROLE.nullable().optional() }))
    .min(1)
    .max(20)
    .refine((list) => new Set(list.map((c) => c.organization_id)).size === list.length, "Each company once"),
});

type RpcResult = { changed?: boolean; action?: string | null; active?: boolean; was_active?: boolean; reactivated?: boolean; mfa_enrolment_required?: boolean };

export async function POST(request: Request) {
  const ctx = await guard(request);
  if (ctx instanceof NextResponse) return ctx;
  const { auth, admin } = ctx;

  const json = await readJson(request, 8 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { user_id, changes } = parsed.data;

  // Names for the messages, and the companies this admin administers (the database's list, read as the caller).
  const { data: companies, error: companiesError } = await auth.supabase.rpc("my_admin_companies");
  const names = new Map(((companies ?? []) as Array<{ organization_id: string; name: string }>).map((c) => [c.organization_id, c.name]));

  // G1: decide, BEFORE the first change is sent, whether this request needs a recent authenticator code. A change that gives or takes
  // admin in any of these companies (changesAdmin, as PATCH /api/admin/users: a role or second role to or from admin, an admin switched
  // off, a switched-off admin back on) needs the second step always, and a code from the last 15 minutes when REQUIRE_ADMIN_MFA is on OR
  // when that company's own switch (organizations.require_admin_mfa) is on, which is what the database (migration 136) asks. Deciding it
  // here means a refusal can't come halfway through a request after earlier companies were already changed.
  // The stored memberships and the company switches are read with the service role (the caller's own client only sees the session
  // company's members under row-level security, which would hide the others), limited to companies this admin administers. Any read
  // that fails, or a company that is not one of theirs, counts as an admin change that needs the code (fail closed).
  const orgIds = changes.map((change) => change.organization_id);
  const mine = orgIds.filter((id) => names.has(id));
  const [storedRead, switchRead] = await Promise.all([
    admin.from("organization_members").select("organization_id, role, secondary_role, active").eq("user_id", user_id).in("organization_id", mine),
    admin.from("organizations").select("id, require_admin_mfa").in("id", mine),
  ]);
  const unreadable = Boolean(companiesError || storedRead.error || switchRead.error) || mine.length !== orgIds.length;
  const memberships = new Map((storedRead.data ?? []).map((row) => [String(row.organization_id), row]));
  const switchOn = new Map((switchRead.data ?? []).map((row) => [String(row.id), row.require_admin_mfa === true]));
  let adminChange = unreadable;
  let companySwitchOn = unreadable;
  for (const change of changes) {
    const request = { role: change.active ? change.role : undefined, secondary_role: change.active ? change.secondary_role : undefined, active: change.active };
    if (!changesAdmin(memberships.get(change.organization_id) ?? null, request)) continue;
    adminChange = true;
    if (switchOn.get(change.organization_id) !== false) companySwitchOn = true;
  }
  if (adminChange) {
    const refused = await requireRecentAal2(auth, "change who is an admin", companySwitchOn);
    if (refused) return refused;
  }

  const results: CompanyResult[] = [];
  const reactivated: string[] = [];
  let granted = false;
  let forbidden = 0;
  for (const change of changes) {
    const name = names.get(change.organization_id) ?? "that company";
    const { data, error } = await auth.supabase.rpc("admin_set_company_access", {
      p_org: change.organization_id,
      p_user: user_id,
      p_role: change.active ? change.role ?? null : null,
      p_secondary_role: change.active ? change.secondary_role ?? null : null,
      p_clear_secondary: change.active && change.secondary_role === null,
      p_active: change.active,
    });
    if (error) {
      console.error("[admin/users/companies] admin_set_company_access refused", error.code ?? "no-code", error.hint ?? "no-hint");
      // G1 (migration 136): the database asks for a recent authenticator code. The check above decides this before any change is sent, so
      // this is only a race (the code aged out between the check and the call). Nothing applied yet: the whole request is refused with the
      // code, so the browser asks and sends it again. Something already applied: say so exactly (that company's own line, below), never
      // "nothing was changed".
      if (error.hint === "mfa_recent_required" && !results.some((r) => r.ok && r.changed)) return mfaRecentRequired("change who is an admin");
      if (error.hint === "other_company_login") forbidden += 1;
      results.push({ organization_id: change.organization_id, name, ok: false, error: companyAccessErrorMessage(error, name) });
      continue;
    }
    const result = (data ?? {}) as RpcResult;
    // Only an existing, switched-off membership of that company switched back on: a new membership never lifts a ban.
    if (result.changed && result.active && result.reactivated === true) reactivated.push(change.organization_id);
    else if (result.changed && result.active && !result.was_active) granted = true;
    results.push({
      organization_id: change.organization_id,
      name,
      ok: true,
      changed: result.changed === true,
      action: result.action ?? null,
      // Given admin: the database flagged them to set up an authenticator app (065) unless they already have one.
      admin_mfa_onboarding: result.changed === true && result.mfa_enrolment_required === true,
    });
  }

  // As the add path does: lift only the app's own deactivation ban, only when a company took its own former member back, and only
  // when that company set the ban (its marker names one of the companies reactivated here: companyMayLift). A ban someone else set
  // (the platform owner, another company) stays as it is. A removal touches no ban (the login always keeps an active company).
  let loginDisabled = false;
  if (reactivated.length > 0) {
    const lifted = await liftDeactivationBan(admin, user_id, reactivated);
    if (lifted.error) console.error("[admin/users/companies] unban failed");
    loginDisabled = lifted.stillBanned;
  } else if (granted) {
    // New to that company: any ban stays exactly as it is; the page only says the login is disabled.
    loginDisabled = (await banState(admin, user_id))?.banned === true;
  }
  const ok = results.every((r) => r.ok);
  // Every change refused because the login also belongs to a company the caller does not administer (other_company_login): 403.
  const status = ok ? 200 : results.some((r) => r.ok) ? 207 : forbidden === results.length ? 403 : 409;
  return NextResponse.json({ ok, results, login_disabled: loginDisabled, ...(ok ? {} : { error: forbidden === results.length ? OTHER_COMPANY_LOGIN : "Some company access changes were not saved." }) }, { status });
}
