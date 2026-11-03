# Reviewer conditions: candidate reconciliation

AE, 3 November 2026. No database or browser runtime executed here. These are real test files, not claims of passed database checks. No skip or exclusion is used for the database conditions. Missing credentials must fail the database command, not silently pass it.

| Condition | Unit/application test | Database proof | Browser proof / remaining gap |
| --- | --- | --- | --- |
| Approval exact text, edit invalidation, duplicate send and uncertain delivery | chase-approve, chase-approval-ui, chase-reviewed-text | chase-steps-138 proves the SQL claim/draft/sent permissions and invariants | chase-steps.spec.ts and #245 reviewer/chase.spec.ts exercise actual routes; no database runtime claimed |
| Customer reply never marks invoice paid | #241 chase-inbound-never-paid | inbound-mail baseline; dedicated fake paid/reply assertions queued in AI | #245 reviewer/chase.spec.ts |
| AI setting/cap company isolation, service-only key | tolra-ai, tolra-ai-caps, accounting/key isolation suites | tolra-provided-ai, tolra-ai-cap-concurrency | #245 reviewer/ai-support.spec.ts; cap race is two independent database sessions, not a browser fake |
| Tolra-provided mode without a global key never falls back to a configured company key | ai-mode-key-isolation is supporting unit evidence | tolra-provided-ai: own-key positive controls, then missing-global-key refusal for round-up/RFQ/assistant; full request/usage/key snapshots unchanged | Real SQL proof added, NOT RUN here; see rollback stop rule below |
| Accounting encrypted tokens, provider and company isolation | accounting-token-isolation (includes #240), accounting-routes | integrations-084/connect-107 cover original SQL permissions; expanded provider conditions queued in AI | #245 reviewer/accounting.spec.ts |
| Setup progress own admins only, not support/staff | company-setup-access includes #239's real access fix | company-setup-isolation on repaired #247 covers own-admin read/write, cross-company refusal, office/workshop/viewer, ordinary/elevated support, outsider and anon; SQL runtime remains NOT RUN | #245 reviewer/ai-support and setup-email-hours specs |
| Legacy email text unchanged, read-only cannot save | email-template-editor-parts/UI | email-templates-106 | #245 reviewer/setup-email-hours.spec.ts |
| Paid/unpaid settings and timesheets agree across companies | company-paid-breaks, paid-breaks-two-companies | time attendance/week-review/day-flags | #245 reviewer/setup-email-hours.spec.ts |

The matrix will be updated by AI with the explicit database gaps above. None is represented as a skipped test. #241/#245 remain separately reviewed branches until folded as requested; #239 and #240 are already in #247, verified by ancestry and their application/test changes.

## Full database command and ordering

CI uses exactly `npm run test:db`. `vitest.db.config.ts` still includes every `tests/db/**/*.test.ts`, with no exclude. Its serial sequencer runs all frozen baseline files first, then company-setup-isolation, tolra-provided-ai and tolra-ai-cap-concurrency. Those proof files call the identity-guarded test-only release fixture: it holds a session advisory lock, checks the preflight markers, installs 145 before 146 only when not already verified, verifies again and requests a schema reload. Existing conflicting objects refuse atomically through the original one-time release guards.

The independent upgrade rehearsal proves baseline 013 to 144 twice. The ordered test:db fixture owns the one-time 145/146 installs and verification; the redundant standalone CI install steps have been removed. No baseline snapshot or frozen SQL guard was relaxed to accommodate renamed AI functions. The complete release plan and all-proposal preflight coverage checks remain mandatory.

Still unproven here: full database runtime, baseline/combined upgrade, post-release verification/rollback/refusal behavior, two-connection race, actual browser routes and fake-provider checks in CI. Local unit/type/build results are recorded in the PR. No release SQL was executed locally.


## Urgent 146 missing global key proof and rollback stop rule

`tests/db/tolra-provided-ai.test.ts` now includes a real PostgreSQL proof for **Tolra-provided mode with no global provider key**. First, all three reservation entry points succeed with the company's own configured key. The fixture then selects provided mode and removes the global key, retaining the company key and enabled features. Round-up, RFQ and assistant reservations must each refuse with `42501 / ai_helper_off / Tolra AI is off.` Full company request, usage and own-key snapshots must stay unchanged after each refusal. This proves no successful own-key fallback or reservation charge, rather than merely proving refusal when no company key exists. The test uses a rolled-back synthetic transaction, no provider calls and no skip. It is **NOT RUN here** under the no-SQL instruction; Code must run it on the separately authorised disposable backend.

**STOP RULE: rolling back 146 deliberately keeps `ai_helper_requests.key_source`, request history and usage. A second 146 install on that same rolled-back database requires a reset.** Stop if the database has been rolled back from 146; it is not a fresh pre-146 database, even if the Tolra tables/functions are gone and the old reserve functions are restored. Retain the rehearsal evidence, then have the authorised operator reset/recreate only the disposable test database to the reviewed baseline through 144 and prepare 145 then 146 in order. Never drop `key_source`, delete retained audit/request history, add IF NOT EXISTS, or weaken a release guard to force a reinstall. Never reset a live or hosted company database for this check.

The existing second-install test checks refusal while 146 is still installed. It does not claim reinstall after rollback is supported. The outstanding-reservation rollback-refusal proof and existing 145 role assertions remain unchanged. No SQL was applied in this follow-up.
