# Single Monday evidence pack — 9 November 2026

**DRAFT v0.1. GO / NO-GO: UNPROVEN.** Target use: Thursday 12 November 2026. Prepared from public code, synthetic tests and Rhys's reported reviewer verdicts on 5 November. This is the single evidence/decision template, not another cutover plan. Blank/unknown means **UNPROVEN**, never PASS or approval. No production SQL, real records, wipe, import, deployment or message to John was performed here.

## Candidate and evidence identity

| Required record | Known value / missing proof |
| --- | --- |
| Exact final approved candidate SHA and release manifest | **UNPROVEN** — no combined approved candidate supplied. Do not substitute an individual PR head. |
| Main observed | 68f89ca7b801a10587ff9b51d6c820462847b65a; source presence is not production deployment |
| Relevant source heads | #378 f5de19ac22f51304fcaae0ced344e642ff2f73b0; #396 638a12c5fcd494597e1e99da95d77bb430256195; #403 5680410 (Xero hold, proposed149; baseline-checked catalogue delta and explicit synthetic opt-in fixture); #388 d7fc0b7 (controlling runbook). Recheck current heads before review. |
| One controlling cutover runbook | #388 docs/runbooks/CONTROLLED-CUTOVER-2026-11-12.md. Earlier sequences and the 32 patch proposals are SUPERSEDED. No other document changes its order. |
| Candidate artifact hash / build run / environment identity | UNPROVEN / UNPROVEN / UNPROVEN |
| Private evidence folder / named independent checker | UNPROVEN / UNPROVEN. Real records must not be put in this public pack. |
| Extra migration scope/order | **UNPROVEN** — approved chain is 138,140,141,144,145,146,147. New Xero149 requires explicit manifest/order approval before execution; do not silently insert it. Profitability148 can remain excluded/disabled pending approval. |

## Passed, failed and skipped tests

Counts below belong to their named source/run. They are not a single combined-candidate result. Original failure logs remain. Tester: Codex synthetic runs; date 5 November 2026. Human release acceptance of every row: **UNPROVEN**.

| Requirement / expected result | Actual result: passed / failed / skipped | Evidence reference and limit |
| --- | --- | --- |
| Xero must be OFF even for connected companies; admin-only release | #403: **221 / 0 / 0** mocked unit/regression; **5 / 0 / 0** fresh self-created identity-checked disposable DB; **186 / 0 / 0** release-wrapper assertions; six catalogue checks true | #403 tests/reviews/xero-launch/evidence; tsc/lint pass. Initial 60 unit tests are a subset, not extra. Combined #396+#403 browser/full-stack and production proof UNPROVEN. |
| #396 required integration must actually run | Old run41986450659: gate exit1, web success, integration job skipped, ready=false. Exact wait log in #400. Ready added after local checks; [run41993566379](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41993566379) **PASSED including required ci-gate**: unit5126/0/0, DB1628/0/7, upgrade23/0/2, browser582/0/0 (passed/failed/skipped). Completed browser09:39 UTC; configured120-minute timeout was not raised. See evidence/xero396-green-run.json | Seven DB and two upgrade skips remain unexecuted in that run; a green gate does not prove skipped cases. Not an environment-limit claim. #396 remains NOT SAFE TO MERGE under Rhys's reviewer report; #403 hold is separate and not integrated. |
| Profitability must retain pennies and stay disabled | #378 after packaging fix: focused **247 / 0 / 0** (calculations/allocation plus release wrapper); full local unit **5156 / 0 / 0** | #378 tests/reviews/profitability-fix/evidence. Unsafe revenue refuses; microseconds retained. Prior CI41990347549 had **5155 / 1 / 0**, migration148 transaction-wrapper error; fixed without weakening test. Local sandbox run had 7 process-permission failures, retained; unchanged suite then passed with process permission. |
| Updated #378 CI must pass at its exact head | [Run41994530885](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/41994530885), f5de19a: **web success; integration skipped; ci-gate failure**, ready=false. Exact gate wait retained in evidence/profit378-ci-gate-f5de19a.log | The migration-packaging failure is fixed; the remaining gate is missing full integration, not an asserted environment limit. Local pass is not remote integration. #391's reported NOT SAFE verdict remains until fixed work is independently reviewed/integrated; actual costing OFF pending rates approval. |
| Held staff must see alert plus plain message | #390: **2 / 4 / 0**, deliberate red contracts | tests/reviews/dev001; Code-owned implementation/integration and final UI check **UNPROVEN**. Reviewer: NOT SAFE until fixed/integrated. No #359/go-live edits here. |
| Cutover must freeze writes, stop on failed dependencies and never auto-restore | #388: **4 / 0 / 0** read-only document checks | tests/reviews/g32/evidence/controlling.log. Actual freeze/release/wipe/preflight/import/counter/deploy/smoke: **UNPROVEN / NOT EXECUTED**. |
| Earlier synthetic import/reconciliation and retained hold evidence | #385: **8 / 0 / 0**; #386: **9 / 0 / 0**; #389: **7 / 0 / 0**, historical runs | These do not prove private wipe scenario B, real exports or final production cutover. Source/evidence remain in those PRs. |
| Accountant-facing coverage must be known | #402: main **159 / 0 / 0**, unchanged pending #216 **57 / 0 / 0** | Actual customer account statements/full ledger/statutory reports are NOT STARTED; scope/fallback acceptance **UNPROVEN**. Existing exports are not accountant sign-off. |

