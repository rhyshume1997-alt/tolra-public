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

## Reproduction

For the DB suites, prefix commands with:

```sh
INTEGRATION_VERIFY_BASE=e7c4b6380964386e66e5d6a67ed37ad0aaed8da5
```

Then run each `npx vitest run --config tests/reviews/<area>/vitest.db.config.ts` for `xero-invite-adversarial`, `xero-picker-adversarial`, `night-cost-profit`, `night-151-package`, `verify-old-base` and `integration`. Exact commands, loopback fixture details and AI profile variables are in `evidence/summary.json`. The fixtures create and drop nonce databases on the task's loopback PostgreSQL port54849; never substitute a hosted project or production URL.

The verifier audit in #432 covers every one of109 SQL verifiers across013/083/137/144/150/151, with an explicit minimum schema/profile per file and before/after SQLSTATEs. Its two legacy reconciliation errors require the documented separate legacy source/imported-target profiles, not fabricated tables on a fresh Tolra schema.

## Browser execution

Local execution remains blocked: the official isolated Supabase PostgreSQL image could not extract on this7.9GiB filesystem (ENOSPC); a minimum retry was stopped at98% disk. Docker access was recovered without changing its vfs driver or touching another worker's containers. The CLI used for that initial local attempt was2.108.0; Code's approved integration stack pins2.40.7.

A targeted existing GitHub workflow was dispatched only on our #429 branch, not Code's CI branch. Run42150703006 failed before browser execution because the historical143 parser proof received2.108.0 instead of its checksum-pinned2.40.7. Run42151047156 passed that7-case proof, but browser global setup hit the newer stack's missing service-role privilege for `assert_privileged_aal`. No SQL grant or MFA guard was loosened: #429 tooling now uses Code's checksum-pinned2.40.7 baseline.

The next remote run42151639198 is pending at the time this note is written. No eight-case browser pass is claimed. #429 follow-ups also restore the43-character Microsoft PKCE assertion, use the existing real-TOTP helper and check the exact connecting admin, and retain24-hour lifetime/security-header checks. Those latest spec bytes are also on #433. Exact tested SHA and observed executed/passed/skipped counts must be recorded before any browser approval. Even a #429 pass would be source-profile-specific, not proof that #433's missing shared SQL is fixed.
