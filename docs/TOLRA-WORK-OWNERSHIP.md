# Tolra work ownership

Coordination record introduced by Codex on 2 November 2026 under the master build request. No tracker existed on public main a546c3a or private main 9e56680. Existing branches and PRs are preserved; their presence does not establish a transferable claim. Do not take over another builder's implementation without a recorded handoff.

Publish a claim by creating `refs/heads/claims/<existing-job-code>` atomically through GitHub, then update this table on a dedicated branch. An existing claim ref must never be overwritten. Check this file, open PRs and remote branches again before each claim. Never invent a job code.

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| A8 | Claude / ChatGPT; implementation retained with original builders | claude/a8-costing-activation; claude/costing-in-app; chatgpt/costing-in-tolra; chatgpt/costing-wiring | IN PROGRESS | #110, #121, #123 |
| A10 | Claude; existing CI work | claude/tolra-a10-ci-shard | IN PROGRESS | #11 |
| G9 | Claude; existing SliQ importer; ChatGPT builders own additional parser tests | claude/sliq-import; chatgpt2/sliq-importer-tests; chatgpt/sliq-risk-tests | IN PROGRESS | #114, #122 |
| E13 | Claude; existing timesheet scheduling work | claude/e13-timesheet-days | IN PROGRESS | — |
| — (coordination and read-only verification requested in master build prompt; no new job code) | Codex | codex/work-ownership | CLAIMED | — |

## Existing work without a verified original job-code mapping

Treat these as occupied, not AVAILABLE: #107/#117 payment-claim detection and adapter; #108/#118/#119 invoice chase engine/wording/tests; #109/#116/#120 bank reconciliation helpers/UI/tests; #111 settings, #112 approval card, #113 customer-payment-claim UI; #115 staff guide; #124 builder handover; #125 wipe guide. Claude also has `claude/chase-steps`. Do not duplicate these implementations.

## Blockers

- The public repository omits the original operating protocol/master plan by design (`CLAUDE.md`). Private `Tolra Progress.md` and the handover branch describe an older queue; a complete current mapping of A/B/C/D/E/G/L jobs to availability was not found. Unverified codes cannot safely be claimed.
- No original builder has recorded a handoff of the occupied work above. Confirm ownership before changing those branches or integrating their code.
- Go-live approvals, production changes, merges and deployments remain outside this build's authority.