Reviewer summary from Rhys: #387–#398 were mostly SAFE WITH CONDITIONS; detailed individual conditions/evidence are **UNPROVEN here** unless separately attached. Explicit exceptions: #390 and #391 **NOT SAFE until fixed and integrated**; #396 **not safe to merge yet**. No blanket SAFE, no waiver of conditions, and no new human signature is inferred from this pack.

## Reconciliation and remaining records

| Requirement / expected result | Actual result | Evidence / tester / date / approval |
| --- | --- | --- | --- |
| Per-file/source/destination counts and exact record identities agree | UNPROVEN | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Invoice/payment/credit totals and balances agree to every penny | UNPROVEN | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Unreconciled, rejected, duplicate, ambiguous or held records: count + reason + action | UNPROVEN — do not fill in zero without a checked result | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Approved SliQ exclusions and retrieval method; no unexplained omissions | UNPROVEN | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| KEEP rows, dln_numbering_pending and all Marpet identities/content preserved | UNPROVEN — actual scenario B comparison is private, owned by Code, not fetched here | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Day-of DLN counter and final147 verifier: 16 rows, all true, correct company/holds | UNPROVEN | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |

## Approved deviations and recovery proof

| Record | Known value / missing proof |
| --- | --- |
| Approved deviation ID, requirement, reason, risk, scope, owner, expiry, signed approval | **UNPROVEN** — no approved deviation supplied; do not write “none” or call open gaps accepted |
| Backup ID/time/hash, database/company identity and private storage | UNPROVEN |
| Isolated restore target identity and object/row/ownership comparison | UNPROVEN |
| Recovery duration measured; accepted RPO / RTO | UNPROVEN; UNPROVEN / UNPROVEN |
| Live activity after backup and expected loss if restored | UNPROVEN — backup restore loses later live activity |
| Named recovery operator, independent checker and Rhys's recovery approval | UNPROVEN / UNPROVEN / UNPROVEN |
| Write-freeze and staff-access release timestamps | UNPROVEN / UNPROVEN |

Any failed wipe/reconciliation/DLN/smoke check stops the next dependent step. **Never automatically restore. Never re-apply146 after rollback.** Keep the freeze and failed evidence; Rhys separately decides correction or recovery. A signed deviation cannot turn a wrong-company change or unexplained penny mismatch into a passing reconciliation.

## Named human decisions — no signatures filled in

| Decision | Decision owner / supporting person | Decision / evidence / date / signature |
| --- | --- | --- |
| GO / NO-GO, final SHA, manifest and release scope | Rhys | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Reviewer conditions closed, including #390/#391/#396 and combined #403 | ChatGPT review; Claude Code integrates owned candidate work | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Exact operator and independent checker; backup/RPO/RTO/recovery | Rhys names operator/checker (names UNPROVEN) | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Xero activation per company and proposed149 order | Rhys approves launch policy; company admin performs approved enable | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Own-key500p vs provided1000p policy | Rhys; neutral explanation in #404 | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Labour/machine/overhead rates, inclusion flags and actual-profit activation | John/company approval through Rhys's agreed process | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Accounting scope, statement/report gaps and external-accounting fallback | Rhys and accountant (accountant name UNPROVEN) | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |
| Reconciliation acceptance and staff smoke/access release | Rhys; named independent checker/tester UNPROVEN | UNPROVEN / UNPROVEN / UNPROVEN / UNPROVEN |

Monday recorder: UNPROVEN. Pack reviewer/date: UNPROVEN. Final approval/signature: UNPROVEN. Software and documents support the companies' controls; they do not certify a company or authorise production changes.
