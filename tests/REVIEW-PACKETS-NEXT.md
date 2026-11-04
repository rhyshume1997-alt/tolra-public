# Paste-ready review packets

Prepared 4 November 2026 UTC. Drafts only. No merge, Ready label, deployment or real-data SQL. These packets ask for independent review, not announce approval. SAFE for an artifact is not permission to release software. Review actual final heads; if a head changes, refresh evidence and packet. Full branch reruns and counts belong in the CI job's report and PR comments, not invented below.

The current stack is #247 -> #272 -> #273 -> #274 -> #275 -> #276 -> #277 -> #278 -> this packet PR. Existing owner branches and private repository remain unchanged. #247/#250/#258 and the actual mock production run still require their independent verdicts and real evidence. Source #258 itself was not modified; CE is the explicitly scoped refresh.

## CA: PR #272

Please review https://github.com/rhyshume1997-alt/tolra-public/pull/272 at full head `ef3e76e3e6c0fdbc012a4f59bd55dddd2f26920b` on `codex/ca-sliq-releases`.

Change: Packages required SliQ 140/141 without changing held implementation branches.

Tests and evidence: 5457 full units, 0 failed/skipped; 19 focused; typecheck/lint/checksums pass. Counts are scoped to the stated command/head. The CI job will publish separate complete-suite exact-head results.

NOT PROVED: No ordered real restore upgrade, SQL permissions, live JNR import or browser proof; Docker ENOSPC blocked the backend.

Assumption: this is a review-only staged integration based on #247 41c685c416305637d86b580324fff9e6cda037ff, not an approved final production SHA. Required JNR 140/141 cannot be omitted; no costing 143. Actual backup restore and release/wipe/import/browser evidence stays mandatory.

Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for this exact artifact and scope. List every remaining condition and required test. Do not treat unit mocks, old-head evidence or this question as release/SQL approval.

## CB: PR #273

Please review https://github.com/rhyshume1997-alt/tolra-public/pull/273 at full head `ff13614fcd8bd37d989faec74d387371ef7ac378` on `codex/cb-release-gate`.

Change: Refuses incomplete, failed, stale or unaccepted skipped release evidence.

Tests and evidence: 66 focused units, 0 failed/skipped; typecheck/changed lint pass. Counts are scoped to the stated command/head. The CI job will publish separate complete-suite exact-head results.

NOT PROVED: Synthetic artifacts prove logic only; artifact authenticity and actual mandatory runtime results need independent review. CI audit subsequently found that an all-passed JSON report can accompany a failed command/collection. The CI follow-up requires actual zero command exits and zero unhandled/collection errors, with seven failing-first regression cases. Include that correction before treating the gate as complete; the old #273 head alone does not contain it.

Assumption: this is a review-only staged integration based on #247 41c685c416305637d86b580324fff9e6cda037ff, not an approved final production SHA. Required JNR 140/141 cannot be omitted; no costing 143. Actual backup restore and release/wipe/import/browser evidence stays mandatory.

Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for this exact artifact and scope. List every remaining condition and required test. Do not treat unit mocks, old-head evidence or this question as release/SQL approval.

## CC: PR #274

Please review https://github.com/rhyshume1997-alt/tolra-public/pull/274 at full head `d88f06333556e5c2a80e183a5067c5f7117562fa` on `codex/cc-jnr-reconcile`.

Change: Offline stable-reference, exact-pence comparison and protected snapshots.

Tests and evidence: 35 focused units, 0 failed/skipped; typecheck/changed lint pass. Counts are scoped to the stated command/head. The CI job will publish separate complete-suite exact-head results.

NOT PROVED: Cannot establish snapshot completeness/origin, SQL permissions, live preservation, accountant WIP or next-number safety.

Assumption: this is a review-only staged integration based on #247 41c685c416305637d86b580324fff9e6cda037ff, not an approved final production SHA. Required JNR 140/141 cannot be omitted; no costing 143. Actual backup restore and release/wipe/import/browser evidence stays mandatory.

Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for this exact artifact and scope. List every remaining condition and required test. Do not treat unit mocks, old-head evidence or this question as release/SQL approval.

## CD: PR #275

Please review https://github.com/rhyshume1997-alt/tolra-public/pull/275 at full head `d73bb240a23b38a7080c0933e4f5b62ddd529f5f` on `codex/cd-sliq-no-write`.

Change: Fake-only in-memory import analysis and reconciliation; no file/database writes.

Tests and evidence: 5567 full units and 9 focused, 0 failed/skipped; typecheck/changed lint pass. Counts are scoped to the stated command/head. The CI job will publish separate complete-suite exact-head results.

NOT PROVED: Real mapping/import/wipe not run; 2 held records, INCOMPLETE fake reconciliation from 1 UNVERIFIED WIP valuation.

Assumption: this is a review-only staged integration based on #247 41c685c416305637d86b580324fff9e6cda037ff, not an approved final production SHA. Required JNR 140/141 cannot be omitted; no costing 143. Actual backup restore and release/wipe/import/browser evidence stays mandatory.

Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for this exact artifact and scope. List every remaining condition and required test. Do not treat unit mocks, old-head evidence or this question as release/SQL approval.

## CE: PR #276

