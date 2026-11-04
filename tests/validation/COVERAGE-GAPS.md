# Coverage gaps and unrun evidence

Software is **NOT VALIDATED**. All still-unticked DB/browser file inventories, independent reviewer conditions and manual rows are listed in OUTSTANDING-CHECKS.md. Selected extras evidence does not clear the whole suite.

No URS row is wholly unmapped: all 15 have existing candidate tests and numbered manual checks. This does not mean every subcondition is automated or has passed.

**URS-014 has no dedicated inbound-email financial-invariance test on this #247 head.** Its UI test covers paid claims only. G03.4 is the real, unrun manual check. Do not claim the UI test or the old inbound storage test proves the incoming-email condition.

| Requirement | Missing or external evidence |
| --- | --- |
| URS-009 | Expanded Sage/QuickBooks SQL permissions are added in draft #256, not in this candidate. Successful provider rehearsals remain NOT RUN until sandbox registrations exist. |
| URS-010 | Owner cap SQL ACL expansion is in drafts #254/#256, not in this candidate; the existing real cap race is mapped but NOT RUN here. |
| URS-013 | Full DB-backed approved-text/unknown-delivery transport proof is in draft #255, not in this candidate. Unit and SQL claim tests alone do not complete that proof. |
| URS-014 | URS-014 inbound-email subcondition has NO dedicated automated regression on #247. #241 supplies the unit evidence and draft #253 adds real delegated-RPC financial invariance. Neither is folded here. G03.4 is the mapped manual proof and remains NOT RUN. The customer-says-paid UI unit is supporting claim evidence only. |
| URS-015 | Real backup restore, exact combined wipe, actual JNR mapping/import/reconciliation and post-release browser evidence are NOT TESTED locally. |

All database, browser, OAuth sandbox and manual rows are NOT TESTED by this pack. #245 browser wiring and #241 inbound application evidence are separate PRs, not silently copied into #247 here. New AI follow-up tests #251 to #256 need correct post-145/146 sequencing when integrated. The mapped real cap race exists already, but no SQL is authorised in this session.

The original #220 result of 119 unit tests belongs to that older mapping and commit. The dated AK evidence summary records the current mapped count; never reuse 119 as a claim about this candidate. Rhys must assess every remaining gap before signing the VSR.

The updated #247 base adds the real setup admin/staff/read-only/elevated-support/anon matrix, second-install refusal for 145/146 and outstanding-reservation rollback refusal. These are mapped database proofs, not locally executed results. The private membership helper remains private and policies use the existing scoped session API.

The refreshed #247 base includes the missing-global-provider-key DB proof and the 146 rollback/reset stop rule. These are mapped through tolra-provided-ai.test.ts and remain NOT RUN locally. Draft #255 now has separate named DB cases for edit invalidation, paid claims, duplicate sends and cross-company refusal; draft #253 retains delegated inbound financial snapshots. Both follow-ups still need separately authorised execution and integration. The stronger AH archive proof stays on draft #250, not silently folded into this candidate.


CE permits fake disposable SQL checks under the current user instruction; none ran because Docker image registration failed with ENOSPC before a backend started. Earlier statements that SQL was prohibited describe earlier sessions, not current permission. No real-data SQL was applied.
