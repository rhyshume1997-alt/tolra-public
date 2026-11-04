# S1–S4 security proof plan: #84

Builder 4, 4 November 2026. Separate draft based on #84 `claude/pr48-final` at `4765566`. Rhys explicitly assigned this follow-up. Existing implementation/permissions remain unchanged. Build/test by 6 November; go-live target 12 November. A pass here does not establish a pass on the integrated final release.

## Required proofs

| Item | Exact files | Required result / limit |
| --- | --- | --- |
| S1 | `tests/db/rls-two-tenant-proof.test.ts`, `tests/scripts/rls-two-tenant-proof.sql`, new `tests/db/s1-reverse-tenant-proof.test.ts` | Catalogue discovers public/security_audit tables with organization_id. Admin, office, workshop, viewer and anon cannot read/insert/update/move/delete another company's rows. Original alpha→beta and added beta→alpha pass with policies alone and deployed-trigger checks. Zero failures, rolled-back fixture, no synthetic company left. Historical attempt captions retain beta names in the reversed test; actual tenant bindings swap. |
| S1 complement | `tests/db/tenancy.test.ts`, `tests/db/definer-functions.test.ts` | Actual API CRUD and security-definer calls isolate companies with positive own-company controls. Generic SQL is not the sole proof. |
| S2 | `tests/unit/api-role-matrix.test.ts`, `tests/unit/middleware-role-matrix.test.ts`, `tests/unit/api-route-guards.test.ts` | Discover every route/page; pin permitted/refused roles including secondary roles/support in existing personas; guards precede work. Deliberate exclusions stay explicit in source; do not call them tested. A hidden sidebar link is not access control. |
| S3 | New `tests/unit/s3-s4-cutover-inputs.test.ts`, existing `tests/unit/check-bundle.test.ts`, `tests/unit/csv-and-dates.test.ts` | Real mail header helper flattens CR/LF/control/Unicode separators and preserves harmless references. Bundle fixture checks detect server secrets without exposing them. Full built-bundle and import/route regressions remain separate. |
| S4 | `tests/unit/csrf-origin.test.ts`, new `tests/unit/s3-s4-cutover-inputs.test.ts` | Existing route scan requires origin guard before work. New canonical-host cases reject deceptive hosts, foreign/opaque origins, other ports and cross-site fetch. These are structural/input proofs, not live cookie attack evidence. |

## Runs without a database

Run from this branch root:

```sh
npx vitest run tests/unit/api-role-matrix.test.ts tests/unit/middleware-role-matrix.test.ts tests/unit/api-route-guards.test.ts tests/unit/csrf-origin.test.ts tests/unit/check-bundle.test.ts tests/unit/csv-and-dates.test.ts tests/unit/s3-s4-cutover-inputs.test.ts
npm run typecheck
npx eslint tests/unit/s3-s4-cutover-inputs.test.ts tests/db/s1-reverse-tenant-proof.test.ts
```

Retain the full unit suite, including `tests/unit/send-job.test.ts`, `tests/unit/email-send-route.test.ts` and `tests/unit/sliq-reconcile-output.test.ts`. On the final approved integrated revision run `npm run build` then `npm run check:bundle`; synthetic bundle fixtures do not prove the actual build contains no secrets. Never weaken an assertion or omit a test to pass.

## Requires a database: runtime proof NOT TESTED here

Use the existing approved local disposable Supabase workflow only. `.env.test.local` must come from that workflow; fixture identity guards require loopback and synthetic tenants. Missing/hosted credentials fail, never skip or fall back to JNR/Marpet. The RLS SQL temporarily disables triggers and may drop CHECK constraints inside a rolled-back transaction: **never run it on company data**.

```sh
npx vitest run -c vitest.db.config.ts tests/db/rls-two-tenant-proof.test.ts tests/db/s1-reverse-tenant-proof.test.ts tests/db/tenancy.test.ts tests/db/definer-functions.test.ts
npm run test:db
```

#84's existing config auto-discovers the new reverse file and runs files serially. No schema installer or skip was added. A missing-backend attempt is a failure before DB execution, not RLS proof. Run the final integrated candidate's complete baseline and post-144 sequencing separately, including required 145/146 reviewer conditions. Do not copy old catalogue assumptions into post-146 replay, reset real data or exclude tests to hide incompatibility.

## Live/browser proof still required

On two fake companies, use admin/office/workshop/viewer, secondary-role and support/read-only personas. Type matrix URLs directly and call APIs, with positive own-company controls. Substitute foreign IDs in read/write/definer calls and compare unchanged foreign records. Verify required MFA and expired-session refusals.

With a real cookie on the approved local/test site, attempt a cross-site form/fetch against a safe mutation: refusal plus unchanged records required; same-origin authorised control must succeed. No production attack tests. The current sameOrigin helper compares host/port, not scheme, and permits Origin-less non-browser requests which still require authentication. Scheme handling and trusted forwarded-host boundaries require independent deployment review. Do not claim full CSRF penetration proof from unit checks. Review #84's historical deferred-cookie note against the integrated head before applying any old patch.

## Evidence and release stop

For each row record exact full code SHA, schema/release identity, command/exit, pass/fail/skip counts, time, private evidence and checker. Fake data only in public logs. Missing schema/command, failed tests, zero tests, unexplained skips or old-head logs mean HOLD. DB, actual build/bundle and live browser rows remain OPEN until independently executed. Final sign-off belongs to Rhys and the reviewer, not this plan.
