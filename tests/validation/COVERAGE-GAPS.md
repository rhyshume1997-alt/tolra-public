# Coverage gaps and unrun evidence

Software is **NOT VALIDATED**. All still-unticked DB/browser file inventories, independent reviewer conditions and manual rows are listed in OUTSTANDING-CHECKS.md. Selected CI evidence lines do not clear the whole suite and are not a sign-off.

No URS row is wholly unmapped: all 14 have existing candidate tests and numbered manual checks. This does not mean every subcondition is automated or has passed.

The final candidate (`9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`) now contains the dedicated inbound-email financial-invariance DB test (`tests/db/reviewer-inbound-conditions.test.ts`, #253) and the ten reviewer browser cases. They are mapped under URS-013 and URS-014 below. The customer-says-paid UI unit covers paid claims only; G03.4 is the real, unrun manual check for the incoming-email condition.

| Requirement | Missing or external evidence |
| --- | --- |
| URS-009 | Expanded Sage/QuickBooks SQL permissions (reviewer-accounting-permissions, #256) are not integrated in the final candidate. Successful provider rehearsals remain NOT RUN until sandbox registrations exist (R2). |
| URS-010 | Owner cap SQL ACL expansion (reviewer-cap-conditions, #254/#256) is not integrated in the final candidate. The real two-session cap race is mapped (tests/db/tolra-ai-cap-concurrency.test.ts); a pass is recorded from CI only, never from a unit mock. |
| URS-013 | The #255 DB-backed approved-text, edit-invalidation, paid-claim, duplicate-approval and cross-company proofs are now in the final candidate as tests/db/reviewer-chase-conditions.test.ts, with browser cases V-CHASE-EDIT, V-CHASE-DOUBLE and V-CHASE-UNKNOWN. CI run 41816512073 reported them passing; that is recorded evidence for Rhys to review, not a completed OQ-013. Real mail-provider delivery is not proved (R5). |
| URS-014 | The URS-014 inbound-email subcondition now has tests/db/reviewer-inbound-conditions.test.ts (#253) and browser case V-INBOUND in the final candidate. CI run 41816512073 reported the DB test 1/1 passed; that is recorded evidence for Rhys to review, not a completed OQ-014. G03.4 is the mapped manual proof and remains NOT RUN. The customer-says-paid UI unit is supporting claim evidence only. |

All browser (including the ten V cases), OAuth sandbox and manual rows are NOT RUN by this pack's commands; the evidence command runs mapped unit files only. Recorded CI lines for the final SHA are summarised in OUTSTANDING-CHECKS.md and remain subject to Rhys's review. The #251/#252 setup reviewer tests, #254/#256 cap and accounting permission tests, #250 wipe kit and #243 `mark-disposable.sql` are not in the final candidate; their conditions stay open in OUTSTANDING-CHECKS.md.

The original #220 result of 119 unit tests belongs to that older mapping and commit. The dated evidence summary records the current mapped count; never reuse 119 as a claim about this candidate. Rhys must assess every remaining gap and every accepted restriction in RESTRICTIONS-AND-ASSUMPTIONS.md before signing the VSR.

Mapped database proofs that exist in the candidate include the real setup admin/staff/read-only/elevated-support/anon matrix, second-install refusal for 145/146, outstanding-reservation rollback refusal, the missing-global-provider-key proof in `tolra-provided-ai.test.ts`, the 140 `source_ref` and 141 `opening_wip` company isolation proof, and the 140/141 preflight marker proof. These are mapped, not locally executed here. The 146 rollback/reset stop rule is a documented restriction (R3): reinstalling 146 after its rollback is refused by design.
