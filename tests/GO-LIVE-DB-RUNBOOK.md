# Database day: stop at each gate

This is a set of instructions for review, not permission to run SQL, merge, deploy, wipe or go live. This worker ran no SQL on real data. Target date is Thursday 12 November 2026, not an instruction to ignore a failed check.

Assumption: Code rehearses everything first on a labelled disposable restore. Rhys separately approves real work only after independent review of the exact final commit. John's SliQ data goes in at cutover: 140 and 141 are REQUIRED for JNR. Keep Marpet, logins, settings, numbering and audit history. Private repository is read only.

Think of each step as a door. Do not open the next door until the proof for this one is saved and checked. A missing proof, a false/NULL verify value, empty result, failed command, unexplained skip or wrong commit means STOP. Never keep clicking after an error.

## 1. Write the label on the box

Code records `git rev-parse HEAD`, `git status --short`, Node/npm versions, UTC date and exact target identity in private evidence. A 40-character commit identifies the code. A clean checkout is required. The current review stack started from #247 `41c685c416305637d86b580324fff9e6cda037ff`; it is not automatically the approved final commit. Freeze and independently approve the final integrated head.

STOP if the code is dirty, the SHA differs from the reviewed packet, the target cannot be proved disposable, or the authoritative Go Live Operations Pack is missing. Do not put database URLs, tokens, names, passwords or customer exports in Git, screenshots or public logs.

## 2. Make a spare copy and prove it opens

Code first identifies the source and restore target without exposing credentials. Store credentials through the operator's approved secret mechanism, never inline commands or public files. Freeze schema/role changes during backup. Existing reviewed backup tools are:

```
scripts/backup-run.sh /private/approved-backup-folder
```

This reads the source. The resulting encrypted archive must contain roles, schema, data, row counts, full table fingerprints, money totals, storage manifest/files and Auth/Storage versions. Save the archive SHA-256 and encrypted-file checksum. A dump alone or row counts alone is not a restore proof.

Only on a NEW empty disposable target, with `PROTECTED_REFS` covering all real project references and the operator's approved secret settings:

```
scripts/restore-backup.sh /private/path/to/approved-backup.tar.gz.gpg
```

That restore writes to the disposable target. Do not run it against JNR, Marpet or any real project. Save actual restore exits, complete table/money fingerprint comparisons, storage byte comparisons and version checks. Show restored login, RLS and company isolation work. `scripts/restore-verify.sh` is a separate local-only functional check; use its documented VERIFY settings, not hosted credentials. A separate local synthetic proof is `scripts/backup-restore-drill.sh`; concurrent-backup integrity is `scripts/backup-consistency-drill.sh`. Neither substitutes for comparing the actual approved backup.

STOP if the archive or any required component is missing, hashes differ, a file is unreadable, any table/money/storage comparison differs, or the restore target is not independently confirmed disposable. Do not repair a failed comparison by deleting its expected rows.

## 3. Check the recipe before changing the copy

On the frozen checkout, these commands read files only:

```
node scripts/check-migrations.mjs
node scripts/check-release-plan.mjs
node scripts/check-cutover-imports.mjs
```

Check all pinned checksums. `supabase/release/sliq-cutover.checksums.json` pins both import sources, releases, verify/rollback files, preflight and the import plan. The applied-migrations manifest and release plan cover the baseline and 145/146. Preserve existing applied SQL; do not regenerate a catalogue/hash merely to make a mismatch disappear.

Code runs `supabase/verify/release_preflight.sql` read only on the disposable restore and classifies every row: existing prerequisites must match; not-yet-applied 140/141/145/146 markers must be explicitly expected absent. This is a whole-candidate query, so pre-install output is not an all-green release result. Stop on any unexpected object, checksum, grant or marker. Do not rerun releases blindly if a relation already exists. Do not run a reset against real data.

## 4. Walk through these six numbered doors

The order for this candidate is **verified 138, 140, 141, verified 144, 145, 146**. Existing baseline migrations through 137 and required predecessor objects must already be verified. There is no implied permission to omit another existing prerequisite. E13 142 and costing 143 are outside this candidate; do not add them or costing atomic settings. Chase atomic settings #207 is a separate blocked release decision and cannot be silently included.

Only after separate authorisation on the disposable target, Code uses the complete reviewed release file as a single transaction. Do not paste its inner statements one by one. A useful operator pattern, with PGSERVICE privately set to the independently verified disposable target, is:

```
psql -X -v ON_ERROR_STOP=1 -f supabase/release/140_import_source_ref.release.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/verify/import_source_ref_140.sql
```

This is an example for the operator, not a command this document executes. SQL success alone does not prove the returned booleans: Code must check every expected verify row is present, true and non-NULL. Save each full result with commit, target identity, UTC time and file hash. Repeat that pattern individually for this table, stopping after each row:

