# Database day: one step at a time

Review draft for #247 at `41c685c416305637d86b580324fff9e6cda037ff`. Commands below have NOT been run. They are for the separately authorised database operator. Rhys checks the results and approves the next step; he need not type SQL. Never paste the whole page at once. A green command alone is not a green proof. Keep output in a private evidence folder, never in this public repository.

Assumptions: the database starts at the reviewed baseline through 137; the operator has checked the complete preflight inventory. Do not replay old releases on a database already at 144/145/146. There are no release files for 140 to 143 on #247. Stop any import/timesheet/costing release relying on them. Chase atomic settings is a separate release decision, not included by the commands below. No wipe or customer-data import is authorised by this page.

1. **Match the code and the permission.** Use a clean, separate checkout of the approved candidate. Record the full SHA and named target in the private approval record. Obtain release-specific approval and SAFE review, with green required CI, before writes. Run:

   ```bash
   git rev-parse HEAD
   git status --porcelain
   npm run check:migrations
   ```

   STOP if SHA differs, the tree is dirty, any check fails, or approval/evidence is missing. Do not use the runbook branch's SHA as the candidate SHA. This document can be read separately.

2. **Prepare a private place and connections.** The operator loads credentials from the private secret store, with shell tracing off. Required variables: BACKUP_DB_URL, BACKUP_PASSPHRASE, BACKUP_SUPABASE_URL, BACKUP_SERVICE_KEY; RESTORE_DB_URL, RESTORE_SUPABASE_URL, RESTORE_SERVICE_KEY; PROTECTED_REFS containing every live/legacy project reference; RELEASE_DB_URL for the named release target. Never paste their values into chat or logs. For rehearsal, all sources and targets contain fake data only. Pause application writes, scheduled jobs, incoming mail and schema/role changes for the live backup/release window, with separate operator approval.

   ```bash
   set +x
   set -euo pipefail
   umask 077
   export EVIDENCE_DIR="$(mktemp -d /tmp/tolra-release-evidence.XXXXXX)"
   : "${BACKUP_DB_URL:?}" "${BACKUP_PASSPHRASE:?}" "${BACKUP_SUPABASE_URL:?}" "${BACKUP_SERVICE_KEY:?}"
   : "${RESTORE_DB_URL:?}" "${RESTORE_SUPABASE_URL:?}" "${RESTORE_SERVICE_KEY:?}" "${PROTECTED_REFS:?}" "${RELEASE_DB_URL:?}"
   test "$RESTORE_DB_URL" != "$BACKUP_DB_URL"
   test "$RESTORE_DB_URL" != "$RELEASE_DB_URL"
   ```

   STOP unless the operator independently confirms the restore target is a new, empty throwaway project, never a live project or another URL for it. String inequality alone is not identity proof. Record project references privately. Ensure no real mail or accounting provider can be called from the throwaway copy.

3. **Make the backup and dumps.** This one command makes consistent roles/schema/data dumps, counts, full table fingerprints, money totals and stored-file checksums, then encrypts the archive. It reads the source database.

   ```bash
   bash scripts/backup-run.sh "$EVIDENCE_DIR/backup" > "$EVIDENCE_DIR/backup.log" 2>&1
   find "$EVIDENCE_DIR/backup" -maxdepth 1 -name '*.tar.gz.gpg' -print
   ```

   STOP on error or missing archive/checksum. Choose the one archive produced by this run, set BACKUP_ARCHIVE to its private full path, and retain an off-site encrypted copy plus the separately held recovery passphrase. A file existing is not proof it can be restored.

4. **Check and restore that exact backup into the empty throwaway target.** The restore script compares every row count, table fingerprint, money total and stored-file checksum. Auth/Storage versions must match those recorded in the backup; use the existing restore drill setup, not a guessed service version.

   ```bash
   : "${BACKUP_ARCHIVE:?Set the exact archive path from step 3}"
   test -s "$BACKUP_ARCHIVE"
   test -s "$BACKUP_ARCHIVE.sha256"
   (cd "$(dirname "$BACKUP_ARCHIVE")" && sha256sum -c "$(basename "$BACKUP_ARCHIVE").sha256")
   REQUIRE_FINGERPRINTS=1 bash scripts/restore-backup.sh "$BACKUP_ARCHIVE" > "$EVIDENCE_DIR/restore.log" 2>&1
   ```

   STOP unless all comparisons and file checks pass. Missing fingerprints, omitted files or different money totals are failures. Keep the original archive unchanged. Do not restore over a live database. Restore includes writes to the throwaway database and needs its own authorisation.

5. **Prove the restored copy still behaves safely.** On the supported local throwaway stack only, set VERIFY_DB_URL, VERIFY_API_URL, VERIFY_ANON_KEY and VERIFY_SERVICE_KEY privately to that copy. The script changes a temporary login on the copy and checks RLS, sign-in, company isolation and session revocation.

   ```bash
   bash scripts/restore-verify.sh > "$EVIDENCE_DIR/restore-acceptance.log" 2>&1
   ```

   STOP on any refusal or failure. A hosted restore is not accepted by this local-only script: prepare the supported local rehearsal first; never remove its identity guard. No suitable local copy means NOT TESTED, not PASS.

