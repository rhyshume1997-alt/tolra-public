# Protected behaviours

Inputs: the test files named below, as they exist on `main`. Output: a list of behaviours that must not regress.
Must not change: a test named here is never weakened, skipped, deleted or loosened to get a change through. If a
protected behaviour has to change, that is its own task with explicit PM approval, and the test changes in that same PR.

Status: LIVE = the test file is on `main` today. PENDING = the release is not merged yet; the row becomes LIVE
only when its PR merges and the named file is on `main`.

| Behaviour | Status | Test file(s) that must stay green |
| --- | --- | --- |
| P0 middleware fails closed (a failed or unverified check refuses; never falls back to a profile role) | LIVE | `tests/unit/middleware-failure-paths.test.ts`, `tests/unit/middleware-early-returns.test.ts`, `tests/unit/middleware-route-roles.test.ts` |
| P0 MFA (admins held to the second step; an error reading the assurance level refuses) | LIVE | `tests/unit/mfa-guard.test.ts`, `tests/unit/mfa-step-up.test.ts`, `tests/db/privileged-aal.test.ts`, `tests/db/admin-mfa.test.ts` |
| P0 the Portal exception (separate customer authentication; signed-in staff never get a Portal session and a customer session never becomes a staff session) | LIVE | `tests/unit/middleware-route-roles.test.ts` (describe "middleware: separate customer Portal authentication") |
| Portal off by default (needs the server flag and the company switch; refuses before any cookie or database use) | LIVE | `tests/unit/portal-routes.test.ts`, `tests/unit/portal-pages.test.ts`, `tests/unit/portal-server.test.ts`, `tests/db/customer-portal-signin-154.test.ts` |
| Release 157 C1 to C5 (`jobs_zzz_integrity_guard`) | LIVE | `tests/db/jobs-integrity-157.test.ts` |
| Release 158 server time when another operator is on the job | LIVE | `tests/db/machine-run-integrity-158.test.ts` |
| Release 159 no overwrite of job drawings | LIVE | `tests/db/drawings-update-roles-159.test.ts` |
| Release 160 no browser access to the legacy reopen function | LIVE | `tests/db/legacy-reopen-revoke-160.test.ts` |
| Release 161 customer sign-off only on a released job | PENDING, PR [#536](https://github.com/rhyshume1997-alt/tolra-public/pull/536) | `tests/db/customer-signoff-completed-161.test.ts` (added by that PR) |
| Release 131 frozen fingerprints (`supabase/applied-migrations.json`; applied migrations are never edited, renamed or removed) | LIVE | `tests/unit/check-migrations.test.ts`, `tests/unit/rls-select-wrap-131.test.ts`, `tests/db/rls-select-wrap-131-legacy.test.ts` |

Notes:

- DB tests (`tests/db/*`) run on the disposable test stack in CI (`npm run test:db`), not in the quick unit run.
- Release 159 (PR #534) edited the 131 tests; they stay protected and must not be weakened.
