# Next review packets

Snapshot: 4 November 2026. Scope: open PRs changed by this Codex worker, including the coordination PR. Read-only inspections of other builders' PRs are not modifications. #185 is omitted because GitHub confirms it is merged. New queue PRs need their own packets when published. These are review requests, not verdicts or authority to merge, send mail or apply SQL. Recheck the head before using any packet; a changed head invalidates its evidence.

Evidence source for historical counts: docs/TOLRA-CODEX-BUILD-HANDOVER.md on codex/work-ownership (AT logs retained in the working environment). Counts below were executed, not inferred from test files. Missing hosted logs are a review limitation; request a fresh run where required.

## PR #130

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/130
Full head SHA: bf608e6d76a2434af15d63cd95f1d6a8483698fa
Base: main
What changed: Ownership and verified handover only.
Tests and counts: 0 runtime tests required; tracker diff checked.
NOT proved: No feature acceptance, CI integration or release permission.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```

## PR #131

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/131
Full head SHA: 0a6b970ababe6b5c8e0f449084e1e81159fa68dd
Base: chatgpt/bank-matcher-more-tests
What changed: Reject the entire bank CSV if a quoted field is unclosed; retain valid quoted fields.
Tests and counts: 44 focused tests; full 4,787 tests passed, TypeScript and ESLint passed on this head (tracker evidence).
NOT proved: No bank payment persistence or database/provider integration; older checks do not establish current integration CI.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```

## PR #183

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/183
Full head SHA: 6200405e7c6d34f653a6460069738c7db71aa05c
Base: main
What changed: Manual checks for chasing, bank, costing, timesheet email and payment claims.
Tests and counts: 4,986 unit tests passed; TypeScript and ESLint passed (tracker evidence); checklist diff checked.
NOT proved: No manual clicks executed. GitHub reports merge conflict; reconcile then recheck.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```

## PR #184

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/184
Full head SHA: a4bd28f9d2b287001cdb6ee7ab11ac6728e7c0e2
Base: claude/costing-in-app
What changed: Join costing engine/screens and one-RPC atomic-save client; retain machine labour overrides and reject fractional pennies.
Tests and counts: 5,285 full tests passed, 0 failed/skipped; TypeScript passed; ESLint 0 errors, 12 existing warnings. Earlier focused 627 includes all 60 golden prices and 412 rounding cases.
NOT proved: No actual database atomic rollback, migration application, browser acceptance or integration gate proof.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```

## PR #186

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/186
Full head SHA: 474a90f63c4625cd29a8253343cd0899aa28f1cc
Base: claude/chase-steps
What changed: Join chasing and exact-approved-text checks; fix stale progression fixture and add explicit forward/no-backtrack assertions.
Tests and counts: 43 focused progression tests passed, 0 failed/skipped on this head. Earlier separate counts are not a final full-suite result.
NOT proved: Final full-suite/TypeScript/lint not rerun after AS; database exact-text/concurrent-send and browser checks not executed.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```

## PR #262

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/262
Full head SHA: 6be692d3e3fde62baed099c71dc518bfbf2930a5
Base: main
What changed: 14 numbered release checks with exact conditional approval sentences; hold absent 140-143.
Tests and counts: 14 numbered steps, absent-release warning, no em dashes and diff checks passed; 0 runtime tests.
NOT proved: No actual approval, backup, release, rollback or browser proof. Pinned to candidate 41c685c416305637d86b580324fff9e6cda037ff.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```

## PR #263

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/263
Full head SHA: 8cecd36e5fc852ae52e564db422f6201c8960a56
Base: codex/z-go-live-manual-checks
What changed: Align manual checks with final candidate, direct approve-and-send action and rollback stop rule.
Tests and counts: 36 unique expected-result and NOT RUN steps checked; diff passed; 0 runtime tests.
NOT proved: No manual runtime steps executed; stacked on #248, not independently merged.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```

## PR #264

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/264
Full head SHA: e26fd743e5145f5d9ee56878cc3733d88d147bdf
Base: claude/sliq-import
What changed: Fake-only transfer dry run and private reconciliation checklist for customers/jobs/POs/invoices/payments.
Tests and counts: 83 fake importer/jobs/decision tests passed, 0 failed/skipped.
NOT proved: No real export mapping, database import/retry, real balances or John/Rhys sign-off; 140-143 absent from candidate.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```

## PR #265

```text
Review https://github.com/rhyshume1997-alt/tolra-public/pull/265
Full head SHA: fcb4e9bac74447aef90f9c2d1d1333536024c6f4
Base: codex/x-final-main-candidate
What changed: Four named rollback business-row preservation/refusal tests with synthetic positive controls.
Tests and counts: TypeScript and changed-file ESLint passed; diff passed. 0 database tests executed.
NOT proved: All four rollback runtime proofs NOT TESTED. 138/145 intentionally remove feature data; this is not lossless rollback proof.
Question: Is this exact change SAFE, SAFE WITH CONDITIONS or NOT SAFE? Name every remaining condition and the evidence needed. Assess code review separately from permission to release.
```