6. **Read preflight before touching the named release target.** First do this and all following release steps on an authorised fake throwaway rehearsal. Repeat on live only after the full rehearsal and separate live approvals. Keep RELEASE_DB_URL bound to the approved target throughout.

   ```bash
   psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/verify/release_preflight.sql > "$EVIDENCE_DIR/preflight-before.txt"
   ```

   STOP if any existing baseline value differs from expected. Unapplied 138/144/145/146 must be explicitly accounted for as pending, not waved through. Have the operator compare every check/value/expected row; exit zero does not inspect these values for you. Confirm baseline through 137 and no partial release objects. Never weaken a guard to fit the target.

7. **Apply 138, then check 138.** Obtain the exact 138 approval sentence from the morning checklist before the apply command.

   ```bash
   psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/138_chase_steps.release.sql > "$EVIDENCE_DIR/apply-138.log" 2>&1
   psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/verify/chase_steps_138.sql > "$EVIDENCE_DIR/verify-138.txt"
   ```

   STOP on an error, empty verification output, NULL or any false verification row. Do not progress to 144 until the reviewer has checked every row. Keep sending disabled.

8. **Apply 144, then check 144.** Obtain its separate approval. No 140-143 command belongs between these steps because their files are absent here.

   ```bash
   psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/144_accounting_connections.release.sql > "$EVIDENCE_DIR/apply-144.log" 2>&1
   psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/verify/accounting_connections_144.sql > "$EVIDENCE_DIR/verify-144.txt"
   ```

   STOP unless every verification row is true and the operator confirms baseline catalogue/upgrade rehearsal proof. Do not connect real accounting providers as part of this step.

9. **Apply 145, then check 145.** Obtain its separate approval. This is a one-time post-144 phase, not a baseline replay.

   ```bash
   psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/145_company_setup.release.sql > "$EVIDENCE_DIR/apply-145.log" 2>&1
   psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/verify/company_setup_145.sql > "$EVIDENCE_DIR/verify-145.txt"
   ```

   STOP on any error, false/NULL row or missing own-admin/cross-company/support runtime proof. Do not run the original proposal as well.

10. **Apply 146, then check 146 and final preflight.** Obtain its separate approval. Keep AI disabled until the separate key/cap acceptance checks pass.

    ```bash
    psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/146_tolra_provided_ai.release.sql > "$EVIDENCE_DIR/apply-146.log" 2>&1
    psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/verify/tolra_provided_ai_146.sql > "$EVIDENCE_DIR/verify-146.txt"
    psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/verify/release_preflight.sql > "$EVIDENCE_DIR/preflight-after.txt"
    ```

    STOP unless all verification rows are true, both post-144 markers say applied, and all other preflight expectations/dispositions are accounted for. A missing global key must not fall back to a company's own key. Retain separate runtime proof of that and the two-session cap race.

11. **Check the evidence before opening the shop.** Require the full database suite, baseline upgrade/apply-twice, 145/146 second-application refusal with no changes, rollback rehearsal, company isolation, browser acceptance and money reconciliation on the exact candidate. The dedicated test environment owns its fixtures; do not point `npm run test:db` at live or run baseline tests after manually installing post-baseline phases. Review `tests/REVIEWER-TEST-MATRIX.md` and the manual checklist with Rhys. STOP if any required proof is missing. No automatic go-live from this document.

12. **Rollback is an emergency decision, not the next normal step.** Stop traffic and get a separate rollback review/approval for the named target and last successfully applied phase. Preserve the backup and BEFORE snapshots. Run only the relevant reverse step, check it, and stop before deciding the next. The commands are:

    ```bash
    psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/146_tolra_provided_ai.rollback.sql > "$EVIDENCE_DIR/rollback-146.log" 2>&1
    ```

    STOP on refusal: outstanding Tolra reservations must be settled through the reviewed process, never deleted. Check retained request history, key_source and usage against BEFORE evidence. Never reinstall 146 on this rolled-back database. Recreate only an authorised disposable rehearsal from the baseline; never reset live.

    ```bash
    psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/145_company_setup.rollback.sql > "$EVIDENCE_DIR/rollback-145.log" 2>&1
    ```

    STOP and compare business records. This removes setup ticks, so obtain approval for that loss and keep their export. It is not lossless.

    ```bash
    psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/144_accounting_connections.rollback.sql > "$EVIDENCE_DIR/rollback-144.log" 2>&1
    ```

    STOP if connections, secrets or OAuth states cause refusal. Never delete them to force rollback. Compare retained records and old behaviour before proceeding.

    ```bash
    psql "$RELEASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/release/138_chase_steps.rollback.sql > "$EVIDENCE_DIR/rollback-138.log" 2>&1
    ```

    STOP and reconcile invoices/payments and both companies. This removes chase steps, pauses, send history and claim fields: obtain explicit approval for that loss and preserve exports first. Forward verification files will correctly fail after rollback; compare the expected restored baseline and retained data instead. Keep service closed until recovery has its own SAFE verdict. Never automatically restore a backup over live.
