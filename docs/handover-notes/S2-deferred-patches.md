# S2 deferred patches (files owned by the Design session)

Unit S2 (role checks by URL and by API), Fri 30 Oct. `middleware.ts` is being edited by the Design session, so S2 did not change it.
The patch below is for the owner of that file to apply.

## S2-F1 (Low): percent-encoded paths skip the page gate

**What happens.** `middleware.ts` compares `request.nextUrl.pathname` with `ROUTE_ROLES`, `sectionForPath` and the platform and
company-step checks. That pathname is the raw one, so `/%61dmin/users` has no `/admin` rule. Outside dev, a `next start` server
also matches the DECODED path to a page (`node_modules/next/dist/server/lib/router-utils/filesystem.js`, `getItem`, "check decoded
variant as well", guarded by `!opts.dev`). So a workshop or office login that types `/%61dmin/users`, `/admin%2Fusers` or
`/%73ettings` gets the page shell, and the per-person hidden sections are skipped the same way.

**Impact.** Low. The page shell renders, but the page's client `RoleGate` shows Access Denied, the tables refuse the rows (RLS
`has_org_role`), and every API route guards itself (`tests/unit/api-role-matrix.test.ts`). The real page gate is still bypassed,
and so is the hidden-sections block on pages whose data is not RLS-restricted (`data: false` in `lib/sections.ts`: jobs, schedule,
delivery notes, customers, suppliers).

**Not proven.** I read this from Next's code; I could not run it, because `next build` is not allowed here, and `next dev` does
not decode, so it would not reproduce. I also have not checked whether Vercel's router decodes before matching.

**Patch.**

```diff
diff --git a/middleware.ts b/middleware.ts
index 5b63b7c..a965730 100644
--- a/middleware.ts
+++ b/middleware.ts
@@ -37,7 +37,14 @@ const OFFLINE_ROUTES = ["/jobs", "/schedule", "/time"];
 export async function middleware(request: NextRequest) {
   const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
   const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
-  const path = request.nextUrl.pathname;
+  let path = request.nextUrl.pathname;
+  // Match on the path Next.js serves: outside dev it also matches the DECODED path to a page (next/dist/server/lib/router-utils/
+  // filesystem.js getItem), so /%61dmin/users renders /admin/users. Decoding once here (as Next does) keeps every check below on that path.
+  try {
+    path = decodeURIComponent(path);
+  } catch {
+    // Malformed escapes: Next serves no page for them either; keep the raw path.
+  }
   const isAsset = path.startsWith("/_next") || path === "/favicon.ico" || ASSET_PATTERN.test(path);
   const isConfigurationError = path === "/configuration-error";
   const isApi = path.startsWith("/api/");
```

The patch decodes once, as Next does. A double-encoded path (`/%2561dmin`) is decoded once to `/%61dmin`, which Next does not
serve either, so it 404s.

**Test.** `tests/unit/middleware-role-matrix.test.ts` already has the case, as
`it.fails("percent-encoded paths are gated too ...")`. Right now it passes because the gap is open. After the patch it fails, so
change it to a plain `it(`. Local proof with the patch applied: `npx vitest run tests/unit/middleware-role-matrix.test.ts
tests/unit/admin-mfa-onboarding.test.ts tests/unit/access-ended-signal.test.ts tests/unit/session-policy.test.ts` gave
4 files and 76 tests passing once the `it.fails` was changed to `it`, and that test failing while it was left as `it.fails`.
