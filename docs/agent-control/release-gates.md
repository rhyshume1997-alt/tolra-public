# Release gates — evidence, not a new plan

GO decision: Monday 9 November 2026. Target use: Thursday 12 November 2026. Rhys owns the decision. All production acceptance below is **NOT EXECUTED / NOT PROVEN HERE** until the authorised operator attaches real evidence. Synthetic tests do not clear a production gate.

| True gate for the agreed release | Owner / evidence needed |
| --- | --- |
| Exact final candidate and independent review | Code supplies final SHA/diff and green required CI; ChatGPT reviews. Open PR count is not a release manifest. |
| Recovery and company isolation | Operator/Rhys prove identified backup, restore, RPO/RTO, approved KEEP list, JNR-only wipe and Marpet identity preservation; actual private wipe comparison stays owned by Code. |
| Ordered database/counter/import steps | 138,140,141,144,145,146,147 then approved wipe, retained rows/holds check, counter; Rhys explicitly positions SliQ reconciliation and app deployment. Never reapply 146 after rollback. |
| Correct records and day-one use | Approved import counts/totals/balances; numbering/concurrency/replay; staff device/UAT/access and delivery evidence. #389 synthetic proof helps but does not replace these. |
| Staff hold clarity | DEV-001 alert plus message implemented/reviewed and checked with the final candidate. #390 currently has four red assertions. |
| Default-off safety and permission | AI OFF, Xero transfers OFF until individually authorised; company access/financial permissions/configuration tested for final build. No keys or real accounts used by Codex. |
| Business acceptance | Rhys GO/NO-GO, authorised company operating sign-offs and unresolved risk decisions; no blank signature is approval. |

Can safely wait **while disabled/outside launch scope and explicitly accepted by Rhys**: AI activation, Xero live transfers, actual-profit replacement, extra Sage/API work, ISO certification assessment and optional Cloudflare skills. Profitability #391 defects block enabling the new calculation, not operation of the unchanged old one. Missing optional credentials are configuration work, not a reason to redesign a built integration. Core financial/import/access/recovery failures cannot be deferred merely by calling them configuration.
