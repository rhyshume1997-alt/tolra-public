# JNR QMS 027: Business continuity and disaster recovery

> **DRAFT. Not approved for use.** Tolra supports JNR Engineering's quality work. Software and documents cannot make a company certified. JNR is the company that gets audited. This draft is not evidence that JNR follows the process or meets ISO 9001:2015. Nothing here is certification. Not approved for use.

| Field | Entry |
| --- | --- |
| Company | JNR Engineering |
| Title | Business continuity and disaster recovery |
| Reference | JNR QMS 027 |
| Version and history | 0.1 DRAFT, 4 November 2026: first draft, adapted from the Codex ISO drafts listed below. No approved issue yet. |
| Owner | NEEDS CONFIRMATION (John is proposed as owner in the source drafts) |
| Prepared by | AI-assisted draft run, 4 November 2026. Named preparer: NEEDS CONFIRMATION |
| Reviewed by | NEEDS CONFIRMATION |
| Approved by | NEEDS CONFIRMATION |
| Effective date | NEEDS CONFIRMATION |
| Review date | NEEDS CONFIRMATION |
| Status | DRAFT |
| Signature | NEEDS CONFIRMATION |

**Purpose and scope.** Keep JNR working, and keep its records safe, if Tolra, the network, the power or the premises fail; and be able to restore the records. Tolra data and files, the shop's paper fallback, and JNR's staff and supplier contacts. Recovery time and data-loss limits: NEEDS CONFIRMATION.

**Source drafts adapted.** Codex #342 (deployment and recovery row) and #335 (clause 7.1.3). Tolra backup scripts are cited from the source; a successful restore was not proved here.

## Responsibilities

- John: approves the plan and the recovery limits. NEEDS CONFIRMATION.
- Operator (Rhys for Tolra technical facts): runs and checks backups and restores. NEEDS CONFIRMATION.
- Office lead: keeps the paper fallback pack and forms. NEEDS CONFIRMATION.

## Procedure (draft)

Short working steps. Only what Tolra does is described as fact. Everything else is a prompt for JNR.

1. Set the backup schedule and who checks it. NEEDS CONFIRMATION.
2. Prove that a backup can be restored in isolation, including the database records and the drawing and attachment files. Record the archive, checksum, date and comparison result. A backup script alone is not proof of recovery.
3. Keep a paper fallback: numbered controlled forms and delivery note pads, held in the office. NEEDS CONFIRMATION for the pad control.
4. If Tolra is unavailable, record work on the paper fallback forms and keep them. When Tolra returns, enter the work once with a second checker, and reconcile it (Codex #336 and #340).
5. Hold any unknown save or send until it is checked.
6. Review the plan after a restore test, a failure, or a change to Tolra.

## Tolra support and its limits

- Backup scripts exist: [scripts/backup-run.sh](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/scripts/backup-run.sh); [scripts/restore-backup.sh](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/scripts/restore-backup.sh); [scripts/backup-restore-drill.sh](https://github.com/rhyshume1997-alt/tolra-public/blob/31f965e7f0cbb2d9caf336b0a2067411bec8fb45/scripts/backup-restore-drill.sh).
- Status: BUILT in source. The schedule running live, a successful isolated restore and the installed version are NOT EVIDENCED for JNR.
- Limit: a script in the repository is not proof of recovery.

## Records

- Backup and restore test records with checksum and comparison results.
- Paper fallback control record.
- Recovery decision and downtime record.

## Related documents

- JNR QMS 007
- JNR QMS 022
- JNR QMS 026

## Sign-off (blank until JNR completes it)

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Owner | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Reviewer | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
| Approver | NEEDS CONFIRMATION | NEEDS CONFIRMATION | NEEDS CONFIRMATION |
