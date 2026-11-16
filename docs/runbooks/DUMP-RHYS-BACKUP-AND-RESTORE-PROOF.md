# DUMP — Rhys makes a database backup and checks it restores

Rhys runs this on **his own trusted computer**, in a terminal at the top of the **approved private repository checkout**. Do not run it in this public repository, a cloud chat terminal or Supabase's SQL editor. Rhys types the password himself, only into the hidden prompt. Nobody needs the password in chat.

Source: Rhys's approved private backup instructions and matching helper version, read together. Record their exact revision in the private operations record, not in this public sheet. If that version changes, technical support must review it before using this sheet. Keep its companion SQL files; do not copy two scripts out on their own. The commands below are the exact operator commands Rhys requested.

Operator: __________ Witness/help contact and number: __________ Date/time (UK and UTC): __________.
**Stop rule:** if any check fails or is unclear, stop. Preserve the private output, call that contact and hold the wipe/cutover. Do not change guards, suppress errors or try a restore against live Tolra.

| Tick | Rhys does this | What he should see | Stop if… |
| --- | --- | --- | --- |
| [ ] | Open the approved private checkout and confirm its reviewed version. Have Postgres client tools (`pg_dump`, `psql`, `pg_restore`, version 17), `sha256sum` and Docker Desktop ready. Use a supported shell for these Bash scripts. | All tools work; Docker is running; the two scripts and their companion SQL files exist. | Missing tools, wrong version/checkout, or a setup nobody has checked. Ask support to prepare the machine; do not improvise installation commands. |
| [ ] | Check no test overrides are set: `TOLRA_MOCK_MODE`, `RESTORE_USE_EXISTING`, `RESTORE_SKIP_EXTENSIONS`, `RESTORE_KEEP_DB` must be unset; restore must use the default local target `127.0.0.1:54399`. Check `TOLRA_BACKUP_DIR` is unset for the documented default. | Normal production-dump mode and a fresh throwaway Docker restore. The local port is free and Docker's image can be obtained. | An override, occupied port or existing target is unexplained. Do not aim the restore at an existing database. |
| [ ] | Agree a quiet window with John. Stop users and all background writers for the whole capture: imports, sends, scheduled jobs and integration pollers through their approved controls. Record the pause and who will resume each one. | No changes occur while counts, fingerprints, structure and dump are captured. | A writer cannot be stopped. These measurements are taken separately, not in one snapshot; a busy capture is not trustworthy. |
| [ ] | In Supabase, open the privately agreed live Tolra project → Connect → Session pooler. Compare project reference with the private record. Read host, port and user from there. | Correct live project and pooler details; no old JNR/test project. | Any identifier is uncertain. Never rely on a similar project name alone. |
| [ ] | From the private repo root run command 1 below. Enter host, port and user when asked; type the database password at its hidden prompt. | `Connected:` for the intended database, then stages `[1/3]`, `[2/3]`, `[3/3]`, `DONE. Dump:` and the exact next command. | `Missing tool`, `Refusing`, connection/dump/checksum error, or no DONE line. Do not treat a partial file as a backup. |
| [ ] | Check the printed output path. Keep the `.dump` plus `.dump.counts.tsv`, `.dump.fingerprints.tsv`, `.dump.structure.tsv` and `.dump.sha256` together with the same timestamp. | All five non-missing files in `~/tolra-backups/`, outside every git repo; folder private to the user (700), files private (600). | A sidecar is missing, the folder is in a repo or other people can read it. The dump is not encrypted by this helper. |
| [ ] | Run command 2 below, replacing `<stamp>` with the exact timestamp from DONE, or use the exact `Next:` command printed by the dump. | A fresh Postgres 17 Docker container on localhost only; restore and comparison output, then container cleanup. | Wrong path, non-local host, existing database or Docker failure. Do not use the existing-server test mode as a workaround. |
| [ ] | Read every comparison and immediately check the exit status with command 3. | Checksum PASS, all rowcount/fingerprint and structure checks PASS, final `RESULT: PASS …`, and exit status 0. | Any FAIL, missing check/sidecar, nonzero exit or unexplained warning/error. “Restore finished” alone is not a pass. |
| [ ] | Copy all five files to approved encrypted off-machine storage. Verify the copied dump against its `.sha256`; arrange approved key custody. | A readable matching protected copy, and a named person can find/unlock it. | The only copy is on this computer, the checksum differs or key recovery is unknown. Never upload dumps/sidecars to git or chat. |
| [ ] | Check the separate complete backup covers actual uploaded file bytes and the Supabase platform settings/roles not proved by this test. Record its restore evidence too. | Database dump proof and separate file/platform recovery proof are both available. | Someone says database PASS also proves drawings/photos, Auth settings or live Supabase behaviour. It does not. |
| [ ] | Report the result privately, then resume only the writers approved for this window. For WIPE-DAY, keep the agreed freeze until that runbook releases it. | John knows what passed, what remains unproved, backup time and recovery limits. No accidental early restart. | The next operation assumes a newer backup than the one actually taken or the freeze is still required. |

