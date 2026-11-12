# Tolra ChatGPT builder handover 1

Prepared 2 November 2026. All branches are review only. No Ready labels, merges, SQL migrations or deployments performed. GitHub connector can commit and create PRs, but this execution environment cannot clone github.com, so Vitest, TypeScript, lint, browser and database test runs have not been executed here. No result below is a claim of passing tests.

## Deliverables and review order

| PR | Branch and base | Changed files | What it does | Test state / what remains |
| --- | --- | --- | --- | --- |
| [#107](https://github.com/rhyshume1997-alt/tolra-public/pull/107) | chatgpt/paid-claim → main | lib/chase/paid-claim.ts, tests/unit/paid-claim.test.ts | Detects customer payment claims, ignores future/quoted claims and searches known invoice refs | Tests committed, unrun. Review quoted replies and signatures. |
| [#108](https://github.com/rhyshume1997-alt/tolra-public/pull/108) | chatgpt/chase-steps → main | lib/chase/steps.ts, tests/unit/chase-steps.test.ts | Due schedule and reminder rendering, with monotonic step rule and singular day correction | Tests committed, unrun. |
| [#109](https://github.com/rhyshume1997-alt/tolra-public/pull/109) | chatgpt/bank-matcher → main | lib/bank/match-statement.ts, tests/unit/bank-match-statement.test.ts | Parses UK bank CSV and suggests exact amount matches | Tests committed, unrun. Confirm no malformed CSV row passes through. Bank matcher currently exports matchStatementLines, not matchInvoices. Does not auto-post payments. |
| [#110](https://github.com/rhyshume1997-alt/tolra-public/pull/110) | chatgpt/costing-in-tolra → main | lib/costing/engine.ts, components/costing/types.ts, costing-rates-editor.tsx, price-this-part.tsx; tests/unit/costing-engine-parity.test.ts, costing-golden.test.ts, costing-ui.test.ts; tests/fixtures/costing-golden.json | TypeScript costing port, 60 Python golden cases, props-driven rate and quote UI | Unit tests written but unrun. All 60 examples MUST pass before acceptance. Verify half-to-even at both pence and time rounding and remove differences from the Python outputs. |
| [#116](https://github.com/rhyshume1997-alt/tolra-public/pull/116) | chatgpt/bank-check-ui → main | lib/bank/match-statement.ts, components/bank/bank-check.tsx, tests/unit/bank-check-ui.test.ts | CSV upload, to confirm / unsure / no match groups; Mark as paid and Skip callbacks | Basic render tests committed, unrun. Shares a copied dependency with #109; deduplicate after #109 merges. Callback is not a payment write, enforce server reconciliation and idempotency before connecting. |
| [#117](https://github.com/rhyshume1997-alt/tolra-public/pull/117) | chatgpt/paid-claim-adapter → main | lib/chase/paid-claim.ts, lib/chase/paid-claim-adapter.ts, tests/unit/paid-claim-adapter.test.ts | Suggests unpaid invoices from emails without marking paid | At least 15 scenarios committed, unrun. Copied dependency from #107; deduplicate after merge. Review spoofed sender and multi-invoice claims. |
| [#118](https://github.com/rhyshume1997-alt/tolra-public/pull/118) | chatgpt/chase-wording → main | lib/chase/steps.ts, tests/unit/chase-wording.test.ts | Polite pre-due, friendly, firm and final reminder language | Tests committed, unrun. Uses pending #108 code; rebase after #108. |
| [#119](https://github.com/rhyshume1997-alt/tolra-public/pull/119) | chatgpt/chase-more-tests → chatgpt/chase-steps | tests/unit/chase-more.test.ts | Calendar, leap day, month end, sent-state, offset and context tests | Extra tests committed, unrun. Base is #108 branch; rebase before any eventual main PR. |
| [#120](https://github.com/rhyshume1997-alt/tolra-public/pull/120) | chatgpt/bank-matcher-more-tests → chatgpt/bank-matcher | tests/unit/bank-more.test.ts | Matching ambiguity, duplicate bank line, part payment refusal, exact pence, dates | Extra tests committed, unrun. The current matcher deliberately only suggests a unique exact amount, not partial/over payments. |
| [#121](https://github.com/rhyshume1997-alt/tolra-public/pull/121) | chatgpt/costing-more-tests → chatgpt/costing-in-tolra | tests/unit/costing-extra-edge.test.ts | Boundary, invalid data, exact tie, quantity and margin cases | Tests committed, unrun; depends on #110. |
| [#122](https://github.com/rhyshume1997-alt/tolra-public/pull/122) | chatgpt/sliq-risk-tests → main | tests/unit/sliq-risk-guards.test.ts | Read-only SliQ header, blank row, malformed CSV, pence and date guards | Tests committed, unrun. Complements Builder 2 PR #114. Still needs customer and invoice duplicate import outcomes checked against real SliQ exports. |
| [#123](https://github.com/rhyshume1997-alt/tolra-public/pull/123) | chatgpt/costing-wiring → claude/costing-in-app | lib/costing/engine.ts, components/costing/types.ts, costing-rates-editor.tsx, price-this-part.tsx, connected-costing.tsx; app/(dashboard)/settings/page.tsx, app/(dashboard)/quotes/page.tsx; tests/unit/costing-wiring.test.ts | Connects settings editor and price panel to company rates store; uses money.ts for quote line price; hides unconfigured panel | Tests written, unrun. Base has migration 143 from Builder 2: do not deploy or apply without separate review. Migrate repeated components from #110 in final integration. Verify partial save behaviour, company switches, each price unit and per-machine labour rate. |
| This handover PR | chatgpt/final-handover-1 → main | docs/CHATGPT-BUILD-HANDOVER-1.md | Explains branches, dependencies, checks and risks | Document only, no test required. |

## Cross review of Builder 2

PRs #111, #112, #113, #114 and #115 were inspected. Individual review comments were posted in their GitHub conversations. Most important: PR #115 describes £100 cost at 20% as £125, while the Python pricing formula in source is cost × 1.20 = £120. Correct wording or obtain approved change to maths. Don't silently change pricing.

## Weekly timesheet email risk advice

Optional weekly sending stays OFF by default. An authorised admin should choose days, UK-local time and recipients. Reject invalid or external recipients if company policy says internal only. Confirm timezone and daylight savings rules. Prevent duplicate sends from retries, overlapping cron runs and changing the schedule mid-run. Never silently include employees from another company or leak hours to unauthorised recipients. Handle failed email sends with a clear draft/failed status; don't mark a failed send successful. Ensure hours reflect approved corrections and the specified reporting period, including bank holidays, missing punches and overnight shifts. Record who enabled it and when. No new recurring job or migration was created here.

## SliQ source risks still needing evidence

Date ambiguity such as 02/03/2026, unsupported date format, quoted commas, blank/duplicate headers and rows, subpenny values, leading zero document references, repeated invoice numbers, same-name customers with distinct account IDs, credit notes, refunds, unverified paid state, split payments, open jobs, open supplier POs and numbering continuity. Unit tests cover the parser; they do not replace a signed production export reconciliation. Independent Aged Debtors and opening balances must reconcile to the penny.

## Review controls

1. Inspect each PR's exact base branch and changed files. Several are stacked and intentionally share copied files because the parent PR is not yet on main.
2. Run tests against the exact commit without speculative retries: npm run typecheck, npm run lint, focused vitest, relevant end-to-end and DB suites, then one labelled CI run according to release policy.
3. Do not label Ready or merge on a red ci-gate. No migrations or deployments from these branches have been authorised.
4. Confirm whether the costing golden fixture's 60 comparisons all pass and whether the half-even behaviour exactly matches Python, especially ties at subpenny precision.
5. Ensure server write paths are authorised and idempotent before hooking any UI callback that records paid or sends email.
6. Reconcile the pricing engine's current markup calculation with UI naming that says margin. This is a pricing decision, not simply a naming preference.

## CI verification update, 2 November 2026

These are observed runs on the named commits, not an assertion that each PR's latest head is green. PRs with unverified current heads must be checked again before review.

| PR | Observed run | Web job | Integration | CI gate | After action |
| --- | --- | --- | --- | --- | --- |
| #107 | 41521786846 | PASS | SKIPPED | FAIL | No code failure established in this run; Ready label prohibited |
| #108 | 41526239029 | PASS | SKIPPED | FAIL | No code failure established in this run; Ready label prohibited |
| #109 | 41522062298 | PASS | SKIPPED | FAIL | No code failure established in this run; Ready label prohibited |
| #110 | 41538339751 on 2cd4a39 | PASS, 5,001/5,001 unit tests including all 60 golden fixtures | SKIPPED | FAIL | Maths passing; integration blocked by Ready rule |
| #123 | 41539369901 on previous head | FAIL, TS1005 syntax in connected-costing.tsx line 30 | SKIPPED | FAIL | Fixed in ad515217; new CI result not yet verified |
| #116, #117, #118, #119, #120, #121, #122, #124 | Not verified in this audit | Unknown | Unknown | Unknown | Current commit and labelled run evidence still required |

The red ci-gate with passing web jobs is explained by the workflow's deliberate decision to skip integration without Ready. Don't remove this gate, misreport it as green, or apply Ready contrary to release instructions. The #123 syntax error was a real code failure and has been fixed on its branch but not yet confirmed by a new run.

Further review work: #125 is the JNR-only wipe guide. Issues #126, #127, #128 and #129 capture branch reviews for chase, timesheets, SliQ importer and costing store. These issues are acceptance checks except where they cite inspected source. No migration or deployment performed.

## CI evidence checked 2 November, subsequent review

PR #110 commit 2cd4a39 CI run 41538339751: web SUCCESS, 368 of 368 Vitest files and 5001 of 5001 tests passed, including 62 tests from costing-golden.test.ts (60 generated Python scenarios and two fixture tests). The overall gate failed solely because the integration job was skipped while Ready was absent. Ready was subsequently added to #110, initiating run 41539927421, which was still running at last inspection. Check the finished result before merging. This is proof of TypeScript results matching Python reference fixtures, not a new run of Python itself.

PR #123 run 41539369901: web FAILED with a TypeScript parsing error in components/costing/connected-costing.tsx line 30. A later read of the current branch showed the malformed quoted string had already been corrected by another update, so avoid overwriting it. Rerun validation on the current branch head and inspect any new errors. Don't add Ready to #123 until web checks pass. Note PR #123 contains the corrected Python-compatible rounding implementation synced from #110 (commit 446bc44).

Release rule: green web checks on the exact commit are necessary but not sufficient. Complete the integration job, verify auth/RLS/company switching and payment idempotency, and confirm green ci-gate. No release sign-off has been made by this document.
