# S4 deferred patches (files owned by the Design session)

## D1. A stale `tolra_last_active` cookie ends a fresh sign-in (Low: fails closed, usability)

**Where:** `middleware.ts:112-120` (reads/sets the cookie), `app/api/auth/signin/route.ts` (success path), `lib/use-user.ts:95-115` (manual sign-out).

**Why:** `tolra_last_active` is HttpOnly (30 days) and is only refreshed by the middleware on a signed-in page request and deleted
only when the middleware itself ends a sign-in for idleness. A normal sign-out (browser `supabase.auth.signOut()` + `clearAuthCookies()`)
cannot delete an HttpOnly cookie, and neither `/login` (signed out: the middleware returns before setting it) nor `POST /api/auth/signin`
(`isApi` returns early) refreshes it. So: sign out at 17:00, sign in at 07:00 the next day (> 12 h) -> the first page after sign-in finds
`idleExceeded(...)` true, signs the NEW session out and shows "signed out after 12 hours without use". The second sign-in works (the
cookie was deleted by that redirect). Found by reading only; not reproduced (needs the e2e stack).

**Patch** (`app/api/auth/signin/route.ts`, success path only):

```diff
@@ imports
 import { withGatewayRetry } from "@/lib/server/resilient-fetch";
+import { LAST_ACTIVE_COOKIE } from "@/lib/session-policy";
@@ after the last_login_at update, before `return NextResponse.json({ ok: true });`
+  // A new sign-in starts a fresh idle clock: the last-use cookie (HttpOnly) can outlive a normal sign-out, and the middleware
+  // would otherwise end this new sign-in at its first page for the old session's idleness.
+  cookieStore.set(LAST_ACTIVE_COOKIE, String(Date.now()), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
   return NextResponse.json({ ok: true });
```

(The same attributes the middleware uses at `middleware.ts:120`.) Does not weaken the idle rule: it only applies to a session that has
just proved the password.

**Test (e2e, extend `tests/e2e/session-timeout.spec.ts`):** sign in as office, sign out from the menu, `context.addCookies` a
`tolra_last_active` of `Date.now() - 13h`, sign in again, `goto("/quotes")` -> expect `/quotes` (today: `/login?expired=1`).
Mutation: drop the added line -> the spec lands on `/login?expired=1`.
