/**
 * BOUNDARY (module 1): request pathname and staff session -> pass-through or staff redirect.
 * Only /portal and /portal/ descendants delegate to the Portal pages' flag/session guards.
 * Protected pages require verified Auth, profile and company-session reads; outages return 503 without cookie changes.
 * Must preserve every staff authentication, role, MFA and company check for other paths.
 */
import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isAuthApiError } from "@supabase/supabase-js";

import { AI_HELPER_ROLES } from "@/lib/ai-helper/flag";
import { MFA_ENROL_PARAM, adminMfaRequired, holdsAdmin, shouldCheckEnrolment } from "@/lib/mfa-policy";
import { accessEndedCookie } from "@/lib/offline/access";
import { companyStepRoute, parseSessionInfo } from "@/lib/session-info";
import { withGatewayRetry } from "@/lib/server/resilient-fetch";
import { sectionForPath } from "@/lib/sections";
import { EXPIRED_NOTICE_COOKIE, EXPIRED_NOTICE_MAX_AGE_S, LAST_ACTIVE_COOKIE, OFFICE_IDLE_TIMEOUT_MS, expiredSignInRedirect, idleExceeded } from "@/lib/session-policy";

const ASSET_PATTERN = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|woff2?|ttf|otf)$/i;
// The crawler's sitemap needs no sign-in: this exact path only (no .xml rule, so no other path ending .xml skips the checks). The home
// page's images (/brand/, /marketing/, /icons/) are .png, .svg and .ico files, which ASSET_PATTERN already covers.
const SITEMAP_PATH = "/sitemap.xml";
const SECURE_COOKIES = process.env.NODE_ENV === "production";

const isPortalCustomerPage = (pathname: string): boolean => pathname === "/portal" || pathname.startsWith("/portal/");

const ALL_ROLES = ["admin", "office", "workshop", "viewer"];
// First matching prefix wins. Client-side RoleGate is cosmetic; this is the real gate.
const ROUTE_ROLES: Array<[string, string[]]> = [
  ["/admin", ["admin"]],
  // Numbers (the history of invoiced, received and machine time): the owner's page, admin only.
  ["/numbers", ["admin"]],
  ["/invoices", ["admin", "office"]],
  ["/sales-orders", ["admin", "office"]],
  ["/settings", ["admin"]],
  ["/approval", ["admin", "office"]],
  ["/email", ["admin", "office"]],
  ["/quotes", ["admin", "office"]],
  ["/rfq", ["admin", "office"]],
  ["/suppliers", ["admin", "office"]],
  ["/customers", ["admin", "office"]],
  ["/purchase-orders", ["admin", "office"]],
  ["/jobs", ALL_ROLES],
  ["/schedule", ALL_ROLES],
  ["/delivery-notes", ["admin", "office", "workshop"]],
  // Time and pay (050 to 052): the person's own sheet for workshop; everyone's for admin and office (the database decides what each sees).
  ["/time", ["admin", "office", "workshop"]],
  // The AI helper: office and admin only, as its API routes and the database (101).
  ["/ai-helper", [...AI_HELPER_ROLES]],
];

