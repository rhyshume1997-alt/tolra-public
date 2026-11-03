# Reviewer conditions: candidate reconciliation

AE, 3 November 2026. No database or browser runtime executed here. These are real test files, not claims of passed database checks. No skip or exclusion is used for the database conditions. Missing credentials must fail the database command, not silently pass it.

| Condition | Unit/application test | Database proof | Browser proof / remaining gap |
| --- | --- | --- | --- |
| Approval exact text, edit invalidation, duplicate send and uncertain delivery | chase-approve, chase-approval-ui, chase-reviewed-text | chase-steps-138 proves the SQL claim/draft/sent permissions and invariants | chase-steps.spec.ts and #245 reviewer/chase.spec.ts exercise actual routes; no database runtime claimed |
| Customer reply never marks invoice paid | #241 chase-inbound-never-paid | inbound-mail baseline; dedicated fake paid/reply assertions queued in AI | #245 reviewer/chase.spec.ts |
| AI setting/cap company isolation, service-only key | tolra-ai, tolra-ai-caps, accounting/key isolation suites | tolra-provided-ai, tolra-ai-cap-concurrency | #245 reviewer/ai-support.spec.ts; cap race is two independent database sessions, not a browser fake |
| Accounting encrypted tokens, provider and company isolation | accounting-token-isolation (includes #240), accounting-routes | integrations-084/connect-107 cover original SQL permissions; expanded provider conditions queued in AI | #245 reviewer/accounting.spec.ts |
| Setup progress own admins only, not support/staff | company-setup-access includes #239's real access fix | company-setup-isolation currently covers cross-company admin isolation; SQL staff/support matrix queued in AI | #245 reviewer/ai-support and setup-email-hours specs |
| Legacy email text unchanged, read-only cannot save | email-template-editor-parts/UI | email-templates-106 | #245 reviewer/setup-email-hours.spec.ts |
| Paid/unpaid settings and timesheets agree across companies | company-paid-breaks, paid-breaks-two-companies | time attendance/week-review/day-flags | #245 reviewer/setup-email-hours.spec.ts |

The matrix will be updated by AI with the explicit database gaps above. None is represented as a skipped test. #241/#245 remain separately reviewed branches until folded as requested; #239 and #240 are already in #247, verified by ancestry and their application/test changes.

## Full database command and ordering

CI uses exactly `npm run test:db`. `vitest.db.config.ts` still includes every `tests/db/**/*.test.ts`, with no exclude. Its serial sequencer runs all frozen baseline files first, then company-setup-isolation, tolra-provided-ai and tolra-ai-cap-concurrency. Those proof files call the identity-guarded test-only release fixture: it holds a session advisory lock, checks the preflight markers, installs 145 before 146 only when not already verified, verifies again and requests a schema reload. Existing conflicting objects refuse atomically through the original one-time release guards.

The later upgrade rehearsal resets the disposable stack and proves baseline 013→144 twice; the retained CI steps then prove the same ordered post-144 release packages after that reset. No baseline snapshot or frozen SQL guard was relaxed to accommodate renamed AI functions. The complete release plan and all-proposal preflight coverage checks remain mandatory.

Still unproven here: full database runtime, baseline/combined upgrade, post-release verification/rollback/refusal behavior, two-connection race, actual browser routes and fake-provider checks in CI. Local unit/type/build results are recorded in the PR. No release SQL was executed locally.
