# Coverage gaps and unrun evidence

No URS row is wholly unmapped: all 14 have existing candidate tests and numbered manual checks. This does not mean every subcondition is automated or has passed.

**URS-014 has no dedicated inbound-email financial-invariance test on this #247 head.** Its UI test covers paid claims only. G03.4 is the real, unrun manual check. Do not claim the UI test or the old inbound storage test proves the incoming-email condition.

| Requirement | Missing or external evidence |
| --- | --- |
| URS-009 | Expanded Sage/QuickBooks SQL permissions are added in draft #256, not in this candidate. Successful provider rehearsals remain NOT RUN until sandbox registrations exist. |
| URS-010 | Owner cap SQL ACL expansion is in drafts #254/#256, not in this candidate; the existing real cap race is mapped but NOT RUN here. |
| URS-013 | Full DB-backed approved-text/unknown-delivery transport proof is in draft #255, not in this candidate. Unit and SQL claim tests alone do not complete that proof. |
| URS-014 | URS-014 inbound-email subcondition has NO dedicated automated regression on #247. #241 supplies the unit evidence and draft #253 adds real delegated-RPC financial invariance. Neither is folded here. G03.4 is the mapped manual proof and remains NOT RUN. The customer-says-paid UI unit is supporting claim evidence only. |

All database, browser, OAuth sandbox and manual rows are NOT RUN by this pack. #245 browser wiring and #241 inbound application evidence are separate PRs, not silently copied into #247 here. New AI follow-up tests #251 to #256 need correct post-145/146 sequencing when integrated. The mapped real cap race exists already, but no SQL is authorised in this session.

The original #220 result of 119 unit tests belongs to that older mapping and commit. The dated AK evidence summary records the current mapped count; never reuse 119 as a claim about this candidate. Rhys must assess every remaining gap before signing the VSR.

The updated #247 base adds the real setup admin/staff/read-only/elevated-support/anon matrix, second-install refusal for 145/146 and outstanding-reservation rollback refusal. These are mapped database proofs, not locally executed results. The private membership helper remains private and policies use the existing scoped session API.
