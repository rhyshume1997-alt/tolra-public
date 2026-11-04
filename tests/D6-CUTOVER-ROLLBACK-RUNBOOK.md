# Cutover rollback: stop at every gate

For Rhys, Claude Code / technical operator and John. Target 12 November 2026. Rehearse by 6 November on a disposable restore. This is a reviewable runbook, not approval to change production. No SQL or restore was run by builder 4.

**146 cannot be re-applied after rollback. Restore from backup is the only way to recover the 146-installed state.** Its rollback retains AI request history and `key_source`; the forward release is one-time and cannot accept that leftover state. Never drop retained history, edit guards, reset markers or rerun the proposal to get around this.

## Decision sheet (complete privately before starting)

Rhys decision owner ____; operator ____; John / staff lead ____; backup operator/deputy ____; private incident channel ____.
Approved final full commit ____; current app deployment ____; previous known-good deployment ____; source project identity ____; restore target identity ____; backup archive/checksum/time ____; restore rehearsal evidence ____; acceptable recovery time and data loss agreed by Rhys/John ____.
Write down actual installed phases and their verification evidence. Candidate #247 is not automatically a release approval. CF/CA/CB drafts may add packages; freeze the integrated revision first. Missing Operations Pack or any blank recovery field means **STOP before cutover**.

## 1. Stop work and decide

Trigger: wrong company access, corrupt/missing financial/job data, failed release verify, failed smoke check, or essential work/sign-in failing without a safe fix inside the agreed window. Any person can report a stop; Rhys decides rollback with Code. Company-isolation concerns stop all writes immediately.

John tells staff to use F5 paper fallback. Operator pauses automatic send/schedule/worker entry points using the approved operational controls, blocks app writes and drains in-flight work. Record last confirmed write and messages with unknown outcomes. Confirm no second deployment/process is writing. Preserve logs, deployment IDs and a fresh evidence snapshot. **STOP** if writes cannot be fenced or a send's outcome cannot be accounted for; do not replay it.

## 2. Choose the right recovery

| State | Reviewed action | Stop condition |
| --- | --- | --- |
| App-only issue, schema unchanged and compatible | Restore the reviewed previous app deployment; keep writes fenced until smoke checks pass | Compatibility not proved, or old app can issue unsupported writes |
| Schema changed; a reviewed reverse rollback preserves required records | Code follows the approved reverse sequence on the proved target | Missing reverse file, dependency unknown, data-loss/retention mismatch or unproved reversal |
| 146 rolled back and Tolra-provided AI is needed again | Restore the verified pre-rollback backup containing the 146-installed state, with its compatible app | No verified matching backup; do not rerun 146 |
| Any irreversible or unproved state/data change | Restore the separately approved verified backup and matching app | Backup/restore proof missing, wrong target, unexplained comparison difference |

A Vercel rollback changes code, not the database or email deliveries. DNS rollback changes traffic, not saved data. Keep these decisions separate. A pre-cutover backup may not include 146: it recovers the pre-cutover system only. Record exactly which state the chosen backup contains; do not promise it restores the new features.

## 3. Review reverse order, then stop again

Only undo phases actually installed, in reverse dependency order. For #247's post-144 phases this is **146 before 145**. If reviewed chase phase 147 was separately included, its own reviewed dependency and rollback proof come first; do not assume it is included. Older 144/141/140/138 changes need their own exact packaged reverse paths and preservation proofs. Never infer a rollback from a filename or run a broad reset.

- **146:** `supabase/release/146_tolra_provided_ai.rollback.sql`. First turn off new provided-AI work and let outstanding requests settle through the normal reviewed process. A `key_source = 'tolra'` request still `reserved` makes rollback refuse. **STOP on refusal.** Do not delete, forge completion or zero usage. Code investigates and records the real outcome. A refusal must leave all data/functions unchanged.
- Successful 146 rollback disables AI features for companies using Tolra mode, restores own-key functions, removes provided-mode controls and retains request/usage history. Confirm all these postconditions and company isolation. Tell affected admins provided AI is unavailable. Do not silently substitute an own key.
- **145:** `supabase/release/145_company_setup.rollback.sql` removes setup ticks. Export needed evidence first. Confirm dependent 146 has been removed and the chosen app tolerates the absence. **STOP** on any missing retention or compatibility proof.
- For every earlier phase: Code names the exact file, checksum, dependencies, expected lost/preserved data and verify evidence in the decision sheet before executing it. If any entry is missing, choose a verified restore instead. Preserve Marpet/other tenants, logins, settings, numbering and audit history.

Files above are references for the separately authorised operator, not commands to execute in this job. Whole reviewed transactions only; fail on SQL errors; inspect every verification row for true/non-NULL and expected row count. Record actual exit and before/after comparisons at each stop point.

## 4. Restore route

Fence all consumers of the shared backend, including other tenants, before replacing shared data. Rhys and John approve the exact restore point and loss window. Preserve post-backup writes privately so they can be reconciled; an old backup loses later real work. Never copy that work back blindly.

Code uses the approved backup/restore process and protected-project guards (see CF database-day runbook and existing `scripts/backup-run.sh`, `scripts/restore-backup.sh`). Prove the selected backup on an isolated restore first: schema/roles/auth, every table fingerprint and money total, storage bytes/manifest, login and two-company isolation. Restore only to the explicitly approved recovery target. **STOP** on wrong identity, unreadable archive, checksum mismatch, missing component, unexplained difference or incompatible app. Do not repair the comparison by altering expected data.

## 5. Reopen only after independent checks

Code and a second checker record the actual app/schema state and checks: JNR and other-company login/access; known job/hours; invoice/payment totals; settings/numbering/audit; attachment access; email ledger and uncertain outcomes; intended AI status. Compare the backup/rollback expectations and resolve every unexplained difference. John checks normal workshop/office actions. Rhys explicitly approves reopening with the actual result and time. Until then remain on paper.

Reconcile F5 sheets and post-backup work once, with separate checker. Confirm messages before resend. Resume schedules/workers one at a time and watch for duplicates. Keep the incident open until missing work and customer messages are reconciled.

## Disposable rehearsal evidence (all NOT RUN here)

Record exact head/target/time/command/expected/actual/evidence/checker for: app-only reversal; 146 rollback refusal with a real outstanding reservation and unchanged state; successful 146 then 145 reversal with retained history; refusal to reinstall 146; restore of a backup containing 146 with matching app; restore of pre-cutover backup with explicit loss window; two-tenant fingerprints; paper/queued-write reconciliation and uncertain-email hold. Missing or failed proof means **NO GO**, even if the deadline arrives.

Prepared 4 November 2026 by builder 4. Build and test deadline: Friday 6 November; go-live target: Thursday 12 November. This document does not approve a release. Practical rehearsal and named sign-off remain required.