Command 1 — private repo root:

```sh
scripts/backup/dump-prod.sh
```

Command 2 — same terminal/folder, exact file from command 1:

```sh
scripts/backup/restore-and-compare.sh ~/tolra-backups/tolra-prod-<stamp>.dump
```

Command 3 — immediately after command 2, before running another command:

```sh
echo $?
```

`<stamp>` is a placeholder, not something to type literally. Do not paste a password or connection URI into either command.

## What good and bad look like

Good examples from the reviewed helper:

```text
PASS: dump checksum matches
PASS: rowcount …
PASS: fingerprint …
PASS: structure constraint: source …, restored …, none missing
RESULT: PASS (restore matches the dump on every table count and fingerprint)
```

Structure checks cover 14 categories, including permissions and definitions of functions, triggers, policies, constraints and indexes. Extra restored objects are reported but do not by themselves fail this helper; Supabase-only extensions may be explicitly excluded with a NOTE. Support must review such notes. This is not proof that a plain Postgres container reproduces Supabase's hosted services.

Bad examples: `FAIL: dump checksum differs`, missing sidecar, `FAIL: structure … MISSING`, `FAIL: rowcount …`, `FAIL: fingerprint …`, `RESULT: FAIL`, failure to start Docker, or an unexplained error. Keep the files/output private, mark **NOT PROVED**, and call support. Do not edit a sidecar to make it agree. For a busy-table mismatch, re-establish the freeze and take a fresh complete set; do not blindly retry against changing data.

Some role/already-existing-schema errors can occur in a plain Postgres restore. Do not decide they are harmless yourself: support must account for them and all required checks must still pass. The script tolerates `pg_restore` errors to make its comparisons; therefore the restore command finishing alone proves nothing.

## Record and limits

Backup filename/hash and private storage record: __________. Capture window: __________.
Restore result/exit status and private evidence: __________. File/platform restore evidence: __________.
Rhys signature: __________ Witness: __________.
Result: [ ] Database restore proved [ ] Complete recovery also proved [ ] Hold — not proved: __________.

The dump covers the selected `public`, `auth`, `security_audit` and `storage` schemas. Storage rows describe files; they are **not the uploaded bytes**. This helper does not prove Auth configuration, full Supabase roles or extension configuration. Recovery loses changes made after the backup. A PASS is evidence, not permission for production SQL, a wipe or cutover.

## Handover

Builder 4 read the exact private helpers and instructions; no production connection or script execution occurred. The source reports local comparison tests, with the Docker startup path previously untested there. Rhys must run and record the real Docker path. The older `backup-run.sh`/`restore-backup.sh` encrypted full-backup route is separate; it has not been silently substituted for these named helpers.

Related sheets named here may still be separate draft PRs. Use their reviewed versions from the agreed cutover pack; a draft title is not approval.
