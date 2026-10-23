import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { MFA_REQUIRED_CODE, adminMfaRequired, holdsAdmin } from "@/lib/mfa-policy";
import { type SessionInfo, parseSessionInfo } from "@/lib/session-info";
import { withGatewayRetry } from "@/lib/server/resilient-fetch";

export type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  secondary_role: string | null;
  organization_id: string;
  active: boolean;
  must_change_password: boolean;
};

/** `profile` carries the company and roles of THIS session's company (not the profile row's copy); `session` is the database's full answer. */
export type AuthContext = { supabase: SupabaseClient; user: User; profile: Profile; session: SessionInfo | null };

/** Read-only cookie client: API routes never write auth cookies (middleware refreshes them). */
export async function createSupabaseServerClient(): Promise<SupabaseClient | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return null;

  const cookieStore = await cookies();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    global: { fetch: withGatewayRetry() },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => undefined,
    },
  });
}

export function jsonError(message: string, status: number, init?: { headers?: Record<string, string> }) {
  return NextResponse.json({ error: message }, { status, headers: init?.headers });
}

/** 403 for a session that must choose its own password first; the code lets the browser send them to set-up. */
export function passwordChangeRequired() {
  return NextResponse.json({ error: "Choose your own password first.", code: "password_change_required" }, { status: 403 });
}

/** 403 for an admin session that hasn't passed the second step; the code lets the browser send them to /mfa. */
export function mfaRequired() {
  return NextResponse.json({ error: "Confirm your authenticator code first.", code: MFA_REQUIRED_CODE }, { status: 403 });
}

/** 403 with a server log line naming which check refused (codes only, never personal data). */
function refuse(reason: string, code?: string) {
  console.error("[auth] request refused:", reason, code ?? "");
  return jsonError("Forbidden", 403);
}

export function isErrorResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

/**
 * Resolves the signed-in user and their active profile, or returns a NextResponse to send back:
 * 401 not signed in, 403 inactive / no profile / role not allowed, 503 not configured.
 * A user matches when either their role or secondary role is in `roles`.
 */
export async function requireProfile(roles?: string[]): Promise<AuthContext | NextResponse> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return jsonError("Service unavailable", 503);

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return jsonError("Unauthorized", 401);

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("id, email, full_name, role, secondary_role, organization_id, active, must_change_password")
    .eq("id", user.id)
    .maybeSingle<Profile>();

  if (profileError || !profile || profile.active !== true) return refuse("profile", profileError?.code);
  // Signed in with a password an admin set: nothing but choosing their own password until they do (the database
  // refuses business data too, migration 014).
  if (profile.must_change_password !== false) return passwordChangeRequired();

  // The company and roles come from the database's answer for this sign-in session (migration 036): the profile row only holds a
  // copy of the person's last company. No company chosen, an ended support window or a deactivated membership all end here.
  const { data: currentOrg, error: orgError } = await supabase.rpc("current_user_organization_id");
  if (orgError || !currentOrg) return refuse(orgError ? "organisation-check" : "organisation-choice", orgError?.code);
  const { data: sessionData, error: sessionError } = await supabase.rpc("my_session");
  if (sessionError) return refuse("session", sessionError.code);
  const session = parseSessionInfo(sessionData);
  if (session) {
    if (!session.organization_id || session.organization_id !== currentOrg || !session.role) return refuse("organisation-mismatch");
    profile.organization_id = session.organization_id;
    profile.role = session.role;
    profile.secondary_role = session.secondary_role;
  } else if (currentOrg !== profile.organization_id) {
    return refuse("organisation-mismatch");
  }

  // An admin needs the second step (authenticator app) for every route behind this guard: settings, users and roles,
  // payments, the year-end export, mail, and any other admin-only route (lib/mfa-policy.ts).
  if ((adminMfaRequired() && holdsAdmin(profile)) || session?.platform_admin === true) {
    const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError || assurance?.currentLevel !== "aal2") return mfaRequired();
  }

  if (roles && roles.length) {
    const held = [profile.role, profile.secondary_role].filter(Boolean) as string[];
    if (!held.some((role) => roles.includes(role))) return refuse("profile-role");
  }

  // The role check proper is the database's (it also requires an ACTIVE membership in an active organisation).
  if (roles && roles.length) {
    const { data: allowed, error: roleError } = await supabase.rpc("has_org_role", { allowed_roles: roles });
    if (roleError || allowed !== true) return refuse("role", roleError?.code);
  }

  return { supabase, user, profile, session };
}

/**
 * CSRF guard for state-changing routes. When the browser sends an Origin header it must match the host the
 * request was made to (Host / X-Forwarded-Host). Sec-Fetch-Site: cross-site is refused too. Requests without
 * an Origin (curl, server to server) pass: they still need the session cookie and cannot be forged by a page.
 */
export function sameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const allowed = new Set<string>();
  const host = request.headers.get("host");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (host) allowed.add(host);
  if (forwardedHost) allowed.add(forwardedHost);
  try {
    allowed.add(new URL(request.url).host);
  } catch {
    // ignore
  }
  return allowed.has(originHost);
}

export function forbiddenOrigin() {
  return jsonError("Forbidden", 403);
}

/** Last hop of x-forwarded-for is the one added by our own proxy; earlier hops are client-controlled. */
export function clientIp(request: Request): string | null {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1].slice(0, 64) : null;
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) return { ok: false, response: jsonError("Payload too large", 413) };
  try {
    const text = await request.text();
    if (text.length > maxBytes) return { ok: false, response: jsonError("Payload too large", 413) };
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, response: jsonError("Invalid request", 400) };
  }
}
