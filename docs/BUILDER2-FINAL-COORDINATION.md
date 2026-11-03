# Builder 2 final coordination — jobs 18 to 23

Updated 3 November 2026. All work is in draft PRs. No Ready labels, PR merges, deployments, applied migrations or main commits. Main was merged only into builder 2 branches under job 20. Other builders’ branches were not changed.

## What is ready for review

| Job | PRs | Work and verification |
|---|---|---|
| 18 | [#144](https://github.com/rhyshume1997-alt/tolra-public/pull/144), [#145](https://github.com/rhyshume1997-alt/tolra-public/pull/145), [#146](https://github.com/rhyshume1997-alt/tolra-public/pull/146), [#147](https://github.com/rhyshume1997-alt/tolra-public/pull/147) | Chase approval snapshots and cancelled-form reopening; atomic save client paths and SQL proposals; machine labour override; awaited bank confirmation and retry/reference checks; sender checks and staff guide. 40 chase, 13 costing, 67 bank and 58 sender cases reported passing; TypeScript/lint passed per branch. All four exact latest web jobs passed. |
| 19 | [#148](https://github.com/rhyshume1997-alt/tolra-public/pull/148) | Exact latest-head web checks for #132–143: nine passes, three intentional docs-only skips. Checked again after job 20; same totals, fresh commit evidence in [CI audit](BUILDER2-CI-WEB.md). No real web failure needed a speculative fix. |
| 20 | [#149](https://github.com/rhyshume1997-alt/tolra-public/pull/149) | Merged main into #135/#139/#140/#145; retained both security and costing preflight checks; joined updated bases into children. Original 34 branch/base checks clean. Final expansion: 25 open builder 2 PRs, 38 checks clean before this final PR. SQL not run. |
| 21 | [#150](https://github.com/rhyshume1997-alt/tolra-public/pull/150) | [Merge order](MERGE-ORDER.md): all 33 open PRs in #107–143, bases, dependencies, tests-only distinctions, risk flags and the click to merge each after review. |
| 22 | [#151](https://github.com/rhyshume1997-alt/tolra-public/pull/151) | Same guide lists 26 shared paths. All 528 head pairs checked; 134 conflict pairs, including inherited feature-base conflicts, documented with exact heads in [evidence](BUILDER2-PR-OVERLAPS.json). Order alone cannot resolve copied-code differences. |
| 23 | This PR | Combined handover, current CI, overlap evidence and ownership. Existing Codex ownership rows retained; every builder 2 job is recorded. |

The earlier [integration handover](BUILDER2-INTEGRATION-HANDOVER.md), [review](BUILDER2-PR-REVIEW.md) and [whole-suite matrix](BUILDER2-FULL-SUITE-RUN.md) are historical evidence. Their code findings are superseded by job 18 where listed. Their local full-suite timeouts/failures remain recorded: these were not rerun or described as a clean local full-suite pass. The remote web results are separate evidence.

## Still blocked before production

| Item | What Claude or Rhys needs to do |
|---|---|
| Atomic chase and costing saves | Review the SQL proposals in #144/#145, test permissions, company boundaries, stale writes, rollback and concurrent saves on a disposable database, then package/apply through Claude’s database process. No numbered migration was added or applied by builder 2. Client save routes need these RPCs. |
| Claude base branches | Open/review and join claude/chase-steps (138), claude/costing-in-app (143) and claude/e13-timesheet-days (142) before the dependent wiring/test PRs. Keep all release preflight markers and both costing golden suites. See merge guide. |
| Live tests and release gates | Run the browser flows against the test stack; check a real draft approval/send, payment confirmation and chosen-day timesheet delivery with the provider. No disposable DB/provider was available here. Web collection is not live browser execution. Integration/ci-gate success is not claimed and no Ready label was added. |
| Customer identity | Chase UI fails closed on ambiguous same-name customers. A durable customer ID in the backing data/routes is still needed for reliable per-customer pause. |
| Bank reconciliation | #146 provides the awaited callback and record_invoice_payment adapter, but the live parent page still needs the callback connected to its scoped data and refreshed after confirmation. A stable same-file request ID prevents exact retry duplication; it does not identify a transaction across different exports. Agree and persist that identity before calling it full reconciliation. |
| Incoming email authenticity | #147 rejects blank/mismatched senders and keeps human review. Provider authentication evidence is not in the adapter input; sender text alone does not prove authenticity. |
| JNR contacts | Fill the named support person and telephone numbers in the go-live checklist before the first shift on Thursday 12 November. |

## Where the details are

- [Chase fixes](BUILDER2-FIXES-18.md)
- [Costing fixes](BUILDER2-COSTING-FOLLOWUP.md)
- [Bank fixes and limits](BUILDER2-BANK-FOLLOWUP.md)
- [Sender and guide fixes](BUILDER2-SENDER-FOLLOWUP.md)
- [Exact latest web jobs](BUILDER2-CI-WEB.md)
- [Main/base conflict audit](BUILDER2-CONFLICT-CHECK.md)
- [Complete ownership](TOLRA-WORK-OWNERSHIP.md) and [job-by-job handover](CHATGPT-BUILD-HANDOVER-2.md)

DONE for this queue. Release and integration holds above remain explicit.
