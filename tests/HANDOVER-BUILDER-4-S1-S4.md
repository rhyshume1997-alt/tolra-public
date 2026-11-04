# Builder 4 handover: S1–S4

4 November 2026. Explicit assignment and atomic claim `claims/S1-S4`. Read root AGENTS.md, tests/HANDOVER-CODEX-1.md from #257 and docs/TOLRA-WORK-OWNERSHIP.md from #271 before editing. Builder 3 CM/CN/CO/CP/CQ untouched. This one draft targets #84's `claude/pr48-final` and does not alter its owner's branch or permissions.

Delivered: `tests/S1-S4-SECURITY-PROOF-PLAN.md`; actual-helper S3 mail-header/S4 canonical-domain cases in `tests/unit/s3-s4-cutover-inputs.test.ts`; real reverse-direction company RLS proof in `tests/db/s1-reverse-tenant-proof.test.ts`, reusing the original SQL. Existing full role matrices and forward RLS proof remain intact; no fake DB substitute or skip added.

Results:

- Seven-file no-DB security run in the plan: **164 passed, 0 failed, 0 skipped** (49 API matrix, 43 middleware matrix, existing route/CSRF/bundle/CSV plus 15 new input cases).
- `npm run typecheck`: exit 0. Explicit changed-test ESLint: exit 0, no output. `git diff --check`: passed.
- Initial bundle fixture subprocesses were denied with `spawnSync ... EPERM` under the default sandbox. Rerun with the execution tool's supported network permission allowed the subprocesses; all 11 bundle tests passed. No assertion changed to hide the environment error.
- Actual two-file DB command: **2 failed, 0 skipped**, both fail before DB access at `TEST_SUPABASE_URL is not set`. This establishes safe refusal only. **Database RLS proof NOT TESTED.** No SQL executed.
- Additional S3 route/import regressions: **43 passed, 0 failed, 0 skipped** across send-job, email-send-route and sliq-reconcile-output. Total scoped offline checks: **207 passed**, without implying a full unit or database suite.

Safe public logs under `tests/evidence/builder-4-security/` record the actual commands' outputs. They contain fake input or missing-backend errors, not credentials. No hosted backend, production SQL, deployment, main merge or live message.

Next: operator runs the plan's exact DB commands on the approved loopback disposable backend, then integrates/reviews the proofs on the frozen final candidate and runs the actual build/bundle and live browser/cookie checks. The plan records current helper limits (host/port comparison, scheme/forwarded-host review, authenticated Origin-less non-browser requests). Unit pass is not full CSRF or release approval. Deadline 6 November; go-live remains conditional on 12 November.
