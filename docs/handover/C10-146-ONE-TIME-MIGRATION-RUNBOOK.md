# C10 — release 146 is a one-time migration

Builder 6 / L12 / 4 November 2026. **Reviewed procedure text only; no SQL executed by this job.** The separately authorised Code/operator runs the exact complete reviewed file; Rhys decides live go/stop and an independent reviewer checks the evidence. This sheet grants no production SQL, deployment or rollback authority.

## Decision: Option A (Rhys, 4 November 2026)

**Option A: runbook text only.** No new guard is added and `supabase/release/146_tolra_provided_ai.release.sql` is **not edited**. The protection against a second run is this procedure, not the SQL.

## The exact file and its hash

- File: `supabase/release/146_tolra_provided_ai.release.sql` at `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8` (237 lines).
- sha256 (computed from the real bytes with `sha256sum`): `316862ac765251c6f602042dbd41fce46ce6a52b7eb73b5012575a326b84b9cd`.
- Re-compute it on the operator machine immediately before the run and stop if it differs. **Any edit to the file, even whitespace, changes the hash and invalidates the CI, mock and gate evidence gathered for it.**

## Command

```
psql -v ON_ERROR_STOP=1 -f supabase/release/146_tolra_provided_ai.release.sql
```

Do **not** add `--single-transaction`: the file already has its own `BEGIN` (line 3) and `COMMIT` (line 237), so a wrapping transaction would nest them, and psql then ignores the inner `BEGIN` with a warning and the file's own `COMMIT` ends the wrapper early.

Local check (PostgreSQL/psql 16.15, throwaway local cluster, small test files with the same `BEGIN; ... COMMIT;` shape, not the 146 file):

```
== B: --single-transaction -v ON_ERROR_STOP=1 -f (good file)
psql:.../good.sql:1: WARNING:  there is already a transaction in progress
BEGIN
CREATE TABLE
COMMIT
WARNING:  there is no transaction in progress
exit=0
```

```
== A: -v ON_ERROR_STOP=1 -f (failing file: BEGIN; CREATE TABLE t_ok; SELECT 1/0; CREATE TABLE t_after; COMMIT;)
BEGIN
CREATE TABLE
psql:.../t.sql:3: ERROR:  division by zero
exit=3
(count of t_ok/t_after afterwards: 0)
```

So with `-v ON_ERROR_STOP=1 -f`, psql stops at the first error with exit 3 and nothing from the file's transaction is kept. How the Supabase SQL editor runs a pasted script (one transaction or not, stop on error or not) is **UNPROVEN**: use psql as above, or, if any other client is used, capture its full transcript.

## Run once, verify immediately, stop on failure

1. Identify the actual target, full app/release commit and file hash. Preserve a verified recoverable backup/state, later-work plan, approved window and operator/reviewer contacts. Check the reviewed release inventory and the expected prerequisite state; the order is 138, 140, 141, 144, 145, then 146. Do not assume a fresh installation from missing table names.
2. Confirm 146 has not already been applied or rolled back. Read the expected functions/tables, request history and `key_source` state. A previous or uncertain attempt requires investigation before a write; do not edit guards, add `IF NOT EXISTS`, drop the kept column/history or reset real data to force the file through.
3. Only under separate authority, run the **whole file exactly once** with `psql -v ON_ERROR_STOP=1 -f <file>` (see **Command**; not `--single-transaction`). Never re-paste part of it; do not paste statements one at a time into an auto-committing editor or use a runner that removes transaction statements. Record full output, exit status, target, time, commit and hash privately.
4. On reported commit, immediately run the full reviewed `supabase/verify/tolra_provided_ai_146.sql` and final preflight. Require every expected row, correct names and TRUE values; empty/false/NULL/missing output is failure. Then perform the approved functional/role/cap/AI-off checks on their appropriate target. A successful migration command alone is not validation or opening authority.
5. On any error, lost connection or failed verification: **STOP**, keep affected AI/features/writers fenced as agreed, save the exact output and inspect the actual committed state read-only with the reviewer. Never schedule an automatic rollback after live use. Rhys/reviewer must separately choose a compatible recovery plan and account for later work and other companies.

## Transaction and the line 37 error

