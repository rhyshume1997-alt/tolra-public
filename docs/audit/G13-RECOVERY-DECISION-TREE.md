# G13: Recovery decisions after live use

Version 0.1 draft — 4 November 2026. Proposed owner ____; approved by ____; approval date ____; effective date ____.

**NOT EXECUTED.** This is a blank template, not a completed check. Leave unknown fields blank. Record facts and private evidence only after the work happens; do not infer a successful result. Keep completed copies in JNR’s approved private location, never this public repo.

Tolra supports JNR’s quality work. Software and documents cannot certify JNR; JNR is the company audited.

## Rhys completes before any recovery

Decision owner ____; operator/deputy ____; John/staff lead ____; approved technical runbook/version ____; known-good app/database state ____; backup identity/time ____; proof the backup restores ____.

**RPO (how much recent work may be lost): ____ . RTO (how long recovery may take): ____ .** Rhys agrees these with JNR. They are not promises or tested values until measured. Capture real work since the chosen backup before considering restore.

## Follow the first matching branch

1. **Wrong company, wrong figures or missing work?** Stop affected entry and automatic work through the authorised operator. Preserve the last good time, record IDs, pending saves/sends and incident number. John puts affected work on hold and uses controlled paper records for safe work. If writes cannot be stopped, STOP recovery and escalate to Rhys.
2. **Only the app failed, with no incompatible database change?** Operator checks that the reviewed previous app can safely use the current database. If proved, Rhys may approve that app rollback. If not proved, do not switch versions by guess; keep work stopped and investigate.
3. **A database rollback is needed?** Use only the approved reverse order for phases actually installed, with retention/compatibility checks at every step. Missing file, unknown state, refusal or failed check means STOP; preserve evidence and escalate. Do not retry around a guard or delete history.
4. **146 has been rolled back?** **Never re-apply 146 after rollback.** Restoring its installed state requires a verified matching backup and compatible app. Do not erase retained request history or reset markers to force reinstallation. If that backup/proof is missing, remain stopped and ask Rhys/operator for a reviewed recovery plan.
5. **Restore is the agreed route?** A backup restore can lose all live activity since its backup point, including jobs, hours, payments, approvals and sends. It cannot unsend an email. Rhys/John approve the exact loss window and target. Operator checks an isolated restore, fingerprints/totals/files and company isolation first. Wrong target, bad archive or unexplained differences mean STOP.
6. **Checks or reconciliation fail after rollback/restore?** Keep entry stopped. Preserve results, compare the actual app/database state and escalate. Reconcile paper, queued work and later live activity once, with a second checker; confirm uncertain sends before any resend.
7. **Everything required is evidenced?** John checks ordinary work; operator checks technical integrity/isolation; Rhys records permission to reopen. Resume controlled services gradually. No approval or missing evidence means stay on the agreed fallback.

## Decision/recovery record — copy at each branch

Requirement ID: G13-STEP-____; incident ____; failure point/action chosen ____; expected result ____; actual result ____ — **NOT EXECUTED**; evidence reference ____; tester ____; date ____; approval ____; actual data-loss window ____; measured recovery time ____; unresolved work/owner ____.

This is an office decision aid, not commands or permission to restore production. Technical source: [separate D6 rollback draft](https://github.com/rhyshume1997-alt/tolra-public/blob/0cfe4495a805d0c41acbdbe7a5f8b892006df68a/tests/D6-CUTOVER-ROLLBACK-RUNBOOK.md). Confirm the approved live runbook first.

Prepared by builder 5 under Rhys’s explicit document-only assignment. Source review and whitespace check only. No live check, production SQL, real data or message to John. Technical source snapshot: `68f89ca7b801a10587ff9b51d6c820462847b65a`; confirm the installed release before use.
