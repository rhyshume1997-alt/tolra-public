# Builder 3 integration handover

**NOT READY FOR RELEASE.** Unit passes do not replace the failing database contracts below. Shared SQL definitions have deliberately not been changed.

Branch: `codex/integrated-final-fixes`, draft PR **#433**. Approved base: `e7c4b6380964386e66e5d6a67ed37ad0aaed8da5`. The tested application/DB contract commit is `5a4afa32ccbbc852d068ba5c248ae7fd3a91fe71`; subsequent commits correct/strengthen only the browser spec. The PR's final head and remote browser receipts are recorded separately when the run finishes.

All six review PRs remain separate: **#423, #425, #429, #430, #431, #432**. `evidence/pr-map.json` records source bases/heads, one integration commit per review PR, later browser follow-ups, and every held path. Additional AI tests come from historical #416; no AI implementation or shared SQL was copied from it.

## What was combined and resolved

- Code's 151 registration is kept exactly once immediately after 150, outside numbered migrations. Historical proposal-only test contracts now assert Code's approved exact ordering; they do not unregister or duplicate 151.
- Phase fixtures explicitly prepare through 150 before applying 151 once.
- The nullable catalogue lookups from #432 are applied to Code's complete preflight, retaining its 151 marker. Dedicated post-migration verifiers were not changed just to pass unsupported old schemas.
- The protected paths `supabase/migrations/`, `supabase/proposals/`, `supabase/release/` and `supabase/release-plan.json` match the base byte-for-byte. See `evidence/protected-tree.json` and reproduce with `git diff --exit-code e7c4b6380964386e66e5d6a67ed37ad0aaed8da5 -- supabase/migrations supabase/proposals supabase/release supabase/release-plan.json`.
- This guardrail holds the SQL portions of #423 and #425. Their app/tests/strict verifier contracts are present, so missing prerequisites remain visible as failures.
- A false 148 half-up check initially stopped fixture setup, leaving later tests pending. Setup now verifies Code's immutable baseline SQL with its immutable baseline verifier, only under the explicit pinned `INTEGRATION_VERIFY_BASE` environment variable. Active semantic checks remain separate named failing tests. Protected-file drift makes setup refuse. No active assertion is suppressed or turned into a pass.

## Actual results

These groups overlap; do not sum them as unique coverage. Final per-test failures, messages, paths and reproduction commands are in `evidence/failures.json`.

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Full unit suite | 6875 | 0 | 0 |
| Invitation actual-route/SQL | 32 | 6 | 0 |
| Picker actual-route/SQL | 8 | 12 | 0 |
| Financial DB (143/148) | 32 | 5 | 0 |
| 151 DB, baseline rollback plus strict active contract | 11 | 4 | 0 |
| Old-base/final-required-table DB | 7 | 0 | 0 |
| Separate exchange/callback lifecycle SQL | 5 | 3 | 0 |
| AI own-key DB | 24 | 0 | 0 |
| AI Tolra-provided DB | 30 | 0 | 0 |
| AI/readback focused units | 41 | 0 | 0 |
| Financial focused units, including 60 unchanged engine goldens | 566 | 0 | 0 |
| 151 hashes and registration/order units | 5 | 0 | 0 |
| Migration checker and release-plan units | 35 | 0 | 0 |

Typecheck (`NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit`), `npm run lint` and `git diff --check` passed. All DB rows use disposable PostgreSQL 17.6 and synthetic companies with actual SQL/RLS roles and minimal Auth/Storage stand-ins; they are not hosted Auth/browser proof. AI fixtures apply the exact baseline 146/150 overlays to their isolated fixture, not a separate full release rehearsal. No live provider or real mailbox was used.

The Code-baseline 151 apply/verify/open-invite rollback refusal/cancel/rollback/reapply workflow passes and preserves company audit rows. The stronger active 151 verifier still fails on missing helpers/column. The rollback deliberately drops the separate refusal-log table; this is not audit-log preservation for that table.

## Unresolved findings and smallest safe changes

