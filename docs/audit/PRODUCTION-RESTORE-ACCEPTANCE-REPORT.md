# Production restore — Acceptance report template

Version 0.1 draft | Prepared 4 November 2026 | Owner ____ | Approved issue/effective date ____.

**NOT EXECUTED.** Blank fields are not results or consent. Complete records privately after the work; no real data belongs in this public template. Tolra supports JNR’s quality work; JNR is audited, and these documents cannot certify it.

This is a report form, not permission or commands to restore production. Requirement ID: RESTORE-ACC-____; incident/change ID ____; exact compatible app SHA ____; database/schema/release state ____; authorised operator ____.

Backup ID/archive hash ____; backup date/time/timezone ____; protected source identity ____; verified restore target identity ____; restore start ____; restore finish ____; recovery duration ____; independent rehearsal evidence ____.

Accepted **RPO** (allowed recent data loss) ____; accepted **RTO** (allowed recovery time) ____; approved by/date ____; chosen recovery point ____; actual last recovered activity ____; measured lost-activity window ____; preserved later-live-work/reconciliation plan ____.

Restoring a backup can remove activity saved after its backup point; it cannot unsend emails. Agree the loss window and hold writes through the authorised operator. Never re-apply 146 after rollback; use the approved matching-backup/compatible-app route. Missing proof means hold, not reopening by guess.

## Copy this complete comparison record for every object/check

Requirement ID: RESTORE-OBJ-____; object/check and scope ____; reference backup manifest/fingerprint ____.

Expected result ____; actual result ____ — **NOT EXECUTED**; evidence reference ____; tester ____; date ____; approval ____.

Cover: schema/roles and installed releases; authentication/users/permissions; all relevant table counts and content fingerprints; invoice/payment/credit totals and balances; audit/approval history; stored drawing/attachment/signature files and their bytes/hashes; settings/counters; JNR/other-company isolation; normal office/workshop actions. Record every unexplained mismatch and its effect.

## Acceptance and reopening

Expected result: restored objects match the approved restore point, isolation and ordinary work are proved, actual loss/duration meet accepted limits, and later live/paper/queued activity is reconciled once with a second checker. Uncertain sends are resolved before resend.

Actual result ____ — **NOT EXECUTED**; evidence reference ____; tester ____; date ____; independent checker/signature/date ____; approval (accept/hold, approver/signature/date) ____; reopening decision/time ____; deviations and remaining owners ____.

Keep the report and full comparison evidence privately. An accepted RPO/RTO blank is not consent to data loss or an outage duration.

Builder 5: document-only template. No test, load, restore, production SQL, merge or message to John performed. Source/whitespace review only; operational results and approvals remain NOT EXECUTED/blank.
