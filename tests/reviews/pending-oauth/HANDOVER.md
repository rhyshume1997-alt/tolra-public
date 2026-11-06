# Pending OAuth revocation

Dependency: #437 at265e603a6c1e2253c56ab22fbf639cee05b7d914. Its two functions are inherited unchanged, not rebuilt or approved here. INV-03 remains a pending PM decision.

Tests first: `npx vitest run --config tests/reviews/pending-oauth/vitest.db.config.ts --reporter=json --outputFile=/tmp/pending-oauth-before.json`:3 passed,4 failed,0 skipped on disposable PostgreSQL17.6. The open list omits used/pending invites and revoke returns false successfully (SQLSTATE00000). Real concurrent cancellation calls do not acquire the required serialization lock. See `evidence/before.json` for exact test names and messages. No provider HTTP or real data is used. The Auth/Storage structures are minimal SQL fixture stand-ins, not hosted/browser authentication proof.

Planned fix: lock the invite row, then recheck expiry and completed/pending OAuth before cancelling; retain company/admin/recent-MFA/support guards and one audit event. Keep pending invites visible in the existing admin-only list. Do not edit #437 helpers, RLS, grants or applied numbered history. Full checks and after-results are pending at this test-first commit. No merge, deploy or production SQL.

## Implemented and tested

The invite row is locked before checking pending/completed state, authority and wall time; two cancellations yield exactly one success/audit. Completion committed while cancellation waits wins without a late revocation. Pending invites remain in the existing admin-only list. All existing grants and RLS declarations are unchanged; only the two changed function fingerprints are updated, with all11 preflight pins retained. An unexpected body still produces a not-applied marker. Both helper bodies from #437 remain byte-for-byte unchanged.

After:11 passed/0 failed/0 skipped (`evidence/after.json`), including AAL1 refusal, elevated support refusal, other-company refusal, demotion, expiry and completed-consent controls. The supplemental MFA case initially failed fixture setup because065 requires a verified factor before enabling the company MFA setting; a synthetic verified-factor row was added, preserving the real guard. This does not prove hosted enrollment or fresh-TOTP age checking. Full units6861/0/0, typecheck, lint and diff passed; exact summary is evidence/checks.json.

Dependency is frozen at the PM's requested #437 SHA265e603 on own branch codex/xero-437-base-265e603. #437 subsequently advanced to6d147b990a4e44ec252c9bace2535fc49e7f376d and removed INV-03; that policy change is not approved or reversed here. Independent review of both heads and the edited149 assertion is the later job. No force push or other worker branch edit.

Draft #438 contains the narrow fix; draft #434 contains the original30-failure classification. Next: separate148 half-penny correction, independent #437 review, then combined143/148/149/150/151 regression and Friday evidence. No candidate/main edits, merge, deployment, production SQL or provider activation. A fresh combined browser/real-Auth run remains unchecked. Accepted #433 browser evidence is Actions42162456124 at147ac28 (8/0/0/0), with active public-egress restrictions, not proof of this new SQL branch.
