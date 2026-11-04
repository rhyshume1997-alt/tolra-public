# G10 / G11 / G22 access, audit and retrieval review

Reviewed public delivery-note candidate `31f965e7f0cbb2d9caf336b0a2067411bec8fb45`. This is a pinned read-only checkout of #359; Claude Code’s branch and its owned test files were not edited. New tests have unique `b5-` names. No ISO packs started. No production URL/key, production SQL/wipe/import/counter action, main merge, deployment, live AI or automated email was used. John was not contacted.

Evidence directories keep original logs (including initial failures), UTC times, exit codes, environment/source commit and SHA-256 SQL-input manifests. Counter SQL additionally records each actual statement hash, exit/time/output and a nonce/container identity receipt. Scope limits below are part of each verdict; no skipped/blocked runtime check is a pass.

## Status

- G10: review and negative unit checks done; production role register, MFA enforcement and departed-session checks remain **NOT VERIFIED**.
- G11: audit/retention review done; actual database integrity/preservation and approved retention/deletion schedule remain **NOT VERIFIED**.
- G22: retrieval routes reviewed; timed historic-record retrieval from an actual isolated restore **NOT EXECUTED**.

The 14-file offline baseline passed 280 tests, including 101 admin MFA checks, ban-scope and audit contracts. The new independent access file passed nine checks: malformed/stale/far-future MFA is not recent, admin deactivation changes rights, new-admin enrolment still applies while the global switch is off, and enforcement requires an explicit setting. The combined adversarial run is **not green**: unrelated G27 assertions failed. Its original complete log is retained rather than presenting only passing lines.

## Access decisions still needed

[lib/mfa-policy.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/mfa-policy.ts) distinguishes enrolment from enforcement. `REQUIRE_ADMIN_MFA` and the per-company database rule must be checked together on the actual deployment; an enrolment tick cannot prove an aal2 gate. Tests of an explicit empty configuration do not establish JNR production settings. Obtain named approved user/role/inspector scope list, active/leaver review and real negative UI/API/old-session checks using approved synthetic accounts on the disposable restore. No actual user list or production credentials were queried.

## Audit and retention

[tests/db/audit-integrity.test.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/tests/db/audit-integrity.test.ts) and its SQL proof describe refusal/tamper/tenant properties; they were source-reviewed, not executed without the full identified Supabase stack. [lib/audit-contract.ts](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/audit-contract.ts) defines events; it does not prove every workflow is logged or supply a company retention decision.

The Compliance view limits its latest audit entries to 25. [app/(dashboard)/admin/activity/page.tsx](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/app/(dashboard)/admin/activity/page.tsx) offers filters/paging and per-record Activity gives a different scope. Do not use a latest-25 screenshot as a full history/export. There is no complete approved all-record retention/deletion/hold schedule in this evidence set; that is an operational gap, not permission to erase history. Wipe/restore must preserve the required audit/approval/signature/chase records under the reviewed archive plan.

## Historical retrieval

An invoice list or year-end ZIP is not the whole historic record. [lib/year-end-export.tsx](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/lib/year-end-export.tsx) excludes drafts and reports missing/unresolved PDFs in problems.txt; attachments/signature/history must be retrieved separately. A marked-signed status alone is not a retained signature artifact.

Need actual timed samples of historic invoice + amounts/payment history, signed note + signature files, older audit entry, and an excluded original SliQ record with cross-reference. Record exact final SHA, restore identity, sample/time limit, actual start/finish, evidence/hash, tester and approver privately. No historical archive/approved sample or source access was supplied; no synthetic sample is labelled JNR history. Full-stack registry-policy failure is preserved. Earlier blank templates #369/#370 are not completed evidence and were untouched.