Please review https://github.com/rhyshume1997-alt/tolra-public/pull/276 at full head `e71a80072148077a4c0f05184fe40d79688c01ee` on `codex/ce-validation-final`.

Change: Refreshes #258 source pack for the frozen CA to CD integration; old evidence retains its identity.

Tests and evidence: 463 mapped units, 0 failed/skipped/todo on clean 18aa60d51e1eec511517dede02c461c688bbad8a; 15 URS/6 IQ/15 OQ/9 PQ mapping passes; typecheck/full lint preparation passes. Counts are scoped to the stated command/head. The CI job will publish separate complete-suite exact-head results.

NOT PROVED: Software NOT VALIDATED. No actual DB/browser/provider/complete OQ/PQ or Rhys acceptance/VSR signature; final-head full rerun belongs to CI job.

Assumption: this is a review-only staged integration based on #247 41c685c416305637d86b580324fff9e6cda037ff, not an approved final production SHA. Required JNR 140/141 cannot be omitted; no costing 143. Actual backup restore and release/wipe/import/browser evidence stays mandatory.

Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for this exact artifact and scope. List every remaining condition and required test. Do not treat unit mocks, old-head evidence or this question as release/SQL approval.

## CF: PR #277

Please review https://github.com/rhyshume1997-alt/tolra-public/pull/277 at full head `87c4bbf52b895c1e618d32205e5023adb4d60cbc` on `codex/cf-db-day-runbook`.

Change: Explains backup/restore and verified 138, required 140/141, verified 144, 145, 146 with individual stop gates.

Tests and evidence: 18 referenced files and explicit order/146 stop rule checked; diff check pass; documentation only. Counts are scoped to the stated command/head. The CI job will publish separate complete-suite exact-head results.

NOT PROVED: No runbook commands executed, no SQL/release/real-data permission granted.

Assumption: this is a review-only staged integration based on #247 41c685c416305637d86b580324fff9e6cda037ff, not an approved final production SHA. Required JNR 140/141 cannot be omitted; no costing 143. Actual backup restore and release/wipe/import/browser evidence stays mandatory.

Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for this exact artifact and scope. List every remaining condition and required test. Do not treat unit mocks, old-head evidence or this question as release/SQL approval.

## CG: PR #278

Please review https://github.com/rhyshume1997-alt/tolra-public/pull/278 at full head `8d667ffc7d779d4487fcf19eb052b123ec98baa8` on `codex/cg-go-no-go-evidence`.

Change: Separates scoped actual PASS observations, setup FAIL and unrun final-head conditions.

Tests and evidence: 157 evidence rows; every mandatory ID, all 18 CW and available manual/protocol rows accounted; diff check pass. Counts are scoped to the stated command/head. The CI job will publish separate complete-suite exact-head results.

NOT PROVED: Authoritative Operations Pack missing, completeness BLOCKED; no same-final-head DB/browser/restore/wipe/import proof. NO GO remains.

Assumption: this is a review-only staged integration based on #247 41c685c416305637d86b580324fff9e6cda037ff, not an approved final production SHA. Required JNR 140/141 cannot be omitted; no costing 143. Actual backup restore and release/wipe/import/browser evidence stays mandatory.

Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for this exact artifact and scope. List every remaining condition and required test. Do not treat unit mocks, old-head evidence or this question as release/SQL approval.

## Coordination: PR #271

Please review https://github.com/rhyshume1997-alt/tolra-public/pull/271, documentation-only ownership/handover on codex/ca-ci-ownership. Packet snapshot head `c5fb8a6c827b632b4fa074926dd3d8e340345ba9`; ledger changes after each job intentionally advance this PR. Use the latest exact SHA and result in its final review comment before deciding. No held owner row is reassigned. Checks: diff check and review of our CA to CI rows; no runtime proof claimed. Code PRs contain no docs/ files.

NOT PROVED: code release safety, actual runtime evidence and reviewer approval. This ledger is not an authorisation. Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for the current full head in the final PR comment and its documentation scope.

## CH: this reporting PR

Assumption: a file cannot embed the SHA of the commit that first contains that same SHA. The immutable external companion packet in this PR's description/final review comment records this PR's actual full 40-character head, exact checks and missing proofs after push. Use that full-head companion, not this file's parent SHA. The packet checker below verifies all seven artifact packets and SHA lengths. Final full suite/typecheck/lint are the CI job; do not presume their results yet.

NOT PROVED: any database, backup/restore, wipe/import, browser or release acceptance. This is a documentation report, not approval. Please give **SAFE, SAFE WITH CONDITIONS or NOT SAFE** for the actual full head in the companion packet and this scope.

## CI: final check report to follow

The CI job will pin each remote codex/* head, run complete unit/typecheck/lint in isolated detached worktrees, retain exact failures/skips and causes, and publish the table on its own draft PR. It will not alter other owners' branches or run database tests against real data. No report here pre-empts results. Its final full head and exact counts will be in its PR description/final comment, avoiding a self-referential SHA claim.

NEXT UP: run CI job, publish final-head companion packets, then obtain real same-final-head backup/restore, mandatory database, combined #250 wipe/JNR import/reconciliation and post-release browser evidence. Supply and reconcile the authoritative Operations Pack. Rhys completes validation/sign-off only after independent review. Nothing here promises plain SAFE in advance.