/** Only verified denial ends authentication; unavailable reads never imply a role or sign-out. Retry belongs to the safe transport. */
type Lookup<T> = { kind: "verified"; data: T } | { kind: "denied" } | { kind: "unavailable" };
type ReadResult<T> = { data: T; error: unknown; status?: number };
type ReadScope = "authentication" | "authorisation";
const INVALID_SESSION_CODES = new Set(["refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired"]);
function lookupFailure(error: unknown, status: number | undefined, scope: ReadScope): "denied" | "unavailable" {
  const detail = error && typeof error === "object" ? error as { status?: number; code?: string; name?: string } : {};
  const http = status ?? detail.status;
  if (http === 0 || (http !== undefined && http >= 500)) return "unavailable";
  // GoTrue uses 400 for these confirmed invalid sessions. Do not generalise arbitrary 400s or database errors into sign-out.
  if (scope === "authentication" && http !== undefined && http >= 400 && http < 500
      && isAuthApiError(error) && INVALID_SESSION_CODES.has(error.code ?? "")) return "denied";
  if (http === 401 || http === 403 || detail.code === "42501" || detail.name === "AuthSessionMissingError") return "denied";
  // Includes network exceptions, malformed responses and missing database capabilities. None can prove authorisation.
  return "unavailable";
}
async function verifiedRead<T>(read: () => PromiseLike<ReadResult<T>>, scope: ReadScope = "authorisation"): Promise<Lookup<T>> {
  try {
    const result = await read();
    if (result.error || (result.status !== undefined && (result.status === 0 || result.status >= 400))) {
      return { kind: lookupFailure(result.error, result.status, scope) };
    }
    return { kind: "verified", data: result.data };
  } catch (error) {
    return { kind: lookupFailure(error, undefined, scope) };
  }
}
/** Validate security-bearing RPC fields before the shared display parser can apply defaults. */
function hasVerifiedSessionShape(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  const nullableText = (value: unknown) => value === null || (typeof value === "string" && value.length > 0);
  return typeof row.user_id === "string" && row.user_id.length > 0
    && nullableText(row.organization_id) && nullableText(row.role) && nullableText(row.secondary_role)
    && typeof row.platform_admin === "boolean" && typeof row.needs_choice === "boolean"
    && typeof row.organization_count === "number" && Number.isSafeInteger(row.organization_count) && row.organization_count >= 0
    && Array.isArray(row.hidden_sections) && row.hidden_sections.every((section) => typeof section === "string");
}
function hasVerifiedAssurance(raw: unknown): raw is { currentLevel: "aal1" | "aal2"; nextLevel: "aal1" | "aal2" } {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as Record<string, unknown>;
  return (row.currentLevel === "aal1" || row.currentLevel === "aal2") && (row.nextLevel === "aal1" || row.nextLevel === "aal2");
}
const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
const unavailable = () => NextResponse.json({ error: "Service temporarily unavailable. Please try again." }, {
  status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" },
});