| Door | Complete release file, only if not already verified installed | Read-only verification | What it proves and stop rule |
| --- | --- | --- | --- |
| 138 | `supabase/release/138_chase_steps.release.sql` | `supabase/verify/chase_steps_138.sql` | Chase tables/functions/grants match. If already installed, verify it instead of installing again. STOP on any unexpected difference. |
| 140, REQUIRED JNR | `supabase/release/140_import_source_ref.release.sql` | `supabase/verify/import_source_ref_140.sql` | Reviewed 138 prerequisite and source-reference columns/constraints/indexes, all 6 checks true. STOP before 141 if missing or false. |
| 141, REQUIRED JNR | `supabase/release/141_opening_wip.release.sql` | `supabase/verify/opening_wip_141.sql` | Reviewed 140 prerequisite, WIP table, grants, company links and policies match. STOP before 144 if any check differs. |
| 144 | `supabase/release/144_accounting_connections.release.sql` | `supabase/verify/accounting_connections_144.sql` | Xero/Sage/QuickBooks structure and permissions match. If already installed, verify it. STOP before 145 on any mismatch. |
| 145 | `supabase/release/145_company_setup.release.sql` | `supabase/verify/company_setup_145.sql` | Own admin setup progress only, private membership helper remains private. STOP before 146 if any expected check is not true. |
| 146 | `supabase/release/146_tolra_provided_ai.release.sql` | `supabase/verify/tolra_provided_ai_146.sql` | Provided AI controls, encrypted key rules, service-only caps, 1000p default and 100000p maximum, retained own-key function and request ledger match. STOP before any app use if any check differs. |

The local automated fixture first replays a frozen baseline through 144, then prepares import 140/141 and 145/146 proof files. That historical fixture order is NOT independent evidence of the actual cutover order above. Code must separately rehearse and record the real upgrade path on a disposable pre-upgrade restore. Do not report one as the other.

## 5. Prove people cannot cross the lines

Run the full `npm run test:db` on the verified disposable test backend. No file exclusions. Save exact pass/fail/skip counts and causes, commit and actual command. Test source-reference/WIP isolation between two fake companies, own-admin setup read/write and refusal for office, staff, support including elevated support, read-only, outsider and anon. Require second-install refusal for 145/146. Require AI owner MFA, company isolation, no missing-global-key fallback, over-cap refusal and two independent simultaneous near-cap reservations. Require provider token/isolation permissions, exact approved email text sent once, edit invalidation, uncertain delivery never resends and inbound replies never marking invoices paid.

The PR workflow normally waits for a Ready label, but this queue forbids that label. Do not add it. Code can instead use the existing separately authorised full manual workflow on the frozen own branch: `gh workflow run ci.yml --ref codex/ci-branch-checks -f skip_db=false`, leaving the specs input empty. This creates its disposable test stack and keeps the full database/upgrade/browser steps. Record the actual checked-out SHA and every result. A targeted specs run or skip_db shortcut cannot replace the full gate. This document has not started a workflow, and an Actions pass still does not prove the private combined wipe or real import.

Missing independent reviewer DB tests still on follow-up drafts must be integrated and executed, not replaced by a unit mock. Stop if #207 or another required function has not been packaged and independently proved. Extra proofs are mandatory where applicable. Do not rerun separate 145/146 CI install steps after test fixtures already installed them.

STOP on a failed or missing test, unaccepted skip, old-head log, missing two-session race or wrong target. This worker could not start the disposable backend because Docker image registration failed ENOSPC, so no local database PASS is claimed.

## 6. Rehearse wipe/import and the screens

Follow the separately reviewed exact combined #250 kit on a disposable copy only. Before deleting JNR invoices, archive all chase approval evidence into the locked append-only table, verify every copied field and row and refuse missing invoices/differences/incomplete archive. Verify archive permission refusals. Only then may separately approved JNR chase_sends/chase_pauses and invoice wipe steps proceed. KEEP chase_steps, costing_materials, costing_machines, costing_defaults, company_setup_progress, ai_helper_tolra_companies and ai_helper_tolra_control. Compare complete before/after Marpet, login, settings, numbering and audit snapshots. Check JNR-only disconnect for Xero, Sage and QuickBooks. Never touch the private repository.

Read `tests/GO-LIVE-DATA-LOAD.md`, run the no-write fake dry run first, then have the operator confirm John's real headers and the actual reviewed dry-run report privately. Real data loading requires its own approval. Reconcile exact pence, credits, balances, payments, customers, jobs, numbering and complete preservation; ask the accountant about WIP. Missing data never means zero.

Run the post-release browser suite against the same disposable candidate and manual G00 to G15. Save exact counts and artifacts; skipped specs are not a pass. Run `node scripts/release-gate/cli.mjs` as documented in tests/RELEASE-GATE.md with the actual final-head manifest and private artifact directory. It can say READY FOR INDEPENDENT REVIEW, never grant approval.

STOP if any backup/DB/browser/wipe/import/preservation result is missing, failed, unaccepted skipped or from an older commit. Do not merge or deploy as part of this queue. Rhys and the independent reviewer decide after seeing actual proof.

## 7. If anyone asks to undo a release

Stop app traffic first under a separately approved plan. A rollback is a separate reviewed decision. Never run one automatically after a test error. Review dependencies in reverse: 146, 145, 144, 141, 140, 138, only where that rollback is both applicable and safe. Existing rollback guards must refuse retained references, WIP rows or outstanding AI reservations. Do not settle a real request falsely or delete history to bypass a refusal.

**STOP AFTER ANY 146 ROLLBACK.** It intentionally keeps request history, usage and `key_source`; only after outstanding reservations have genuinely settled can the reviewed rollback succeed. The same database is not a fresh 146 install target. Do not rerun 146 on that rolled-back database. A disposable reset/new restore and a separately reviewed plan are needed before a fresh rehearsal. Never reset or drop retained history on real data.

145 rollback removes setup progress. 141 rollback refuses existing WIP. 140 rollback refuses retained source references. Refusals are safety results, not permission to remove the evidence. Save before/after snapshots and keep recovery decisions with Rhys.

Ownership and handover are in coordination PR #271. This runbook records no completed database or browser evidence.