1. **Guarded invite write is missing.** `integration_invite_store_connection(...)` does not exist on the base. Successful fresh consent cannot complete, and rejecting an expired request merely because this RPC is absent is not proof of expiry enforcement. Code must integrate the reviewed #423 SQL wrapper and persistent `invite_completed_at`, lock the state/invite, recheck expiry with `clock_timestamp()` after locks plus revocation/company/creator binding, and call the existing store in the same transaction. Preserve service-only grants and update rollback/approved 151 marker digests. Do not fall back to the unguarded store to make a positive case pass.
2. **Pending OAuth cannot be revoked.** `integration_invite_revoke` still requires `used_at IS NULL` (`supabase/proposals/p151_xero_invite_hardening.sql:372`). After OTP exchange it returns false/HTTP404. Code must take the #423 pending-state revoke/open-list conditions, preserving admin/company/support/MFA checks and refusing completed consent.
3. **Atomic picker claim is missing.** `integration_xero_picker_claim(...)` does not exist. The new route fails closed with503, and its positive/concurrency/audit cases fail. Code must integrate the #423 service-only atomic nonce claim. Do not replace it with the old non-atomic rate counter or release queued documents automatically.
4. **148 still rounds half to even.** `job_cost_round` at `supabase/proposals/p148_job_profitability_actuals.sql:102` returns0p for0.5p and500p for500.5p. Code must integrate #425's single integer-ratio condition `2*r >= denominator` in canonical/release 148, retaining integer pence and 143's sole company rate source. Do not change the frozen quotation engine/60 goldens or rewrite historical snapshots. The active verify row and snapshot/rollback assertions remain red until the SQL matches.
5. **Positive control before security credit.** The direct Code SQL proves an unexpired OTP maps to its creator/company; expiry before code exchange and before callback is refused; pre-exchange revocation works; and a successful baseline store leaves transfers OFF and held documents unchanged. Post-exchange revocation and the guarded final-store positive/negative controls fail. Do not count other negative passes as full lifecycle or picker-security proof until the positive guarded paths work. Authenticated company isolation is tested in SQL; real Auth/provider identity and actual Xero legal ownership remain unchecked. A name match alone is not legal ownership proof.

No shared migration file or canonical release definition was edited here. Code owns the held SQL changes. The existing fixes are reviewable in #423/#425; the smallest safe route is to integrate those reviewed hunks with Code's registration/digests retained, then rerun the same assertions.

6. **Real invite headers are overridden.** Integrated Actions run42154479194 at `6837e2dca46c55fa44ee12222e3e1d57860001fe` reports6 passed/1 failed/1 skipped. Case7 at `tests/e2e/integrations-connect.spec.ts:429` observes `Referrer-Policy: strict-origin-when-cross-origin`, while the route helper correctly returns `no-referrer`. `next.config.mjs:58` sets the global policy; its invite-only rule at66 overrides only CSP. Source inspection also shows that rule replacing the route's restrictive `default-src 'none'` policy with the global script-enabled policy. The browser stops at the referrer assertion, so the CSP discrepancy is source-backed, not a second observed browser assertion. Code must preserve the restrictive headers in the existing22-character invite-only rule and strengthen the existing config test expectations. Other paths must keep their current global policy. The existing browser assertions remain unchanged. This global config file is outside our declared integration files: PM/Opus scope ownership was requested; no unauthorized edit was made. Exact reproduction and recommended fix are in `evidence/browser-header-finding.json`.

## Reproduction

For the DB suites, export this setting before running the commands:

```sh
export INTEGRATION_VERIFY_BASE=e7c4b6380964386e66e5d6a67ed37ad0aaed8da5
```

Then run each `npx vitest run --config tests/reviews/<area>/vitest.db.config.ts` for `xero-invite-adversarial`, `xero-picker-adversarial`, `night-cost-profit`, `night-151-package`, `verify-old-base` and `integration`. Exact commands, loopback fixture details and AI profile variables are in `evidence/summary.json`. The fixtures create and drop nonce databases on the task's loopback PostgreSQL port54849; never substitute a hosted project or production URL.

The verifier audit in #432 covers every one of109 SQL verifiers across013/083/137/144/150/151, with an explicit minimum schema/profile per file and before/after SQLSTATEs. Its two legacy reconciliation errors require the documented separate legacy source/imported-target profiles, not fabricated tables on a fresh Tolra schema. The integrated rerun is in `evidence/verifier-matrix.json` (source `cf52856fc03d606a5bff99839b8f95821214e124`): preflight executes178 rows on every stage; no query error occurs at a verifier’s supported minimum/profile. Final-stage legacy-profile errors remain explicit; false semantic rows remain failures, not query errors.

## Browser execution

Local execution remains blocked: the official isolated Supabase PostgreSQL image could not extract on this7.9GiB filesystem (ENOSPC); a minimum retry was stopped at98% disk. Docker access was recovered without changing its vfs driver or touching another worker's containers. The CLI used for that initial local attempt was2.108.0; Code's approved integration stack pins2.40.7.

A targeted existing GitHub workflow was dispatched only on our #429 branch, not Code's CI branch. Run42150703006 failed before browser execution because the historical143 parser proof received2.108.0 instead of its checksum-pinned2.40.7. Run42151047156 passed that7-case proof, but browser global setup hit the newer stack's missing service-role privilege for `assert_privileged_aal`. No SQL grant or MFA guard was loosened: #429 tooling now uses Code's checksum-pinned2.40.7 baseline.

