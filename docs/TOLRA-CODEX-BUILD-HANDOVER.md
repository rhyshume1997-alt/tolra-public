| Job code | Work completed | Branch | PR | Tests | Remaining blocker |
| --- | --- | --- | --- | --- | --- |
| — (bank reconciliation #109; original code mapping unavailable) | Reject unclosed CSV quotes before returning any transactions; preserve valid quoted CSV | codex/bank-csv-quotes @ 72b3e2222d1ed639004d42e4aec3a2198dd79eb7 | #131, stacked on #120 | Four regression failures reproduced before fix; 44/44 bank tests pass twice after fix, including on final commit; tsc, targeted ESLint, diff check pass | CI pending; parent #120/#109 integration; no payment persistence implemented by this fix |
| A8 | Verified existing costing implementations without changing original branches | chatgpt/costing-in-tolra @ 2cd4a39; chatgpt/costing-wiring @ ad51521 | #110, #123 | #110: 73/73 focused tests including all 60 golden cases. #123: 81 passed, 412 skipped; tsc and targeted lint pass. Both exact commits have successful web CI | #110 integration still running at inspection; #123 integration skipped, gate failed |
| G9 | Verified existing SliQ tests | chatgpt/sliq-risk-tests @ 7f6acca; chatgpt2/sliq-importer-tests @ 51de46c | #122, #114 | 53/53 and 75/75 focused tests; existing exact-commit web CI successful | Integration skipped; actual export reconciliation and human sign-off outstanding |
| — (existing chasing/bank/paid-claim PRs; code mapping unavailable) | Verified existing tests | chatgpt/chase-more-tests @ 18617de; chatgpt/bank-matcher-more-tests @ aa520be; chatgpt/paid-claim-adapter @ 7956372; chatgpt/bank-check-ui @ d2ddea3 | #119, #120, #117, #116 | 43/43 chasing; 39/39 bank baseline; 18/18 paid adapter; 2/2 bank UI | No integration sign-off from these unit tests |
| — (coordination explicitly requested) | Published shared tracker and follow-up claim; Rhys authorised further fixes on separate branches | codex/work-ownership | #130 | Documentation diff checked | Current complete master-code mapping not found; no new codes invented |

## Master queue, 2 November 2026

Latest instruction prohibits touching held jobs. `claude/work-ownership:docs/TOLRA-WORK-OWNERSHIP.md` now explicitly holds all six implementation areas below. Earlier general follow-up permission does not override this later restriction. No original builder branch changed.

| Job | Work done | Branch | PR | Tests run and result | Blocker |
| --- | --- | --- | --- | --- | --- |
| paid-claim-wiring | Checked latest ownership and open PRs | claude/chase-steps (unchanged) | #111–#113, #117 existing | No new execution for this queue job | CHASE-P2/P3 inbox wiring held by ChatGPT builders and Claude |
| bank-check-wiring | Checked latest ownership; existing quote fix remains in #131 | codex/bank-csv-quotes | #131 | 44 bank tests previously passed | CHASE-P2/P3 bank page held by ChatGPT builders and Claude |
| chase-ui-wiring | Checked remote branches; chatgpt2/chase-wiring absent; ownership still held | claude/chase-steps (unchanged) | #111–#113 existing | Not run for this queue job | CHASE-P2/P3 approvals/screens held by ChatGPT builders and Claude |
| e13-tests | Checked ownership | claude/e13-timesheet-days (unchanged) | — | Not run for this queue job | E13 held by Claude Code |
| sliq-import-tests | Checked ownership; earlier parser results retained above | claude/sliq-import (unchanged) | #114, #122 existing | Prior 75/75 and 53/53 runs were on test PRs, not this branch | SLIQ held by Claude Code |
| costing-check | Prior golden checks retained above; no screen tests added to held code | chatgpt/costing-in-tolra; chatgpt/costing-wiring (unchanged) | #110, #123 | Both previously passed all 60 golden cases; #123 had 412 other skipped cases | COSTING maths/screens held by ChatGPT builder 1 and Claude |
| full-suite | Whole unit suite completed on Codex application branch | codex/bank-csv-quotes | #131 | 365 files, 4,787 tests passed; exit 0; 123.45 seconds on 72b3e22 | CI web passed; integration skipped, gate failed in run 41543184851 |

## NEXT UP

- Jobs 1–6: blocked by the explicit current ownership assignments on claude/work-ownership. They need an ownership release before Codex can change them under the latest queue rule.
- Job 7: all unit tests passed on Codex’s application branch. Coordination branch changes only Markdown, so no runtime suite applies. Database/browser integration remains unverified; no release sign-off.

## 3 November queue execution

| Job | Work done | Branch | PR | Tests | Blocker |
| --- | --- | --- | --- | --- | --- |
| paid-claim-wiring | Read current tracker and #159; canonical sender fixes already in #156/#157 | Existing branches untouched | #156/#157 | Not executed here | CHASE-P2/P3 marked in progress by another owner; inbox integration still required |
| bank-check-wiring | Confirmed #158 combines parser fixes; removed docs from own code PR | codex/bank-csv-quotes | #131 | Full checks running | Bank parent page, durable cross-export payment identity and confirmation persistence remain; active CHASE owner |
| chase-ui-wiring | Read #159 dependency conditions for #132/#153/#154 | Existing branches untouched | #132/#153/#154 | SQL tests not run; no migrations applied | Active CHASE owner; real database exact-text claim/edit/send remains unverified |
| e13-tests | Existing E13 IN PROGRESS claim preserved | claude/e13-timesheet-days unchanged | — | Not executed | Other owner holds E13 |
| sliq-import-tests | Existing G9 IN PROGRESS claim preserved | claude/sliq-import unchanged | — | Not executed | Other owner holds G9 |
| costing-check | Executed exact requested branch 8c4c7fe, inspected labour fallback | claude/costing-in-app unchanged | #130 | 15 pass, 472 skipped (including all 60 golden prices); fixture has 60 cases | lib/costing/engine.ts absent: parity and half-even cannot be verified here. Machine helper preserves explicit zero using nullish fallback; 14 rates-store tests pass |
| manual-checks | Reused existing checklist, corrected requested plus rule and added fractional pennies | codex/manual-checks | #183 | diff check pass; full checks running | Missing feature pages must be marked BLOCKED during manual run |
| available-jobs | Checked tracker rows | codex/work-ownership | #130 | Read-only | No AVAILABLE row found |

| Job | Work done | Branch | PR | Tests | Blocker |
| --- | --- | --- | --- | --- | --- |
| full-suite / bank privacy cleanup | Removed both tracker files from code PR diff; retained quote fix and tests | codex/bank-csv-quotes @ 0a6b970 | #131 | 365 files / 4,787 tests pass; tsc exit 0; full eslint exit 0 | Integration not run; no Ready label |
| manual-checks / full-suite | Published reused checklist with requested sender rule and fractional pennies; final verification complete | codex/manual-checks @ 6200405 | #183 | 368 files / 4,986 tests pass; tsc and full eslint exit 0; CI run 41587860353 success (Markdown-only change, not integration proof) | Manual steps not executed; feature wiring holds remain |

## NEXT UP — 3 November

Jobs 1–5 remain blocked by the existing IN PROGRESS ownership rows. No other owner's source changed. Inbox suggestion persistence, bank page/confirmation persistence, cross-export duplicate identity and actual database exact-approved-text send checks are outstanding. Costing base lacks its engine, so 60 golden prices and rounding are skipped, not passed. Manual checklist is delivered in #183. No AVAILABLE row was found. No Ready labels, migrations, production SQL, merges or deployments performed.

| Job | Work done | Branch | PR | Tests | Blocker |
| --- | --- | --- | --- | --- | --- |
| costing-join | Joined engine/screens on costing base; exposed rounding helper and fixed double-rounding at large values; retained all original golden assertions | codex/costing-join a4bd28f | #184 | 627 focused pass, 0 skip: 60 golden prices + 412 rounding cases; tsc pass | Full checks pending |
| costing-save-all-or-nothing | Reused one-RPC client and reviewed proposal; preserves machine overrides, rejects fractional pennies, no failed-save fallback or in-memory mutation | codex/costing-join | #184 | Atomic client tests included in 627; stronger failed-save snapshot assertions added | SQL proposal not applied or executed: real database rollback proof blocked by no-application rule |
| chase-join-check | Joined cards, pages, exact-approved-text client/server checks and SQL proof files; preserved conflicting progression assertions | codex/chase-join 1222de8 | #186 | Focused combination has 1 failure: inherited test expects firm after final already sent; current progression intentionally refuses backwards steps. Full run pending | Progression expectation conflict; SQL proof not executed under no-application rule |
| money-edge-tests | Added signed pennies, odd-amount 20% VAT, zero/negative owed, refunds, month/year/leap/DST day counts | codex/money-edge-tests 9454b4c | #185 | 16 focused cases pass; full checks pending | None identified in focused checks |

| Job | Work done | Branch | PR | Tests | Blocker |
| --- | --- | --- | --- | --- | --- |
| AQ | Pinned morning approval/STOP sentences to #247; explicitly holds 140-143; explains destructive rollback limits and proof order | codex/aq-morning-checklist | #262, 6be692d3e3fde62baed099c71dc518bfbf2930a5 | 14 numbered rows, missing-release warning, no em dashes and diff check PASS | Actual release proofs still required; no approval granted by document |
| AR | Updated #248 for pinned #247; corrected direct send, included setup fix, missing releases and recovery rules | codex/ar-manual-final | #263, 8cecd36e5fc852ae52e564db422f6201c8960a56 | 36 unique expected-result/NOT RUN rows and diff check PASS | Manual runtime checks not run |
| AS | Corrected stale backwards-progression fixture; retained highest-eligible-unsent coverage and added explicit no-backtrack/final-forward cases; no production code changed | codex/chase-join | #186, 474a90f63c4625cd29a8253343cd0899aa28f1cc | 43 focused pass, 0 failed, 0 skipped; diff check PASS | Full integration separate |
| AT | Re-executed full suites, TypeScript and full ESLint on both exact heads | codex/costing-join; codex/money-edge-tests | #184 a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2; #185 c857559f517c77ccaed4bac1446757c260bb52e3 | #184: 371 files, 5285 tests pass, 0 failures/skips. #185: 369 files, 5004 tests pass, 0 failures/skips. Both tsc pass; ESLint 0 errors, 12 existing warnings each | No SQL/browser integration executed |
| AW | Added guarded transfer plan, report-only fake dry-run command and signed private reconciliation template | codex/aw-data-load | #264 e26fd743e5145f5d9ee56878cc3733d88d147bdf | 83 fake importer/jobs/decision tests pass, zero failed/skipped; diff check pass | Real exports, write rehearsal and missing 140-143 release packaging still require authorised operator |
| AV | Added four named rollback business-row preservation/refusal tests, fake positive controls, exact snapshots and outer transaction cleanup in existing post-release sequenced file | codex/av-rollback-tests | #265 fcb4e9bac74447aef90f9c2d1d1333536024c6f4 | tsc and changed-file ESLint pass; diff check pass; real DB tests NOT RUN under no-SQL rule | Runtime rollback proof requires separately authorised disposable SQL; 138/145 intentionally delete feature data |
| AU | Identified last 30 candidate PRs (#232-261), but exhaustive screen-string review and fixes are not completed | No source changes | — | NOT RUN | Execution budget reached; no whole-review pass claimed |

## NEXT UP: AQ to AW

Run AV's real tests only on the separately authorised disposable rehearsal. Complete AU's exhaustive screen-string review over the recorded last-30 window (#232-261), excluding this queue's own PRs; do not claim a partial keyword scan is an exhaustive pass. AQ/AR are pinned to #247 head 41c685c416305637d86b580324fff9e6cda037ff and need rechecking if that changes. 140-143 packaging remains absent. Real database/browser/manual/import proofs remain distinct from unit, TypeScript and lint passes. No SQL applied, Ready labels, merges, deployments, main commits or secrets in this queue.

| AX | Nine pinned open-PR review packets; merged185 excluded | codex/ax-review-packets | #266, f728551a23720d229237f00e7c7a6d996315388a | 9 packet structures and diff pass; 0 runtime | Historical logs local; runtime limitations explicit |

| AY | Numbered backup/dump/restore/preflight/apply/verify/rollback runbook | codex/ay-db-runbook | #267, 9795ee1a8f5985dcaffb7823f9d55ded8698892d | 12 numbered steps; 14 shell blocks syntax and referenced files/diff pass; SQL NOT RUN | Separately authorised runtime/release proof required |

| AZ | Three named N1/N5/N6 real-browser persisted-state acceptance specs | codex/az-acceptance | #268, 94449be9b8a711b2f8eae96f5b30403b22296c7b | 3 collected; 39 supporting units pass; tsc and changed-file lint pass | Browser/SQL NOT RUN; reviewed145 prerequisite |

| BA | Evidence ledger maps 41 first-day boxes 36 manual steps 8 reviewer conditions plus release gates | codex/ba-evidence | #269, 89849ae3331bb6703a7d076d540843c4f63b6bc9 | Exact source-to-row coverage and diff pass; PASS counts attributed to executed heads | Exact Operations Pack not in fetched history; external/private completeness unverified |

| BB | Two-company fake export generator and exact penny reconciliation; offline CLI dry runs exercised | codex/bb-fake-data | #270, 4f210972adbffa2d5cd5c4148b1065a8df7548ef | 94 tests pass; tsc and targeted lint pass; both CLI reports reconcile; full suite running | Actual disposable database load/retry/RLS NOT RUN |