export async function middleware(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const path = request.nextUrl.pathname;
  const isAsset = path.startsWith("/_next") || path === "/favicon.ico" || path === SITEMAP_PATH || ASSET_PATTERN.test(path);
  const isConfigurationError = path === "/configuration-error";
  const isApi = path.startsWith("/api/");

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isAsset || isConfigurationError || isApi) return NextResponse.next();
    return NextResponse.redirect(new URL("/configuration-error", request.url));
  }

  // Installable-app files: needed before sign-in (installing from the sign-in page, the offline page).
  const isPwaFile = path === "/manifest.webmanifest" || path === "/offline.html" || path === "/sw.js";
  // Files and the installable-app files never depended on who is signed in: they return here, before the auth server and the
  // database are asked anything (phone lag: getUser, user_profiles and my_session ran first, in series, for every one of them).
  // The API does not: its getUser below refreshes an expiring session and writes the new cookies on the response (the routes'
  // own clients are read-only and would use up the refresh token without saving the new one).
  if (isAsset || isPwaFile) return NextResponse.next({ request });

  // Customer pages check the platform flag before cookies, then resolve the separate Release 154 session.
  // Never consult, refresh or clear the staff session for this exact namespace. API routes keep their own guards.
  if (isPortalCustomerPage(path)) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    global: { fetch: withGatewayRetry() },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        const previous = response.cookies.getAll();
        response = NextResponse.next({ request });
        // SDK refresh/removal can emit more than one batch (including chunked cookies); preserve every prior operation.
        previous.forEach((cookie) => response.cookies.set(cookie));
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, { ...options, secure: SECURE_COOKIES }));
      },
    },
  });

  // Redirects must carry any refreshed (or cleared) auth cookies, otherwise the browser keeps a stale session.
  const redirectTo = (target: string) => {
    const redirect = NextResponse.redirect(new URL(target, request.url));
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  };

  const auth = await verifiedRead<Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]>(() => supabase.auth.getUser(), "authentication");
  const data = auth.kind === "verified" ? auth.data : { user: null };
  const hasSessionCookie = request.cookies.getAll().some((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name));
  const isLogin = path === "/login";
  const isRoleSelect = path === "/select-role";
  // Invite / password-reset landing page: it creates the session itself from the link, so it must open signed out
  // (and must not bounce a freshly signed-in user to /dashboard before they have chosen a password).
  const isSetPassword = path === "/auth/set-password";

  if (isConfigurationError) return response;
  // Each route checks the caller itself; the middleware only refreshed the session cookies above.
  if (isApi) return response;
  if (isSetPassword) return response;
  // The public home page: signed-out visitors see it, a signed-in person goes straight to the dashboard (as "/" always did).
  if (path === "/") return data.user ? redirectTo("/dashboard") : response;
  // The public privacy page: open to everyone, signed in or not (it is a plain page, so there is nothing to protect or redirect).
  if (path === "/privacy") return response;
  if (auth.kind === "unavailable") return isLogin ? response : unavailable();
  if (!data.user && isLogin && request.nextUrl.searchParams.get("expired") !== "1" && expiredSignInRedirect({
    hasAuthCookie: hasSessionCookie,
    lastActive: request.cookies.get(LAST_ACTIVE_COOKIE)?.value,
    notice: request.cookies.get(EXPIRED_NOTICE_COOKIE)?.value,
    now: Date.now(),
  })) {
    // The page that was open when the sign-in expired sent the browser to a plain /login: keep the reason.
    const ended = redirectTo("/login?expired=1");
    ended.cookies.delete(LAST_ACTIVE_COOKIE);
    ended.cookies.set(EXPIRED_NOTICE_COOKIE, "1", { sameSite: "lax", secure: SECURE_COOKIES, path: "/", maxAge: EXPIRED_NOTICE_MAX_AGE_S });
    return ended;
  }
  if (!data.user) return isLogin ? response : redirectTo("/login");

  const rule = ROUTE_ROLES.find(([prefix]) => path === prefix || path.startsWith(prefix + "/"));
  type ProfileRow = { role: string | null; secondary_role: string | null; active: boolean | null; organization_id: string | null; must_change_password?: boolean | null };
  const profileRead = await verifiedRead(() => supabase
    .from("user_profiles")
    .select("role, secondary_role, active, organization_id, must_change_password")
    .eq("id", data.user.id)
    .maybeSingle<ProfileRow>());
  if (profileRead.kind === "unavailable") return unavailable();
  if (profileRead.kind === "denied") return forbidden();
  const profile = profileRead.data;
  if (profile && (typeof profile.active !== "boolean" || typeof profile.must_change_password !== "boolean")) return unavailable();

  if (!profile?.active) {
    // Deactivated (or profile-less) accounts lose their session immediately.
    await supabase.auth.signOut();
    const out = isLogin && request.nextUrl.searchParams.get("disabled") === "1" ? response : redirectTo("/login?disabled=1");
    // The sign-out clears the auth cookies, so an open tab (this request may be a prefetch it never sees) would find "no session"
    // and take it for a timeout. This mark says access ENDED: open tabs lock and the offline copy can't be reopened (B23, keep and
    // lock: nothing is deleted). It can only suspend; it never grants anything.
    const ended = accessEndedCookie(data.user.id);
    out.cookies.set(ended.name, ended.value, { ...ended.options, secure: SECURE_COOKIES });
    return out;
  }

  // An admin set this person's password: they choose their own before anything else.
  if (profile?.must_change_password) return redirectTo("/auth/set-password?required=1");

  // The company this sign-in session works in comes from the database (migration 036), not from the profile's copy: a person
  // with several companies chooses one for each sign-in, and the platform owner must pick one first. The database refuses
  // business data without a chosen company whatever this redirect does.
  const sessionRead = await verifiedRead(() => supabase.rpc("my_session"));
  if (sessionRead.kind === "unavailable") return unavailable();
  if (sessionRead.kind === "denied") return forbidden();
  if (sessionRead.data === null) return isLogin ? response : redirectTo("/login");
  if (!hasVerifiedSessionShape(sessionRead.data)) return unavailable();
  const session = parseSessionInfo(sessionRead.data);
  if (!session || session.user_id !== data.user.id) return unavailable();
  // Migration 036 is required: the profile is never a substitute for this session's company or permissions.
  const working = session.organization_id ? { role: session.role, secondary_role: session.secondary_role, organization_id: session.organization_id } : null;

  // Verify required reads before idle side effects; defer verified MFA routing so idle expiry retains precedence.
  let verifiedMfaTarget: string | null = null;
  // An admin needs the second step (authenticator app) before any page: set it up the first time, then a code at each
  // sign-in (lib/mfa-policy.ts). The API routes and the database check the same, so this is not the only gate. The
  // platform owner always needs it, whatever REQUIRE_ADMIN_MFA says.
  if ((adminMfaRequired() && holdsAdmin(working)) || session?.platform_admin === true) {
    const assuranceRead = await verifiedRead(() => supabase.auth.mfa.getAuthenticatorAssuranceLevel());
    if (assuranceRead.kind === "unavailable") return unavailable();
    if (assuranceRead.kind === "denied") return forbidden();
    const assurance = assuranceRead.data;
    if (!hasVerifiedAssurance(assurance)) return unavailable();
    if (assurance.currentLevel !== "aal2" && path !== "/mfa") verifiedMfaTarget = "/mfa";
  }
  // Someone another admin has just made an admin (migration 065) sets up an authenticator app before anything else, even while
  // REQUIRE_ADMIN_MFA is off. Only to ENROL: once they have a verified factor this stops, and no code is asked for unless the switch
  // is on. The database answers FALSE for the last admin who can still sign in normally; an unreadable answer never bypasses it.
  if (path !== "/mfa" && session?.platform_admin !== true) {
    const globalRequired = adminMfaRequired();
    const admin = holdsAdmin(working);
    if (shouldCheckEnrolment({ globalRequired, holdsAdmin: admin })) {
      const assuranceRead = await verifiedRead(() => supabase.auth.mfa.getAuthenticatorAssuranceLevel());
      if (assuranceRead.kind === "unavailable") return unavailable();
      if (assuranceRead.kind === "denied") return forbidden();
      const assurance = assuranceRead.data;
      if (!hasVerifiedAssurance(assurance)) return unavailable();
      if (shouldCheckEnrolment({ globalRequired, holdsAdmin: admin, currentLevel: assurance?.currentLevel, nextLevel: assurance?.nextLevel })) {
        const enrolmentRead = await verifiedRead(() => supabase.rpc("my_mfa_enrolment_required"));
        if (enrolmentRead.kind === "unavailable") return unavailable();
        if (enrolmentRead.kind === "denied") return forbidden();
        if (typeof enrolmentRead.data !== "boolean") return unavailable();
        if (enrolmentRead.data === true) verifiedMfaTarget = `/mfa?${MFA_ENROL_PARAM}=1`;
      }
    }
  }
  // A sign-in left unused for longer than the office limit ends here too (a browser reopened the next morning). The cookie is
  // refreshed on every page request, including in-app navigation; the browser also watches for idleness while a page is open
  // (lib/use-idle-sign-out.ts). Offline changes on the device are not touched by this. See lib/session-policy.ts.
  const lastActive = request.cookies.get(LAST_ACTIVE_COOKIE)?.value;
  if (!isLogin && idleExceeded(lastActive, Date.now(), OFFICE_IDLE_TIMEOUT_MS)) {
    await supabase.auth.signOut();
    const ended = redirectTo("/login?expired=1");
    ended.cookies.delete(LAST_ACTIVE_COOKIE); // so signing in again starts a fresh clock
    ended.cookies.set(EXPIRED_NOTICE_COOKIE, "1", { sameSite: "lax", secure: SECURE_COOKIES, path: "/", maxAge: EXPIRED_NOTICE_MAX_AGE_S });
    return ended;
  }
  response.cookies.set(LAST_ACTIVE_COOKIE, String(Date.now()), { httpOnly: true, sameSite: "lax", secure: SECURE_COOKIES, path: "/", maxAge: 60 * 60 * 24 * 30 });

  if (verifiedMfaTarget) return redirectTo(verifiedMfaTarget);

  // /mfa is also open to anyone signed in when the second step is not required (setting it up early is allowed).
  if (path === "/mfa") return response;

  if (isLogin) return redirectTo("/dashboard");

  // Company step: the platform owner's list, or the choice between a person's own companies.
  const step = companyStepRoute(session, path);
  if (step) return redirectTo(step);
  if (path === "/platform" || path.startsWith("/platform/")) return session.platform_admin ? response : forbidden();
  if (path === "/choose-company" || path.startsWith("/choose-company/")) return session.organization_count > 0 ? response : forbidden();

  if (!working || ![working.role, working.secondary_role].some((role) => role && ALL_ROLES.includes(role))) {
    return forbidden();
  }
  if (isRoleSelect) return response;

  // Per-person page access (Admin > Users > Page access). The database also refuses the data for most sections.
  const section = sectionForPath(path);
  if (section && session?.hidden_sections.includes(section)) return redirectTo("/dashboard?blocked=1");

  if (rule) {
    const roles = [working?.role, working?.secondary_role].filter(Boolean) as string[];
    if (!roles.some((role) => rule[1].includes(role))) return redirectTo("/dashboard");
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
