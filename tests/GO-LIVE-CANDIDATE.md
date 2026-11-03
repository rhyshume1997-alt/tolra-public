# Final main candidate: rehearsal record

3 November 2026. This is a draft rehearsal candidate, not permission to deploy or apply SQL. Nothing was applied here. No feature behavior or existing test assertion was changed while combining the branches.

## Inputs, in merge order

Base main: `68f89ca7b801a10587ff9b51d6c820462847b65a`.

| Order | PR | Exact source head |
| --- | --- | --- |
| 1 | #233 chasing | `5439341cc336d4325965934d7de100764ad71b91` |
| 2 | #236 paid breaks, setup, email editor | `d54d90b0408fbd490f03ada687b27af03bba9800` |
| 3 | #237 accounting | `86eda4bd48b1237b42140dbd72ace7cb73442f4b` |
| 4 | #234 AI | `baafb39e1ff33d11d3c5023cd764c8fcfb8f182e` |
| 5 | #242 local fonts | `25b792572c7a5df0e141fdbc91cdd54afa46daa8` |

## Every conflict

| File | When | Resolution |
| --- | --- | --- |
| `supabase/verify/release_preflight.sql` | Merging #237 | Retained the complete 138 chase marker and the 144 accounting readiness marker as separate VALUES rows, with the necessary comma. Neither check was removed or relaxed. |
| `.github/workflows/ci.yml` | Merging #234 | Retained the baseline numbered-migration database suite and upgrade rehearsal first. The baseline excludes exactly the three proposal-dependent files; all three still run after their guarded proposal installation. Kept both N5 and N2 steps, verification rows, loopback refusal and failure propagation; N5 precedes N2. Added a release-blocker comment. |

No other files conflicted. The catalogue snapshot and package lock merged automatically. The catalogue is not regenerated from guesses: Code's accounting snapshot changes and the chase entries remain. The actual combined fresh-build and upgrade catalogue comparison still needs a disposable database.

## Migration allocation and preflight

- Numbered migrations contain one 138 and one 144; no duplicate three-digit prefixes. `npm run check:migrations` passes: 80 applied migrations remain unchanged and all 37 new numbered migrations have release, rollback, verify and preflight files.
- This exact candidate does **not** include 139 or 140–143. The gaps are not duplicate numbers. SliQ 140/141, E13 142 and costing 143 are separate lines, not silently included in this merge request.
- N5 setup is still `supabase/proposals/n5_company_setup.sql`; N2 and its per-company cap are together in `supabase/proposals/n2_tolra_provided_ai.sql`. Neither has a numbered migration or normal release/preflight marker. **Release allocation, repeatable upgrade packaging and review remain blockers before main/go-live.** No new number was invented here and no proposal was applied.
- Numbered order is ascending through 137, 138, then 144. 138 depends on existing company/email/invoice helpers. 144 depends on the existing integration/session helpers and has no dependency on missing 140–143. Its two new functions are created before existing objects change; matching release and rollback ordering is retained. The frozen 084 enqueue body remains intact.
- Run the existing numbered baseline and `scripts/upgrade-rehearsal.sh 013` on Code's disposable environment before installing either proposal. Both apply-twice and catalogue comparisons remain required. No such command was executed here.
- Only after that baseline, the existing CI steps prepare N5, verify it and run company isolation; then prepare N2, verify it and run the AI/cap race proofs. Both require a loopback database URL and fail if verification is empty or any row is not true.
- N5 uses existing organization/session/support guards and does not replace functions shared with chasing/accounting. N2 checks the exact 133/134 reserve bodies before renaming them. Its owner-only cap uses the existing usage/request ledger and does not reset usage when changing modes.
- N2 is a one-time proposal: its renames mean it cannot simply be run twice. After N2, the ordinary numbered catalogue/preflight hashes for renamed AI functions are no longer the baseline. Use its separate verification; do not change baseline hashes to hide that difference. Packaging its real upgrade/re-run checks is still required.
- The chase atomic-settings proposal remains in `supabase/proposals/`. #233's browser fixture installs only the exact reviewed function on the verified disposable backend and removes only its own unchanged function. It is not production release packaging. That proposal also needs a reviewed release decision before go-live.

## Scope and known follow-ups

The safest reading was to combine exactly the five requested PR heads. Separate follow-up PRs #239 (setup access UI guard), #240 (accounting isolation proof), #241 (inbound payment evidence proof) and #245 (browser reviewer checks) are not silently merged. Review their applicability before calling this candidate final. In particular, #239 is an actual UI access fix as well as tests; the requested #236 input alone does not include it. No additional feature scope was added.

#244 remains open but superseded by Claude Code's #243 demo seed. No U work or seed execution is part of this candidate.

## Validation

Full unit suite: **5,428 passed across 407 files**. Production build passed with three existing lint warnings (job-photos and rework-dialog hook dependencies; offline outbox unused variable). Typecheck, the repository npm lint command and migration checks passed. Expanded explicit ESLint also checked tests: it reports two pre-existing no-require-imports errors in the unchanged CommonJS preload tests/support/no-network.cjs, plus the ignored Next-generated next-env.d.ts triple-slash error when scanning the whole directory. These were not hidden or changed. Results are also recorded in the draft PR. The first sandboxed unit run hit child-process `EPERM` failures in existing command-line tests; the unchanged suite was rerun with normal subprocess permissions. No assertion was relaxed. New `go-live-candidate-order.test.ts` covers unique migration numbers, retention of both preflight markers, ordering and retention of all three guarded proposal proofs, and merged catalogue object uniqueness.

No database backend or credentials were available. Database suites, upgrade rehearsal, proposal execution, real providers and browser runtime are not locally proven. Passing unit/build checks do not remove those release blockers.

## AA / AB follow-up

#239 and #240 are now folded into this branch, without conflicts. AA validation: 5,437 unit tests and typecheck passed; production build passed. The setup UI now has the company/admin/non-support access fix and its tests, plus the accounting company-read proof. #241/#245 remain separate.

AB packages N5 as post-144 release step 145, then N2/cap as 146. See `tests/POST-144-RELEASE.md` for the explicit release-phase assumption, guarded transactional files, rollback/verify copies, preflight and all-proposal coverage check. This supersedes the earlier statement that those two proposals have no release allocation. They stay outside frozen baseline replay; Code must rehearse their one-time application, refusal on repeat, and rollback separately. No SQL was applied. The chase atomic release decision remains open.
