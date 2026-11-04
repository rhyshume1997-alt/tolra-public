# Builder 3 handover for Claude Code — 4 November 2026

Build/test deadline: Friday 6 November 2026. Go-live target: Thursday 12 November 2026. Continue only CJ, CG/CK, CH and CL. The historical CI audit remains stopped at 52/61; do not restart it. No new scope, main merge, production SQL, deployment or Ready label was performed.

Read alongside `tests/HANDOVER-CODEX-1.md` and `docs/TOLRA-WORK-OWNERSHIP.md` on coordination PR #271. Main lacks these files. Existing job drafts #281–#284 were continued, rather than duplicated. Changes were committed through the GitHub plugin because local Git/network access could not connect to the configured proxy and gh's configured token was invalid. No credential was read or printed.

## Done

- CJ #281: retained the three named acceptance specs, ran collection and attempted execution, committed `tests/CJ-BUILDER-3-RESULTS.md` with commands, environment and limits. Collection: PASS, 3 tests/3 files. Runtime: FAIL in global setup, no browser assertions executed.
- CG/CK #282: `tests/GO-NO-GO-EVIDENCE.md` now attaches proof/check file paths to all 28 gate results, 64 manual rows, 18 CW rows, six releases and 30 validation rows, plus 15 URS mappings. Retains 22 named N2/N3 mappings and every missing runtime condition. Private CW checklist path is pinned to #250, not claimed integrated. Checked inventory coverage with `/workspace/work/enrich-evidence.py`; documentation checks only. Authoritative Operations Pack is still missing, so full undisclosed-pack coverage cannot be certified.
- CH #283: `tests/REVIEW-PACKETS-NEXT.md` covers all 148 open PRs from two API pages. Each has a full snapshot head, actual PR-triggered CI IDs/status, reviewer checks and verdict request. This is metadata collection, not code audit or test execution. All 148 packet/head/CI fields checked. Snapshot heads may move; refresh from this companion and live GitHub before review. No PR comments were sent.
- CL #284: retained `tests/ROUNDING-RULE.md` and added `tests/fixtures/money-rounding-cases.ts`, `tests/unit/money-rounding-rule.test.ts`, `tests/db/money-rounding-parity.test.ts`. Normal-money positive halves round up: 0.135 -> 0.14; existing negative half-away convention remains documented. PostgreSQL test uses real numeric SELECTs and verified disposable identity, with no optional skip, DDL or business writes. It compares scalar, product and per-line VAT results to both fixed pence and app functions. No app calculation, costing engine/rate or any of its 60 golden answers changed. Costing keeps half-to-even as the deliberate exception. The optional offline CC half-even helper remains a visible non-costing reviewer condition.
- Preserved the existing PR stack by carrying CJ evidence into CG/CK, then CG/CK into CH, then CH into CL. These are branch-only integration commits, not GitHub PR merges or main changes. Later drafts no longer undo the upstream documentation updates. Existing owner branches remain untouched.

## Exact commands and observed results

| Command | Result |
| --- | --- |
| `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance --list` | PASS; 3 tests in 3 files |
| `REVIEWER_REQUIRE_DATABASE=1 npx playwright test tests/e2e/acceptance` | FAIL, exit 1; TEST_SUPABASE_URL unset in global setup; runtime NOT TESTED |
| `npx vitest run tests/unit/money-rounding-rule.test.ts tests/unit/money-decimal.test.ts` | PASS; 29 passed, zero failed/skipped (21 new + 8 existing) |
| `npx vitest run -c vitest.db.config.ts tests/db/money-rounding-parity.test.ts` | FAIL, exit 1; 1 failed/0 skipped at missing-backend identity guard; no rounding SELECT ran |
| `npx eslint tests/unit/money-rounding-rule.test.ts tests/db/money-rounding-parity.test.ts tests/fixtures/money-rounding-cases.ts` | PASS; no findings |
| `npx tsc --noEmit` | PASS, exit 0 |

The first money invocation also ran `tests/unit/money.test.ts` with the 21 new cases: 38 passed. It included a nonexistent `tests/unit/money-edge.test.ts` argument, which contributed no tests; the precise subsequent command above checked the intended decimal suite. Do not combine these counts into a new full-suite claim.

Local workspace: `/workspace/work/builder3`, reconstructed from main 68f89ca and public #284 comparison, with shared preinstalled node_modules; not a clean locked install or exact-head CI proof. Scripts and metadata scratch files are under `/workspace/work/`. Original `/workspace/tolra-public` was not edited. No final whole suite, build or real backend check was claimed.

Current environment blocker: the explicit managed Docker socket check failed permission denied; UID 1000, dockerd PID 253 running. Docker command: `env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock info --format '{{.ServerVersion}}'`. Exit 1. No root/daemon restart attempted. Earlier ENOSPC is historical, not this run's current diagnosis.

## In progress / blocked

- Independent review of all four drafts; no SAFE verdict or release approval inferred.
- CJ browser acceptance and CL real PostgreSQL parity: supplied and attempted, blocked by the unavailable verified disposable backend.
- Automatic CI at final heads: snapshot below; uncompleted runs must be rechecked. CI success can have skipped integration jobs, so it is not DB/browser proof. CJ run 41825174221 failed ci-gate with web successful and integration skipped; no Ready workaround was used.
- CG/CK completeness awaits the authoritative Operations Pack and real final-head results. NO GO and NOT VALIDATED remain.

## Not started here / next steps

1. Recover managed environment Docker/socket access; prepare the independently verified fake-only Supabase/backend and app with separately reviewed 138/140/141/144/145/146. Never substitute a hosted project. This handover is not SQL approval.
2. Integrate the four draft branches in order on a review candidate; pin its actual final SHA. Rerun the exact CJ and CL commands above with locked dependencies. The CL DB test is arithmetic parity, not all document persistence/permission proof; retain existing integration/manual checks.
3. Execute remaining G04/G08/G10 manual rows, N2 real owner MFA/ACL/key/cap-race proofs and N3 all-provider SQL/sandbox/browser proofs. Three CJ tests do not cover every manual condition. Integrate held reviewer proofs separately rather than counting unmerged files as passing.
4. Obtain and reconcile every Operations Pack line; retain actual backup/restore, ordered releases/rollback, exact combined wipe/preservation/archive/refusal/disconnect, import/WIP/numbering/reconciliation and post-release browser evidence. A 146 rollback retains history/key_source and requires STOP before reinstall.
5. Refresh moved reviewer packet heads and completed CI conclusions; request independent verdicts. Rhys's validation/VSR remains unsigned. Do not resume the stopped historical audit, change costing's half-to-even answers, merge to main or apply production SQL as part of this handover.

## Final draft heads and CI companions

CI status is a snapshot, not an assertion of actual runtime coverage. The reporting file cannot contain its own eventual commit SHA; #271's description carries that SHA after commit.

| Job / draft | Final head | PR CI run / observed state |
| --- | --- | --- |
| #281 | `ff29ca191879ec954e305ec0eb200501789a5bcf` | [41825174221](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41825174221) completed, failure |
| #282 | `b80b274b0f2b8b12444915152383564cc1b9bf52` | [41826333766](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826333766) completed, success |
| #283 | `e40f9edb24a79769efd03b8f900c6c31d8a6729b` | [41826384400](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826384400) completed, success |
| #284 | `d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d` | [41826433316](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41826433316) pending, no conclusion |
