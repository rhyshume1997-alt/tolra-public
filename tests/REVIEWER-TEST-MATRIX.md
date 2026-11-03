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


## AI takeover reconciliation

The missing real SQL proofs are now committed on six independent codex2 branches (drafts #251 to #256) listed in tests/HANDOVER-CODEX-1.md. Setup roles/support: reviewer-setup-conditions.test.ts (or setup-reviewer-permissions.test.ts on #236). Delegated inbound paid replies: reviewer-inbound-conditions.test.ts on #241. Owner cap ACLs: reviewer-cap-conditions.test.ts on #232/#234. Exact-text and uncertain-delivery claims: reviewer-chase-conditions.test.ts on #233, with a real DB and mocked mail transport. Expanded Sage/QBO SQL access: reviewer-accounting-permissions.test.ts on #234. Existing real cap race is retained unchanged. None of these new proofs ran here, and none skips or installs schema. Each follow-up is based directly on its target head; they have not been merged.

GitHub credentials expired during AI and recovered during AK. AH is draft #250; AI is pushed as drafts #251 to #256. AJ updates the handover into #246. Focused unit regressions passed (4, 12, 4, 42, 39, 66 on targets #236, #239, #241, #232, #233, #234 respectively); all six branches passed typecheck and targeted lint. These numbers are not DB results. Register the new setup/cap files with the existing post-145/post-146 sequencing when integrating into #247, preserving full npm run test:db and every assertion. Rhys's report that Code ran the full prior #247 database suite is external evidence and does not cover these new files.


## Urgent candidate repairs and AK evidence

#247 is now d7c0019caa51f8a221e1f3b855e67f06d01ac3b4. The 145 policy permission fault is fixed through the existing scoped my_session API; private helper grants are unchanged. Its setup proof now includes ordinary/elevated support, staff, outsider and anon, plus second-install refusal. The provided-AI proof checks second-install refusal and rollback refusal around a real outstanding reservation. CI no longer installs one-time phases twice; the ordered fixture verifies every verification row. The real cap race and all baseline checks remain.

5,451 unit tests passed, 0 failed, 0 skipped; TypeScript, lint, release-plan and config loading passed. No SQL was executed. Claude Code must rerun the full database and diagnostic extras rehearsal; earlier external full-pass reports do not establish the repaired candidate passed.

AK is draft #258 into #247: 14 URS rows, 6 IQ, 14 OQ, 8 PQ; 347 mapped unit and 5,461 full unit tests passed with zero skips/failures. Dated synthetic logs are saved. URS-014's inbound-email subcondition still has no dedicated automatic test in #247; #241/#253 remain separate, with unrun manual G03.4 explicitly mapped. VSR sign-off remains blank for Rhys. The detailed published inventory and commands are in draft #257's HANDOVER-CODEX-1.md.

## Latest AH / AI / AK / AJ reconciliation

- AH #250 now includes eight real PostgreSQL review case definitions for append-only/API permissions, missing/differing/incomplete copy refusal, two-company protected-state comparison and each JNR-only provider disconnect. The prepared archive is real; source twins allow invalid-FK fixtures without disabling actual constraints. All SQL cases and the separate private-driver/FK rehearsal remain NOT RUN. Six parser/static units and types/lint passed.
- AI #255 keeps exact text/unknown delivery and adds four separately named DB cases: edit invalidation, paid claim financial invariance, duplicate-send refusal and cross-company refusal. The friendly fixture is offset 1, satisfying the unchanged SQL tone constraint. Five real DB cases remain unrun; 87 focused unit tests and types/lint passed.
- AI #253 into #241 was attempted through its isolation guard: 1 failed, 0 passed, 0 skipped because TEST_SUPABASE_URL is unset. No .env.test.local or test DB URL exists; no DB request/SQL occurred. This is BLOCKED infrastructure, not a payment-invariance assertion failure. Code's prepared disposable backend is required.
- AK #258 is refreshed onto #247 fe7514f. Fresh evidence at tests/validation/evidence/2026-11-03T21-36-30.386Z-2cd2549880f6-XPNxXH/ records 347 mapped / 5,461 full unit passes, zero failures/skips, and types/lint. URS-014 still identifies the external inbound automatic gap and unrun manual G03.4. Rhys's VSR sign-off is blank.
- STOP after rollback 146: key_source, usage and request history intentionally remain. Reinstall on that same rolled-back database requires an authorised disposable reset, not deleting history/columns or weakening guards. Never reset a live company for this. The no-global-key proof in #247 remains unrun SQL.

AJ #257 is the last update and contains the complete N1 to N7 / every-job tick list plus exact prepared-backend commands. No SQL, migrations, Docker startup, wipe, deploy or merge ran here. No private repository change occurred.