Run42151639198 reached the real browser but failed a page-wide disconnected-label count. The first integrated dedicated run42152627841 (`cf52856fc03d606a5bff99839b8f95821214e124`) reproduced that failure:0 passed,1 failed,7 skipped. The scoped Xero-status fix is `d35f43594488ddec2014d7b74abcf5e0915e890d`; its integrated run42153063080 executed7 cases:6 passed,1 failed,1 skipped. Case7 incorrectly expected the full recipient in a deliberately masked UI notice. Commit `6837e2dca46c55fa44ee12222e3e1d57860001fe` corrects that expectation, adds explicit masking/API/body-id checks, and retains the exact bound address checks in database and mock mail. Unique masked recipients identify the precise cancellation row. Its run42154479194 is pending when this handover is committed. No eight-case pass is claimed in this file.

The narrowly scoped `.github/workflows/builder3-invite-browser.yml` runs only this own PR/branch. It uses Code's checksum-pinned2.40.7 CLI, real disposable Supabase and intercepted provider navigation. It refuses protected-tree drift, unavailable backend, missing report, any failure/skip/flaky case, or anything other than8 passes. It does not change the candidate release gate. Tests invoke real picker routes for missing-offer and role/anonymous refusal, but do not prove positive provider consent/organisation choice. No valid provider callback or live provider call occurs. The43-character PKCE assertion and24-hour/security-header checks are retained.

The final head will itself trigger the same eight-case workflow. Its exact SHA, run URL and observed result must be read from the Actions receipt and the follow-up summary on draft #433; a green #429 or an earlier integrated SHA is not final-head proof. The final output remains NOT READY while the30 overlapping DB assertion failures remain. `evidence/browser-local.json` records local and remote history.

A fresh sandboxed full-unit attempt returned6867 passed/8 failed/0 skipped: process-based tests could not spawn children (`spawnSync EPERM`). The same command with authorized child-process access passed6875/0/0, followed by typecheck/lint/diff exit0. No test or security policy was changed to obtain that result. Final-head checks will be posted on #433 with their exact SHA.

## Final-head receipts and handoff boundary

At `f447d1f5722dd18fd0edee0ff73a1acaf15f4fec`, all six DB suite counts above reproduced with0 skips; both AI SQL profiles again passed24/0 and30/0. The complete unit suite passed6875/0/0, followed by typecheck, lint, diff check and protected-tree comparison, all exit0. A preceding attempt could not write its JSON because old synthetic `/tmp/sliq-*` fixture directories exhausted the executor's inodes; only stale synthetic temp directories older than10minutes were removed, then the unchanged checks passed. No data fixture assertion or application code was changed. Fresh ephemeral DB receipts were preserved outside the checkout and generated tracked receipt files restored to their committed bytes; the protected SQL comparison still passes.

Run https://github.com/rhyshume1997-alt/tolra-public/actions/runs/42154718627 tests that exact integrated SHA and is pending when this note is updated. The known header defect is unchanged, so no8/8 pass is claimed. The final metadata-only handover commit will also trigger a head-specific run; its exact SHA/run/result belongs in the PR summary after completion. No earlier branch green substitutes for it.

Done: minimum-schema classification and old-base/final-table regressions; six independently traceable PR integrations; actual integrated SQL/security/financial/AI checks; real remote Supabase/browser execution and strict eight-pass receipt; exact failing assertions and minimum safe fixes.

In progress: final own-head Actions browser receipt; PM/Opus ownership resolution for the invite-only config header fix.

Still unchecked/blocked:8/8 browser pass; final invitation write and picker positive/concurrent completion until Code supplies the guarded SQL; post-exchange revocation; financial DB half-up contract; full real-provider/accountant consent and legal organisation ownership. No real provider calls were authorized or attempted. Hand Code #433, its current head SHA, `evidence/failures.json`, the new header finding and the observed CI links. Shared SQL fixes remain Code-owned in reviewed #423/#425; do not weaken the tests or fall back to unguarded calls.

## PM-approved invite-only header follow-up

Rhys/PM approved builder3's scope transfer for the invite-only rule in `next.config.mjs`. That rule now preserves `no-referrer` and the static page's `default-src 'none'` CSP, with only inline style and the same self/Xero form targets. Global rules and protected SQL are unchanged. `tests/unit/security-headers.test.ts` now asserts the stronger invite-specific contract and the existing global policy. Before the config change, the strengthened suite had18 passed/2 failed; afterwards20 passed/0 failed/0 skipped. The unchanged eight-case browser spec and full required checks will run on this new head; no browser pass is inferred from these unit results. The prior header finding is fixed in code, with real-browser verification pending. Other Code-owned SQL blockers above remain unresolved.

Header-fix browser run42158105055 at556e836cf77e3704ab0da8c81db79f137f0c3609 passed the real no-referrer/CSP assertions and the bound-code exchange/replay checks, then exposed another stale spec expectation: a well-shaped unknown callback state returns the route's409 refusal, whereas a malformed callback returns400. The spec now distinguishes those exact contracts and adds actual SQL refusal-log reason/correlation checks, fixed error-page checks, no echoed inputs/redirect, and preserved real invitation state. No production callback behaviour or rejection was relaxed. At that head the full suite passed6875/0/0 and typecheck/lint/diff passed. All-eight proof awaits the corrected spec's integrated-head rerun.
