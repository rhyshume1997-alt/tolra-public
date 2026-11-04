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
| CG | Codex, explicit handoff; claims/CG + claims/CK | codex/cg-ck-evidence | DONE IN PR, RUNTIME BLOCKED | #282;5aca2efd2755e9bf9dd53e72ad5807c31648a434;22named proof mappings source-checked; Operations Pack missing; actual DB/provider/browser NOT TESTED |
| CH | Codex, explicit handoff; claims/CH | codex/ch-review-packets-next | DONE IN PR, REVIEW OPEN | #283;22adae9ae28aaeee7988e50cecded708335c9caa;11full-head packets checked;docs only;no suites repeated |
| CI | Codex, explicit handoff; claims/CI | codex/ci-branch-checks | STOPPED BY RHYS, PARTIAL | #280; f4eacee2236e65e52fdccbdf5cf8f8045fd95d80; 52/61 unit/typecheck heads completed, all61 explicit lint0errors3warnings each;100focused gate pass; final full suite NOT TESTED; do not resume without reprioritisation |

## Budget priority handoff, 4 November

| Job | Owner | Branch | Status | PR / next action |
| --- | --- | --- | --- | --- |
| CJ | Codex, explicit handoff; claims/CJ | codex/cj-acceptance-specs | DONE IN PR, RUNTIME NOT TESTED | #281;8c5161c20745fb8be2e4239ecf9076f7507d437f;3named specs collect;tsc/changed ESLint pass;missingDB execution refuses;Code run on fake backend |
| CK | Codex, explicit handoff; claims/CK | codex/cg-ck-evidence | INCLUDED WITH CG | #282;22N2/N3 named mappings;all final runtime conditions NOT TESTED |
| CL | Codex, explicit handoff; claims/CL | codex/cl-rounding-rule | DONE IN PR, FOLLOW-UP OPEN | #284;5b89fe469e10cfea74b60ce535e3bf03cf390f84;25focusedmoney tests+3examples pass;costing untouched;Code align/retire optional CC halfEven before financial use |

## Builder 3 continuation, 4 November 2026

Rhys explicitly assigned CJ, CG/CK, CH and CL to builder 3. Existing drafts were continued; no duplicate job PRs or held owner implementation changes. Historical CI audit remains stopped at 52/61. Handover: `tests/HANDOVER-BUILDER-3.md` on #271. Build/test deadline Friday 6 November; go-live target Thursday 12 November 2026.

| Job | Branch / draft | Current head | Done and remaining |
| --- | --- | --- | --- |
| CJ | codex/cj-acceptance-specs / #281 | ff29ca191879ec954e305ec0eb200501789a5bcf | Three specs collect; runtime attempt FAIL in setup, missing disposable backend. Exact commands in tests/CJ-BUILDER-3-RESULTS.md. CI 41825174221 failure; actual browser proof open. |
| CG/CK | codex/cg-ck-evidence / #282 | b80b274b0f2b8b12444915152383564cc1b9bf52 | Proof paths added to every available gate/manual/CW/release/validation row; 15 URS and existing 22 N2/N3 mappings. Inventory check pass, CI 41826333766 success; Operations Pack/runtime evidence still missing. |
| CH | codex/ch-review-packets-next / #283 | e40f9edb24a79769efd03b8f900c6c31d8a6729b | 148 open-PR packets with full snapshot heads, CI IDs/statuses and reviewer checks. Metadata checks pass, CI 41826384400 success; no broad audit/suites, independent reviews remain. |
| CL | codex/cl-rounding-rule / #284 | d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d | 21 new app cases and real PostgreSQL parity test added; 29 focused app tests/lint/types pass. DB test FAIL at missing-backend guard, parity NOT TESTED. Costing engine/rates/60 half-even golden answers untouched. CI 41826433316 pending at handover snapshot. |

Upstream evidence carried through the existing draft stack; no main merge, production SQL, Ready label or deployment. CI success is not proof of skipped database/browser jobs. Current environment blocker is Docker socket permission denied for UID 1000; the old ENOSPC report is historical. NO GO / NOT VALIDATED remains; Claude Code should use the handover's exact commands and remaining-work list.

## Builder 3 explicit CM–CQ queue, 4 November 2026

