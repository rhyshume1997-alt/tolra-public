# Builder 4 final handover

4 November 2026. Read AGENTS.md locally and fetched/read the requested handover/ownership from #257/#271 because neither exists on main `68f89ca`. Atomic claims saved for all eight assigned jobs. All changes committed and published in draft PRs; local worktrees remain under `work/b4-*`. Builder 3 CM/CN/CO/CP/CQ untouched.

| Job | Draft | Deliverable / remaining proof |
| --- | --- | --- |
| D3 | #290 | `docs/D3-INCIDENT-AND-SUPPORT.md`: incident triage, contacts by role, staff message, escalation and recovery. John/Rhys must fill/test actual private phone numbers and cover rota. |
| D4 | #291 | `docs/D4-JNR-WORKSHOP-QUICK-GUIDE.md` and `docs/D4-JNR-OFFICE-QUICK-GUIDE.md`: short separate sheets, one per role. Labels/permissions source-checked; print-preview/staff rehearsal NOT RUN. |
| F5 | #292 | `docs/F5-WORKSHOP-PAPER-FALLBACK.md`: numbered paper sheet, queued/already-saved/missing split, admin correction of other staff hours, separate checker. Real outage/re-entry rehearsal NOT RUN. |
| D6 | #293 | `tests/D6-CUTOVER-ROLLBACK-RUNBOOK.md`: fenced writes/sends, reverse dependency gates, outstanding reservation refusal, retained history and backup-only recovery after 146 rollback. Actual restore/rollback NOT RUN. |
| C10 | #294 | `tests/C10-TOLRA-DOMAIN-SWITCH-CHECKLIST.md`: DNS, Vercel, Supabase auth/project URLs, callbacks, TLS and staff/email checks; expected result per row. All live settings/evidence NOT RUN. |
| B5 | #295 | `tests/B5-EMAIL-CONNECTION-PROOF-AND-FALLBACK.md`: real controlled receipt proof plus existing manual-mail path only after definite not-sent; unknown delivery held. Live provider/receipt NOT RUN; private operator approval field left explicit. |
| AU | #296 → #247 | `tests/AU-SCREEN-WORDING-REVIEW.md`: confusing wording only, six issue rows / nine displayed-string changes; snapshot audit of all #232–#261 in job handover. 90 affected tests pass; typecheck/lint pass. Visual browser NOT RUN. |
| S1–S4 | #297 → #84 | `tests/S1-S4-SECURITY-PROOF-PLAN.md`, reverse-tenant real DB proof, actual helper header/origin tests. 207 scoped offline checks pass; typecheck/lint pass. DB attempt 2 failed / 0 skipped at missing TEST_SUPABASE_URL before DB access. Real DB/cookie/browser/build-bundle proof NOT TESTED. |

Each job includes `tests/HANDOVER-BUILDER-4-<code>.md` with validation/remaining work. Documentation changed no runtime behaviour and was checked by source/diff review; no artificial doc tests added. S1–S4 evidence logs are committed under `tests/evidence/builder-4-security/`. No test assertions were weakened; AU's existing AI refusal-state assertion now expects the new exact wording.

GitHub authentication briefly failed (401; git HTTPS credentials unavailable), then API access recovered. Commits/trees/refs were published using the authenticated GitHub API; no credentials printed or interactive login. An incomplete initial AU upload was corrected on its own newly created draft branch before final tree verification. No original owner branch was overwritten.

## What remains before go-live

By Friday 6 November, independent reviewer checks these exact draft heads and John/Rhys/Code perform the unrun rows with actual evidence: private contacts/cover tested, printed one-page guides tried by each role, paper recovery reconciled once, backup restore and rollback rehearsed, domain/callback and controlled mailbox checks passed, full final-candidate security DB/browser/build proofs recorded. Do not infer those results from docs or offline tests.

The new reverse security file is auto-discovered by #84's DB config. When integrating into #247, retain its full baseline/post-144 sequencer and every independent reviewer condition; do not exclude files to make an old catalogue proof green. The current sameOrigin helper's host/port and forwarded-host/scheme limits are explicitly recorded for deployment review. This job adds proofs, not a new security policy.

146 cannot be re-applied after rollback. Restore from a verified backup containing the required state is the only recovery route. Never remove retained request history/key_source or weaken one-time guards. A pre-cutover backup restores the pre-cutover system, not automatically the 146-enabled state. Keep writes fenced and reconcile later/paper work after any restore.

No merge, production SQL, DNS/provider change, deploy or real email send was performed. Go-live Thursday 12 November is conditional on the actual evidence and Rhys's approval, not granted by this handover. All eight PRs remain drafts without Ready labels.