Rhys authorised Codex follow-up fixes on separate branches in this session. Original branches remain untouched.

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| — (bank reconciliation #109; original code unavailable) | Codex | codex/bank-csv-quotes; atomic claim claims/pr109-csv-quotes | DONE IN PR | #131 (local checks pass; CI pending) |
# Tolra work ownership

Who owns each piece of work. Read this before claiming anything. Add a row for your own work; never take a row someone else owns.

House rules for every builder (Claude Code, ChatGPT builders, Codex):
- Merges to main, migration numbers, and applying migrations to production are done by Claude Code only, after a reviewer SAFE verdict and a green ci-gate.
- Nobody deploys, and nobody commits directly to main.
- A builder adds the `Ready` label only to its own PRs, and only when its own checks pass.
- Migration numbers in use or reserved: 136, 137 (live); 138 chasing; 140, 141 SliQ; 142 timesheet emails; 143 costing. Ask Claude Code before taking a new number.

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| G1 admin recent code + password tickets (136, 137) | Claude Code | claude/g1-logos-mfa-redirects | Done: merged, live in production 2 Nov | #106 |
| CHASE-P1 chase steps, drafts, approve and send, pause (138) | Claude Code | claude/chase-steps | Built; waiting on review verdict, then PR | - |
| CHASE-P2 "customer says paid" database side (in 138) | Claude Code | claude/chase-steps | Built inside 138 | - |
| CHASE-P2/P3 screens and wiring (inbox, approvals, bank check page) | ChatGPT builders, joined by Claude Code | chatgpt/*, chatgpt2/* (PRs into claude/chase-steps where they need 138) | In progress | #111-#113, #116, #117 |
| E13 timesheet emails on chosen days (142) | Claude Code | claude/e13-timesheet-days | Built; waiting on review verdict, then PR | - |
| SLIQ importer (140, 141) | Claude Code | claude/sliq-import | Built; waiting on review verdict and John's export headers | - |
| COSTING in Tolra: tables, rates code, golden answers (143) | Claude Code | claude/costing-in-app | Built | - |
| COSTING maths and screens | ChatGPT builder 1, joined by Claude Code | chatgpt/costing-in-tolra, chatgpt/costing-wiring | In review | #110, #123 |
| WIPE kit for JNR test data | Claude Code (private docs) | not in this repo | Built; waiting on review verdict | - |

## Codex master queue dispositions

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| paid-claim-wiring | Existing CHASE-P2/P3 owners retained | claude/chase-steps | BLOCKED | #117 |
| bank-check-wiring | Existing CHASE-P2/P3 owners retained | chatgpt/bank-check-ui | BLOCKED | #116 |
| chase-ui-wiring | Existing CHASE-P2/P3 owners retained | chatgpt2/* | BLOCKED | #111–#113 |
| e13-tests | Existing E13 owner retained | claude/e13-timesheet-days | BLOCKED | — |
| sliq-import-tests | Existing SLIQ owner retained | claude/sliq-import | BLOCKED | — |
| costing-check | Existing COSTING owners retained | chatgpt/costing-in-tolra; chatgpt/costing-wiring | BLOCKED | #110, #123 |
| full-suite | Codex (own branch only) | codex/bank-csv-quotes | DONE IN PR | #131; 4,787 tests, tsc, full eslint pass on 0a6b970; integration unverified |

## 3 November queue

Main 0f22f94 has neither tracker file. Read PR #159 merge order before this queue. Existing IN PROGRESS rows remain held; no AVAILABLE job row found.

| Job | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| manual-checks | Codex | codex/manual-checks | DONE IN PR | #183; 4,986 tests, tsc, eslint pass |
| costing-check (read-only report) | Codex | claude/costing-in-app unchanged | BLOCKED | #130; engine absent, 60 prices skipped |

## Explicit integration assignment, 3 November

| Job | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| costing-join / costing-save-all-or-nothing | Codex (Rhys explicitly assigned this integration) | codex/costing-join | DONE IN PR | #184; SQL execution blocked |
| chase-join-check | Codex (Rhys explicitly assigned this integration) | codex/chase-join | BLOCKED | #186; progression test conflict |
| money-edge-tests | Codex | codex/money-edge-tests | DONE IN PR | #185 |

## AQ to AW, 4 November

| Job | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| AQ | Codex | codex/aq-morning-checklist | DONE IN PR | #262 |
| AR | Codex | codex/ar-manual-final | DONE IN PR | #263 |
| AS | Codex | codex/chase-join | DONE IN PR | #186 |
| AT | Codex | codex/costing-join; codex/money-edge-tests | DONE IN PR | #184; #185 |
| AU | Codex | codex/au-wording | BLOCKED | Execution budget reached; exhaustive review unfinished |
| AV | Codex | codex/av-rollback-tests | BLOCKED | #265; SQL execution prohibited |
| AW | Codex | codex/aw-data-load | DONE IN PR | #264 |

## AX to BC, 4 November

| Job | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| AX | Codex | codex/ax-review-packets | DONE IN PR | #266 |
| AY | Codex | codex/ay-db-runbook | DONE IN PR | #267 |
| AZ | Codex | codex/az-acceptance | DONE IN PR | #268 |
| BA | Codex | codex/ba-evidence | BLOCKED | #269 |
| BB | Codex | codex/bb-fake-data | DONE IN PR | #270 |
| BC | Codex | codex/work-ownership | DONE IN PR | #130; zero AVAILABLE rows on both trackers |

## Explicit CA to CI handoff, 4 November

Rhys explicitly assigned the new CA to CI integration/evidence queue to this Codex account. Original Claude/ChatGPT implementation rows stay held and unchanged. CA packages existing 140/141 releases on an independent branch; it does not change claude/sliq-import. Implementation branches use codex/<job>. No Ready label will be added, overriding the older general label rule for this queue. Code PRs contain no docs/ files; this dedicated coordination PR owns ledger updates.

| Job code | Owner | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| CA | Codex, explicit new queue handoff; claims/CA | codex/ca-sliq-releases | DONE IN PR, RUNTIME BLOCKED | #272; ef3e76e3e6c0fdbc012a4f59bd55dddd2f26920b; 5457 unit pass, 0 failed/skipped; 19 focused pass; tsc/lint/checksums pass; real DB BLOCKED by managed image-store ENOSPC |
| CB | Codex, explicit handoff; claims/CB | codex/cb-release-gate | DONE IN PR, CI CORRECTION REQUIRED | #273; ff13614fcd8bd37d989faec74d387371ef7ac378; 66 unit pass, 0 failed/skipped; tsc and changed-file lint pass; actual release evidence NOT TESTED; include #280 command-exit/collection refusal correction |
| CC | Codex, explicit handoff; claims/CC | codex/cc-jnr-reconcile | DONE IN PR, EVIDENCE OPEN | #274; d88f06333556e5c2a80e183a5067c5f7117562fa; 35 focused units pass, zero fail/skip; tsc and changed ESLint pass; supplied snapshots only, no live proof |
| CD | Codex, explicit handoff; claims/CD | codex/cd-sliq-no-write | DONE IN PR, REAL REHEARSAL OPEN | #275; d73bb240a23b38a7080c0933e4f5b62ddd529f5f; 9 focused and 5567 full units pass, zero fail/skip; tsc/lint pass; fake reconciliation INCOMPLETE (WIP accountant), 2 held |
| CE | Codex, explicit handoff; claims/CE | codex/ce-validation-final | DONE IN PR, VALIDATION OPEN | #276; e71a80072148077a4c0f05184fe40d79688c01ee; 463 mapped units pass, 0 fail/skip; pack check and tsc pass; actual explicit lint 633 files, 0 errors, 3 warnings; old no-argument lint void; baseline full units 5567; DB/browser NOT TESTED, VSR unsigned |
| CF | Codex, explicit handoff; claims/CF | codex/cf-db-day-runbook | DONE IN PR, EXECUTION OPEN | #277; 87c4bbf52b895c1e618d32205e5023adb4d60cbc; 18 referenced paths/order/146 STOP checked; diff check pass; docs only, actual DB rehearsal NOT TESTED |
| CG | Codex, explicit handoff; claims/CG | codex/cg-go-no-go-evidence | DONE IN PR, COMPLETENESS BLOCKED | #278; 8d667ffc7d779d4487fcf19eb052b123ec98baa8; 157 evidence rows; all mandatory IDs, 18 CW and every manual row accounted; authoritative Operations Pack missing, actual runtime NOT TESTED |
| CH | Codex, explicit handoff; claims/CH | codex/ch-review-packets | DONE IN PR, REVIEW OPEN | #279; 4bb59c0ecfda0a545ec7221ef569dcc1184418db; 7 artifact packets with full SHAs, 9 verdict questions checked; documentation only; self-report exact head in PR companion; full runs queued CI |
| CI | Codex, explicit handoff; claims/CI | codex/ci-branch-checks | IN PROGRESS | #280; checkpoint 0cc2463d0a6375ada1d65e249939efa02e3b3cf2; 73 gate tests pass after 7 failing-first regressions; exact-head full audit still running; original no-argument lint not accepted, explicit lint underway |