Rhys assigned this follow-up queue. Atomic claims/CM, claims/CN, claims/CO, claims/CP and claims/CQ exist. Original implementation ownership is retained; CM is a follow-up PR into the held branch, and CN–CQ are independent drafts based on #284. No main merge, production SQL, Ready label, deployment or broad audit. Full results and remaining work: `tests/HANDOVER-BUILDER-3.md` on #271.

| Job / draft | Branch → target | Exact head | CI snapshot |
| --- | --- | --- | --- |
| CM / [#285](https://github.com/rhyshume1997-alt/tolra-public/pull/285) | `codex/cm-costing-typecheck` → `codex/costing-sql-test-plan` | `a4c89af3723703ba5e284bb6500553d42975f925` | [41827875158](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41827875158) completed, failure |
| CN / [#286](https://github.com/rhyshume1997-alt/tolra-public/pull/286) | `codex/cn-john-pq-run-sheet` → `codex/cl-rounding-rule` | `50b1877982808084aed13b2c0eced461d48dd7f6` | [41828333822](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41828333822) completed, success |
| CO / [#287](https://github.com/rhyshume1997-alt/tolra-public/pull/287) | `codex/co-rhys-sign-off-guide` → `codex/cl-rounding-rule` | `4b134cbb3f04f63938ef4537e122a43b8af6235f` | [41828752369](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41828752369) completed, success |
| CP / [#288](https://github.com/rhyshume1997-alt/tolra-public/pull/288) | `codex/cp-cutover-day-checklist` → `codex/cl-rounding-rule` | `ce2e6cc1268e5965a490f839083ab0fcd17eeae7` | [41829266489](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41829266489) completed, success |
| CQ / [#289](https://github.com/rhyshume1997-alt/tolra-public/pull/289) | `codex/cq-pr-corrections` → `codex/cl-rounding-rule` | `bcf29b1589dfe9a15a593c583984e6c457690b1d` | [41830358899](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41830358899) in_progress, no conclusion |

CM: typecheck/lint pass (3 existing warnings), 9 setup tests pass; costing untouched. CN: eight plain-word checks and boxes; separate ninth PQ retained. CO: every VSR cell/evidence/decision/signature explained; no invented R6/R8 meaning or filled signature. CP: 25 owned GO/STOP steps, required six-release order and no 146 reinstall after rollback. CQ: one read of #281–#284; missing N1 daily view and evidence/packet mistakes corrected, lint/types/collection pass, runtime FAIL at missing-backend guard. Actual John/Rhys/cutover/database/browser/backup/import evidence remains NOT TESTED. CI success does not prove skipped integration work. Historical audit remains stopped at 52/61.


## Builder 3 explicit CR–BA continuation, 4 November 2026

Rhys assigned CR, CS, CT, CU, CV and BA; CR includes #314 and twelve builder4 sign-off sheets. Atomic claims/CR, CS, CT, CU, CV, BA created without overwriting any ref. Earlier BA #269 is historical; the new explicitly assigned ledger is #317. Original implementation owners retained. Full done / in progress / not started and exact commands: tests/HANDOVER-BUILDER-3.md on this coordination PR.

| Job / draft | Branch | Current head | CI snapshot |
| --- | --- | --- | --- |
| CR / [#298](https://github.com/rhyshume1997-alt/tolra-public/pull/298) | `codex/cr-builder4-review` | `8d161eca667cf3a64b4a9aaffb2df6ddba9d673d` | [41839489160](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41839489160) in_progress, no conclusion |
| CS / [#299](https://github.com/rhyshume1997-alt/tolra-public/pull/299) | `codex/cs-vsr-evidence-index` | `ecbf38f36bd4a57a9a93916bb51849b96e239cd5` | [41834666089](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41834666089) completed, success |
| CT / [#300](https://github.com/rhyshume1997-alt/tolra-public/pull/300) | `codex/ct-manual-count-map` | `49097c56f05e690b811872e24ff9b159b774f334` | [41834921405](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41834921405) completed, success |
| CU / [#305](https://github.com/rhyshume1997-alt/tolra-public/pull/305) | `codex/cu-first-day-smoke` | `78dc5b7033592f20640b15e61b198c7fcf17930e` | [41839392247](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41839392247) completed, success |
| CV / [#315](https://github.com/rhyshume1997-alt/tolra-public/pull/315) | `codex/cv-current-stack-checks` | `727ff228b6bc8575bc4440f409fdd3c41fe4ce5e` | [41839013622](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41839013622) in_progress, no conclusion |
| BA / [#317](https://github.com/rhyshume1997-alt/tolra-public/pull/317) | `codex/ba-first-day-41-evidence` | `9515eda33b50878a057a431b06498a5b1f15b204` | [41839231198](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41839231198) completed, success |

- CR #298: Review #290–#297, #314 and twelve sign-off sheets; cap/path fixes plus exact CN/CU corrections retained.
- CS #299: 41 fillable VSR cells and eight proposed restrictions mapped to exact refreshed file/line evidence; missing actual results marked.
- CT #300: All 64 expanded IDs mapped across original 35, refreshed 60 and builder 64 revisions; no invented signed scope.
- CU #305: Six short smoke rows; exact #314 MFA/AI-off corrections retained.
- CV #315: Local lint/types pass in both contexts; candidate 5622/5622 and isolated CM 5357/5357, zero failed/skipped/todo.
- BA #317: All 41 public first-day boxes mapped; 41 exact Operations Pack matches missing, actual execution NOT TESTED.

Reviewed #314 corrections retained in original CN #286 at bfaa31b84ebb04cec74c386787806320c3dee44e and CU #305 at 78dc5b7033592f20640b15e61b198c7fcf17930e. No docs/signoff duplication. CV passes are pinned to e7581c43 (latest-main-containing candidate) and a4c89af3 (isolated CM), not later document/report commits. CR preceding run 41837435184 web passed/integration skipped/ci-gate failed; current pending CI is not green. No Ready label/bypass/main merge/production SQL/deployment. Missing OperationsPack, actual runtime/import/recovery/provider/manual results and Rhys/John/reviewer decisions remain open. Historical 52/61 audit stays stopped.


## Builder 3 explicit B4/D5–DB queue, 4 November 2026

Rhys explicitly assigned six document/review jobs; atomic claims B4, D5, G9, C6, CY, CZ, DA, DB recorded. G9/C6 is the request only, not takeover of held importer ownership. One new draft per combined job; original implementation and builder4 masters unchanged. Full done/in-progress/not-started state and limits: tests/HANDOVER-BUILDER-3.md on #271.

| Job / draft | Exact head | Branch → target | CI snapshot |
| --- | --- | --- | --- |
| B4/D5 / [#319](https://github.com/rhyshume1997-alt/tolra-public/pull/319) | `ae5564652c09af54d09f0b67baed3f9211cf5546` | `codex/b4-d5-john-device-uat` → `main` | [41841871211](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41841871211) completed, success |
| G9/C6 / [#320](https://github.com/rhyshume1997-alt/tolra-public/pull/320) | `bf664425f819677b6f4256e627444940164f0793` | `codex/g9-c6-sliq-export-request` → `main` | [41842418634](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41842418634) completed, success |
| CY / [#321](https://github.com/rhyshume1997-alt/tolra-public/pull/321) | `09ca7ea87fa8c8dc7839c33f5e1813b313adfc6d` | `codex/cy-go-no-go-meeting` → `main` | [41845171602](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41845171602) completed, success |
| CZ / [#322](https://github.com/rhyshume1997-alt/tolra-public/pull/322) | `1b4ed92dcd4337e2c0bde4c67520ac3055aba72e` | `codex/cz-restriction-claims` → `codex/ba-first-day-41-evidence` | [41843717998](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41843717998) completed, success |
| DA / [#324](https://github.com/rhyshume1997-alt/tolra-public/pull/324) | `19b1d6a3f09502d798c1d09618cefa3f17f8cc01` | `codex/da-codex-merge-order` → `main` | [41844705802](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41844705802) in_progress, no conclusion |
| DB / [#333](https://github.com/rhyshume1997-alt/tolra-public/pull/333) | `8ca0aac7067bade11de78272f46d4a19aa0dab5f` | `codex/db-rhys-cutover-week` → `main` | [41844856929](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41844856929) completed, success |

- B4/D5 #319: 18 per-device click/expected rows with Pass/Fail/Not run and signature; source/navigation/role boundaries checked.
- G9/C6 #320: 440-word export handout, sixteen exact code-header/fake-row examples and unsent Rhys message with no full stops/em dashes.
- CY #321: 490-word Monday agenda: ten decision/evidence rows, Monday preparation decision distinct from final Thursday GO.
- CZ #322: 27 visible R-key occurrences reviewed; eight corrected proposals, source ledger, CS R8 correction and version notice in older CO.
- DA #324: All47 PR numbers classified:41open,6closed unmerged; unique code/docs/evidence and conditional closure rules.
- DB #333: Six dated rows: Fri6 backup/restore, Sat7 conditional wipe, Mon9 meeting, Tue10/Wed11 codes, Thu12 cutover; each has STOP.

No main merge/production SQL/Ready/deployment/newfeature/message send or signature. Source/inventory checks pass; documentation CI statuses above are not runtime/operator proof. Exact exports/pack/private handover, actual UAT and backup/restore/wipe/import/MFA/provider/SQL/browser evidence and John/Rhys/reviewer decisions remain open. DA requires authoritative41c685c4-vs9c3f5c6 base choice and conditional preservation before closures; no closure performed. Protected costing half-even/60golden unchanged. Historical52/61 audit stays stopped. Friday6 deadline / Thursday12 target retained.


## Builder 3 explicit M1–M4 queue, 4 November 2026

Rhys assigned four new documentation/review jobs; claims/M1–M4 created atomically with no existing claim overwritten. Original builder6/builder5/Claude importer/delivery ownership retained. One independent main-based draft per job. Full done/in-progress/not-started record: tests/HANDOVER-BUILDER-3.md on #271.

| Job / draft | Exact head | Branch → target | CI snapshot |
| --- | --- | --- | --- |
| M1 / [#362](https://github.com/rhyshume1997-alt/tolra-public/pull/362) | `7f3a8d48e7bc498628c175e62ed50419b4841856` | `codex/m1-second-review-c03-c16` → `main` | [41887095613](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41887095613) completed, success |
| M2 / [#364](https://github.com/rhyshume1997-alt/tolra-public/pull/364) | `83a2826b29ca6fdb139f4a0e7812d103865426be` | `codex/m2-sliq-load-runbook` → `main` | [41887740603](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41887740603) completed, success |
| M3 / [#365](https://github.com/rhyshume1997-alt/tolra-public/pull/365) | `1970388d390df9f8c8af9dcd7d94d1d5f71aa174` | `codex/m3-delivery-note-uat` → `main` | [41888283373](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41888283373) completed, success |
| M4 / [#367](https://github.com/rhyshume1997-alt/tolra-public/pull/367) | `a23e3041e75ec5a90dc2bb66f68247614ea77c7f` | `codex/m4-john-iso-pack-gaps` → `main` | [41888854407](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41888854407) completed, success |

- M1 #362: Independent second source review of all five #350–#354 files,21 findings/corrections,452 unfilled source-table rows;189 existing C03 IDs and125 canonical fields retained.
- M2 #364: docs/handover/SLIQ-LOAD-RUNBOOK.md: reported .xls/row6/footer conversion controls,2035+2=2037 October baseline, final/delta controls and complete unpaid/aged-debtors three-way tie-out.
- M3 #365: docs/handover/DELIVERY-NOTES-UAT-JOHN.md:18 required goods-out checks plus exactly six John questions; create/number/print/PDF/email/job/customer/receipt controls and actual blocker visibility.
- M4 #367: docs/iso9001/JOHN-PACK-GAPS.md:30 owner/evidence/timing actions; all14 I7 feature gaps and18 source files covered; actual company adoption remains open.

All four docs CI runs successful; no runtime/operator/company audit/financial/print/acceptance proof inferred. Verbatim private reviewer conditions/Operations Pack remain unavailable; actual originals/money totals/converter/operational-loader proof, required delivery-note numbering/job-route/UAT, private ISO company evidence and separate signatories remain open. No main merge, production SQL, live send/load, Ready label, deployment or new feature; no source-owner branch overwritten. Historical52/61 audit remains stopped. Required six-release order, retained146history/key_source and no reapply after rollback preserved.
