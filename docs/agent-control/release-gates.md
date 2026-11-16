# Release gates — evidence, not a new plan

GO decision: Monday 9 November 2026. Target use: Thursday 12 November 2026. Rhys owns the decision. All production acceptance below is **NOT EXECUTED / NOT PROVEN HERE** until the authorised operator attaches real evidence. Synthetic tests do not clear a production gate.

| True gate for the agreed release | Owner / evidence needed |
| --- | --- |
| Exact final candidate and independent review | Code supplies final SHA/diff and green required CI; ChatGPT reviews. Open PR count is not a release manifest. |
| Recovery and company isolation | Operator/Rhys prove identified backup, restore, RPO/RTO, approved KEEP list, JNR-only wipe and Marpet identity preservation; actual private wipe comparison stays owned by Code. |
| Ordered database/counter/import steps | Freeze writers; 138,140,141,144,145,146,147 then approved wipe, retained rows/holds check, no-writes preflight, import once and reconcile, counter, deploy exact approved SHA, smoke, then human staff release. Never reapply 146 after rollback. |
| Correct records and day-one use | Approved import counts/totals/balances; numbering/concurrency/replay; staff device/UAT/access and delivery evidence. #389 synthetic proof helps but does not replace these. |
| Staff hold clarity | DEV-001 alert plus message implemented/reviewed and checked with the final candidate. #390 currently has four red assertions. |
| Default-off safety and permission | AI OFF, Xero transfers OFF until individually authorised; company access/financial permissions/configuration tested for final build. No keys or real accounts used by Codex. |
| Business acceptance | Rhys GO/NO-GO, authorised company operating sign-offs and unresolved risk decisions; no blank signature is approval. |

Can safely wait **while disabled/outside launch scope and explicitly accepted by Rhys**: AI activation, Xero live transfers, actual-profit replacement, extra Sage/API work, ISO certification assessment and optional Cloudflare skills. Profitability #391 defects have a coded fix in #378 fa5e358 (61 passed, none failed/skipped); independent review and company rate approval still block enabling the new calculation. The unchanged old calculation remains available. Missing optional credentials are configuration work, not a reason to redesign a built integration. Core financial/import/access/recovery failures cannot be deferred merely by calling them configuration.

## Exact evidence and review dependencies

Every PR #385–#398 is mapped in task-board.md and review-status-385-398.json. At the public observation, all 14 were open drafts, with no submitted GitHub review and only Vercel notices in comments. That snapshot is historical. Rhys now reports #387–#398 mostly SAFE WITH CONDITIONS; exact individual conditions UNPROVEN here except #390/#391 NOT SAFE until fixed/integrated and #396 not safe to merge yet. Preserve the new reviewer states in review-status-385-398.json. Do not infer ChatGPT approval from a successful build, a packet or an ignored preview. Recheck a changed SHA; this update itself changes #393 and needs review.

| Gate area | Supporting PRs | Still required |
| --- | --- | --- |
| Import/retained records | #385, #386 | Actual approved source/wipe/KEEP/Marpet and independent real reconciliation; reusable synthetic tests do not prove private scenario B |
| AI launch controls | #387, #395; #399 own-key funding proof | Tolra-provided 1000p cap/approval/default OFF on final build; own-key 500p is separate customer-funded credential path, no platform-key fallback. Credential billing ownership not inspected |
| Ordered cutover/numbering | #388, #389 | Exact final SHA, adopted import/deployment positions, authorised operator/production evidence; no live permission here |
| Staff held-company behaviour | #390 | Four original red message contracts remain; Code implementation and final UI verification pending |
| Actual-profit replacement | #391; fix in #378 fa5e358 | Precision fixes coded, not production-accepted; disabled until independent review and John-approved rates/flags |
| ISO/company evidence | #392 | Adopted company documents and real operating evidence; neither software nor drafts certify a company |
| Control/feature reconciliation | #393, #394 | Independent review of current exact heads; coded does not mean deployed |
| Accounting transfer | #396, diagnosis #400; Sage scope #401; accounting coverage #402 | Full required integration and accountant/configuration acceptance; transfers remain off until authorised |
| Optional skill adoption | #397 | No installation recommended; successful source-only CI is not release validation |
| Review handoff | #398 | Packets await ChatGPT review; historical CI/test claims are not newly executed acceptance |

**#396 exact CI failure is now established from its original log**, not guessed: run 41986450659 says `ready=false`, `web=success`, `integration=skipped`, then `WAITING: code changed but the full integration suite hasn't run. Add the ready label to run it; this check passes once it does.` It is not an Xero assertion failure or an environment/resource limit. The earlier diagnosis applied no label. Under the current CI-fix request, ready was added after local checks passed; full run41993566379 succeeded (unit5126, DB1628, upgrade23, browser582 passed; 9 DB/upgrade skips). No bypass was applied; this clears that CI run only. #396+#403 combined integration and reviewer conditions remain UNPROVEN. Other PR failures in the snapshot are not all attributed to this same cause without their own logs. #397 alone has a successful observed run; that does not clear the release.

Customer account statements and full ledger/statutory reports are real gaps from #402, not hidden existing features. Rhys/accountant must decide launch scope or an accepted external-accounting workflow. They cannot be silently marked optional or production-ready. None of this reopens DONE work without new evidence or changes Code's occupied ownership.

## Current controlling records

Use only #388 docs/runbooks/CONTROLLED-CUTOVER-2026-11-12.md for execution order and STOP rules; the 32 patch proposals are withdrawn/SUPERSEDED. Use only #405 docs/agent-control/MONDAY-EVIDENCE-PACK-2026-11-09.md as the Monday decision/evidence template. Candidate SHA, live reconciliation, deviations, backup/recovery/RPO/RTO and signed decisions remain UNPROVEN. New Xero149 requires an explicitly approved manifest/order before any release execution; do not silently extend the approved seven-release chain. #403 is coded, not installed, and #396+#403 combined verification is unproven. Own-key/default policy awaits Rhys's choice from neutral #404; no change is authorised by the note.