The pinned release has explicit [supabase/release/146_tolra_provided_ai.release.sql:3](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.release.sql#L3) and [supabase/release/146_tolra_provided_ai.release.sql:237](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.release.sql#L237). Its prerequisite guards run inside that transaction: [supabase/release/146_tolra_provided_ai.release.sql:6](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.release.sql#L6) and [supabase/release/146_tolra_provided_ai.release.sql:13](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.release.sql#L13). Creation/insertion/permissions of the control tables precede the column addition: [supabase/release/146_tolra_provided_ai.release.sql:17](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.release.sql#L17) and [supabase/release/146_tolra_provided_ai.release.sql:28](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.release.sql#L28).

**Yes: when executed as the complete file as written, 146 runs in one transaction.** [supabase/release/146_tolra_provided_ai.release.sql:37](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.release.sql#L37) is line 37 in this revision. `column "key_source" ... already exists` (PostgreSQL duplicate_column / 42701) means that column existed when this statement was attempted. It does not by itself prove a successful earlier complete install; possible causes include a previous install/rollback retaining history, a manually split/partial execution, or schema drift.

That error aborts the current transaction. Statements earlier in THIS transaction, including new control tables and their inserted singleton, cannot subsequently commit as part of it. A stop-on-error client exiting/closing rolls the open transaction back; an open connection stays in aborted-transaction state until rollback/termination. Sending COMMIT to an already aborted transaction rolls it back; it does not save the earlier statements. **Already committed state from before this attempt is not undone.** In particular, an existing `key_source` and old usage/request rows are not erased by this failed replay.

**The line 37 failure after a rollback is ACCIDENTAL, not a designed guard.** The file's only named guards are lines 4-8 (release 145 must be applied) and lines 10-15 (md5 of the two reserve functions). After a 146 rollback both pass: 145 is still there, and the rollback renames the original own-key reserve functions back. The rollback keeps `key_source` on purpose ([rollback line 4](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.rollback.sql#L4)), so a re-run only happens to stop at line 37. The release preflight marker for 146 needs the two Tolra tables, which the rollback drops, so after a rollback the preflight shows 146 **"not applied"**. That looks safe to run; it is not. **Never re-apply 146 after a rollback.**

This conclusion relies on the same real BEGIN-to-COMMIT transaction being used. If an editor/tool ran fragments with separate commits, earlier fragments might already have persisted. Obtain its exact transcript/connection/transaction settings; do not infer safety from the filename or line number. Line numbers differ in the canonical proposal or another revision; quote the exact SHA/file/statement.

## Failure and partial/uncertain-execution cases

| Observed case | What it means / next step |
| --- | --- |
| Guard refuses before new objects | Current transaction aborts with no committed change from this attempt; preserve output, verify actual pre-existing state and resolve the prerequisite mismatch. Do not bypass guard. |
| Error at line 37 after control-table statements | Same transaction is aborted: those earlier pending changes roll back. Existing column/history can remain from before the attempt. Stop and compare previous install/rollback evidence; never delete the column to retry. |
| Later statement fails before COMMIT | Same transaction cannot commit its earlier writes. Prove actual state after connection rollback/close; retain previous committed history and exact error. |
| Connection drops before COMMIT is sent | If the server connection truly ends with an open transaction it rolls back; a timeout alone does not prove that the server connection ended or COMMIT was never sent. Inspect actual state and logs; do not repeat blindly. |
| Connection drops after COMMIT may have reached server | Outcome is uncertain to the client; it may have committed. Verify catalog/functions/markers and expected results read-only with reviewer before deciding. Never retry automatically. |
| COMMIT succeeded but immediate verify fails | The committed migration is not undone by the verify failure. Fence use, capture mismatches, review forward correction/recovery; no automatic rollback. |
| A runner split the file / partial catalog exists | Atomic-file assumptions do not establish what persisted. Preserve logs and inventory/functions/data; independent reconciliation and separately reviewed recovery required. Do not patch around with ad-hoc drops. |
| Any live AI request/usage happened | Preserve the ledger/history and real provider outcome; settle genuine reservations as required. A rollback cannot erase real billing or manufacture a compatible older backup. Separate decision only. |
| 146 was already rolled back | **Never re-apply 146 on that database.** Reconstruct a reviewed compatible recovery plan; fresh rehearsal only on separately authorised disposable reset/restore. No real-data reset workaround. |

## Why rollback is not a routine retry

Rollback itself has [supabase/release/146_tolra_provided_ai.rollback.sql:5](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.rollback.sql#L5) and [supabase/release/146_tolra_provided_ai.rollback.sql:31](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.rollback.sql#L31). It explicitly refuses outstanding Tolra reservations: [supabase/release/146_tolra_provided_ai.rollback.sql:7](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.rollback.sql#L7). It disables selected company features to avoid silent own-key fallback: [supabase/release/146_tolra_provided_ai.rollback.sql:13](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.rollback.sql#L13); it drops control functions/tables and restores own-key functions: [supabase/release/146_tolra_provided_ai.rollback.sql:15](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.rollback.sql#L15) and [supabase/release/146_tolra_provided_ai.rollback.sql:25](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.rollback.sql#L25). Request/usage history and `key_source` deliberately stay: [supabase/release/146_tolra_provided_ai.rollback.sql:4](https://github.com/rhyshume1997-alt/tolra-public/blob/9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8/supabase/release/146_tolra_provided_ai.rollback.sql#L4).

That retained state is why replay is unsupported and can reach the existing-column error after the earlier guards pass. Rollback is **never automatic after live use**, never an idempotence strategy and never permission to delete history or falsify settlement. A separately authorised recovery may require a verified state-compatible restore plus reconciliation of later work/other-company impact; an older backup cannot invent missing history. No particular recovery option is approved here.

## Fixed rules (keep)

- Run the file **exactly once**. Never re-paste part of it.
- **No automatic rollback after live use**: the rollback drops `ai_helper_tolra_companies` and `ai_helper_tolra_control`, so companies' caps and the stored Tolra key are lost.
- Restoring a backup after live writes loses real activity written since that backup.
- How the Supabase SQL editor runs a pasted script is **UNPROVEN**; use `psql -v ON_ERROR_STOP=1 -f <file>`, or capture the full transcript of whatever client is used.
- The mock re-apply line only checks the 146 marker, so "nothing left behind" for the two Tolra tables after a refused re-apply is **UNPROVEN**.

## Record and handover

Actual target/commit/hash ____; previous state/attempt evidence ____; operator/time/authority ____; migration output/exit ____; immediate verify/preflight results ____; real-use/reservation state ____; STOP reason/reviewer ____; separate recovery decision/owner ____; Rhys signature/time ____.

Atomic claims/L12. Checked exact 237-line release and rollback, BEGIN/COMMIT placement, guard/add-column ordering and cited lines. Static PostgreSQL transaction explanation only, no claimed runtime/recovery proof. Claude (Option A edit): sha256 computed from the real 9c3f5c6 bytes; psql nesting/stop behaviour checked only with small test files on a throwaway local PostgreSQL 16 cluster, not with the 146 file. Original SQL unchanged; no new scope, main merge, production SQL, Ready label or deployment. Code/reviewer must identify actual state and prove the separately approved execution next.
