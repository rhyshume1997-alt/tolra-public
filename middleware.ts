import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { MFA_ENROL_PARAM, adminMfaRequired, holdsAdmin, shouldCheckEnrolment } from "@/lib/mfa-policy";
import { accessEndedCookie } from "@/lib/offline/access";
import { companyStepRoute, parseSessionInfo } from "@/lib/session-info";
import { sectionForPath } from "@/lib/sections";
import { EXPIRED_NOTICE_COOKIE, EXPIRED_NOTICE_MAX_AGE_S, LAST_ACTIVE_COOKIE, OFFICE_IDLE_TIMEOUT_MS, expiredSignInRedirect, idleExceeded } from "@/lib/session-policy";

const ASSET_PATTERN = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|woff2?|ttf|otf)$/i;
const SECURE_COOKIES = process.env.NODE_ENV === "production";

const ALL_ROLES = ["admin", "office", "workshop", "viewer"];
// First matching prefix wins. Client-side RoleGate is cosmetic; this is the real gate.
const ROUTE_ROLES: Array<[string, string[]]> = [
  ["/admin", ["admin"]],
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
];

/** Pages that work from the device's offline copy when Supabase can't be reached (Job Board, worksheets, schedule, pack, job sheet). */
const OFFLINE_ROUTES = ["/jobs", "/schedule", "/time"];

export async function middleware(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const path = request.nextUrl.pathname;
  const isAsset = path.startsWith("/_next") || path === "/favicon.ico" || ASSET_PATTERN.test(path);
  const isConfigurationError = path === "/configuration-error";
  const isApi = path.startsWith("/api/");

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isAsset || isConfigurationError || isApi) return NextResponse.next();
    return NextResponse.redirect(new URL("/configuration-error", request.url));
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
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

  const { data, error: authError } = await supabase.auth.getUser();
  // Supabase unreachable (not "signed out"): the workshop pages still open for someone holding a session cookie, so
  // they can work from this device's offline copy (lib/offline). These pages are client shells with no data in
  // them; every record still comes from Supabase (or the device's own copy), so nothing is exposed by letting the
  // shell through. Everything else waits for Supabase as before.
  const authUnreachable = !data.user && !!authError && (authError.name === "AuthRetryableFetchError" || authError.status === 0 || (authError.status ?? 0) >= 500);
  const hasSessionCookie = request.cookies.getAll().some((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name));
  const offlineCapable = OFFLINE_ROUTES.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
  if (authUnreachable && hasSessionCookie && offlineCapable) return response;
  const isLogin = path === "/login";
  const isAuthApi = path.startsWith("/api/auth/");
  const isRoleSelect = path === "/select-role";
  // Invite / password-reset landing page: it creates the session itself from the link, so it must open signed out
  // (and must not bounce a freshly signed-in user to /dashboard before they have chosen a password).
  const isSetPassword = path === "/auth/set-password";
  // Installable-app files: needed before sign-in (installing from the sign-in page, the offline page).
  const isPwaFile = path === "/manifest.webmanifest" || path === "/offline.html" || path === "/sw.js";

  if (isAsset) return response;
  if (isConfigurationError) return response;
  if (isApi) return response;
  if (isAuthApi) return response;
  if (isSetPassword) return response;
  if (isPwaFile) return response;
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

  const rule = ROUTE_ROLES.find(([prefix]) => path === prefix || path.startsWith(prefix + "/"));
  type ProfileRow = { role: string | null; secondary_role: string | null; active: boolean | null; organization_id: string | null; must_change_password?: boolean | null };
  let { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("role, secondary_role, active, organization_id, must_change_password")
    .eq("id", data.user.id)
    .maybeSingle<ProfileRow>();
  if (profileError?.code === "42703") {
    // Migration 012 not run yet (no must_change_password column): carry on without it.
    ({ data: profile, error: profileError } = await supabase
      .from("user_profiles")
      .select("role, secondary_role, active, organization_id")
      .eq("id", data.user.id)
      .maybeSingle<ProfileRow>());
  }

  if (!profileError && !profile?.active) {
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
  let session = null as ReturnType<typeof parseSessionInfo>;
  if (profile && !profileError) {
    const { data: sessionData, error: sessionError } = await supabase.rpc("my_session");
    // If the answer can't be read the page checks fall back to the profile's copy; the database still decides what data is returned.
    session = sessionError ? null : parseSessionInfo(sessionData);
  }
  const working = session?.organization_id ? { role: session.role, secondary_role: session.secondary_role, organization_id: session.organization_id } : session ? null : profile;

  // An admin needs the second step (authenticator app) before any page: set it up the first time, then a code at each
  // sign-in (lib/mfa-policy.ts). The API routes and the database check the same, so this is not the only gate. The
  // platform owner always needs it, whatever REQUIRE_ADMIN_MFA says.
  if ((adminMfaRequired() && holdsAdmin(working)) || session?.platform_admin === true) {
    const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assurance?.currentLevel !== "aal2") return path === "/mfa" ? response : redirectTo("/mfa");
  }
  // Someone another admin has just made an admin (migration 065) sets up an authenticator app before anything else, even while
  // REQUIRE_ADMIN_MFA is off. Only to ENROL: once they have a verified factor this stops, and no code is asked for unless the switch
  // is on. The database answers FALSE for the last admin who can still sign in normally; any error counts as "not required" (the
  // global gate above is unchanged).
  if (path !== "/mfa" && session?.platform_admin !== true) {
    const globalRequired = adminMfaRequired();
    const admin = holdsAdmin(working);
    if (shouldCheckEnrolment({ globalRequired, holdsAdmin: admin })) {
      const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (shouldCheckEnrolment({ globalRequired, holdsAdmin: admin, currentLevel: assurance?.currentLevel, nextLevel: assurance?.nextLevel })) {
        const { data: enrolmentRequired, error: enrolmentError } = await supabase.rpc("my_mfa_enrolment_required");
        if (!enrolmentError && enrolmentRequired === true) return redirectTo(`/mfa?${MFA_ENROL_PARAM}=1`);
      }
    }
  }
  // /mfa is also open to anyone signed in when the second step is not required (setting it up early is allowed).
  if (path === "/mfa") return response;

  if (isLogin) return redirectTo("/dashboard");

  // Company step: the platform owner's list, or the choice between a person's own companies.
  const step = companyStepRoute(session, path);
  if (step) return redirectTo(step);
  if (path === "/platform" || path.startsWith("/platform/") || path === "/choose-company" || path.startsWith("/choose-company/")) return response;

  if (isRoleSelect) return response;

  // Per-person page access (Admin > Users > Page access). The database also refuses the data for most sections.
  const section = sectionForPath(path);
  if (section && session?.hidden_sections.includes(section)) return redirectTo("/dashboard?blocked=1");

  if (rule) {
    const roles = [working?.role, working?.secondary_role].filter(Boolean) as string[];
    if (profileError || !roles.some((role) => rule[1].includes(role))) return redirectTo("/dashboard");
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
