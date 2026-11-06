# Pending OAuth revocation

Dependency: #437 at265e603a6c1e2253c56ab22fbf639cee05b7d914. Its two functions are inherited unchanged, not rebuilt or approved here. INV-03 remains a pending PM decision.

Tests first: `npx vitest run --config tests/reviews/pending-oauth/vitest.db.config.ts --reporter=json --outputFile=/tmp/pending-oauth-before.json`:3 passed,4 failed,0 skipped on disposable PostgreSQL17.6. The open list omits used/pending invites and revoke returns false successfully (SQLSTATE00000). Real concurrent cancellation calls do not acquire the required serialization lock. See `evidence/before.json` for exact test names and messages. No provider HTTP or real data is used. The Auth/Storage structures are minimal SQL fixture stand-ins, not hosted/browser authentication proof.

Planned fix: lock the invite row, then recheck expiry and completed/pending OAuth before cancelling; retain company/admin/recent-MFA/support guards and one audit event. Keep pending invites visible in the existing admin-only list. Do not edit #437 helpers, RLS, grants or applied numbered history. Full checks and after-results are pending at this test-first commit. No merge, deploy or production SQL.
