# WIPE-DAY — Rhys's Saturday 7 November 2026 sheet

**HOLD / NOT SAFE until the gates below are signed.** This is a guide, not approval to delete data. Rhys alone runs the approved kit on his own trusted computer. Builder 4 has not run any SQL. Saturday's date does not overrule a failed or missing check.

John decides whether the business may proceed. Rhys owns the command and target checks. The independent technical reviewer must accept the exact combined #250 kit. Names/phones: John __________; Rhys __________; reviewer/support __________. Agreed start, latest start and decision time (UK and UTC): __________.

## Before touching the wipe

| Tick | Step | What Rhys should see | Stop if… |
| --- | --- | --- | --- |
| [ ] | Confirm John's permission for this specific JNR test-data wipe and the private project/JNR/Marpet identifiers independently. | Signed permission, correct live Tolra project, JNR is the only deletion target; Marpet is protected. | Permission/identity is missing or ambiguous. Never use a name alone as proof. |
| [ ] | Get the latest verdict/evidence for #250 and the actual four-file combined kit. Pin the driver, table list, check/export files, archive schema and all additions by SHA-256 in a private manifest. | Reviewer says SAFE for those exact bytes; all 18 checks below have real evidence. | Verdict remains NOT SAFE, anything is NOT RUN, or bytes differ. An old v1/v2 kit, proposed SQL snippets or a look-alike test is not the combined kit. |
| [ ] | Complete DUMP and the separate file/platform backup proof. Record backup time, hashes, off-machine copy, restore result and approved recovery procedure. | A real recoverable backup from the agreed freeze point, not just an export/count list. | No proved restore, missing uploaded files, or recovery would overwrite newer Marpet work without an agreed plan. |
| [ ] | Freeze all writers for both companies through the approved controls. Pause mail, imports, schedules and pollers. Disconnect JNR's Xero, Sage and QuickBooks through their normal screens. | Named owners confirm the freeze; each of the three JNR connections is explicitly disconnected. Marpet connection settings are kept. | Any connection is connected/unknown/null, a writer is active, or someone proposes deleting tokens to pass a guard. |
| [ ] | On Rhys's computer prepare psql (12+, preferably the reviewed current client). Use a private working folder outside every git repository, containing copies of the four approved files listed below; verify their hashes again. Copy the private Session pooler URI without its password into `WIPE_DB_URI` using the approved private setup. | Correct project/role, secret-free URI, password entered only into psql's private prompt; the four files match the manifest. | Wrong project, missing companion, unreviewed shell setup or password in command/history. Do not use Supabase SQL editor. |
| [ ] | Record final go/no-go with John and reviewer after checking the agreed rollback/cut-off sheet. | Everyone knows who can stop and what backup recovery would mean. | A person is unavailable or the agreed time has passed. |

Keep together: `28-wipe-jnr.sql`, `28-wipe-jnr-tables.sql`, `28-wipe-jnr-check.sql`, `28-wipe-jnr-export.sql`. The reviewed archive schema is a prerequisite prepared through its separately approved release process, not a fifth ad-hoc live SQL step here. Do not build a new kit or paste proposal fragments into production on wipe day.

## The 18 checks — all required before live use

A row is one saved record. A content fingerprint/hash checks whether its contents changed, even when the number of records stayed the same. Foreign keys are links between records; RLS is the database rule limiting who may see them. The archive is the protected copy of the original evidence.

These CW-01–CW-18 names are #250's wipe-proof identifiers. Each needs an independent review of the actual combined driver on a **throwaway** two-company restore. Attack/failure/permission tests belong there, never on live. The reviewer must attach private evidence for every row; a tick without proof is a stop.

| ID / tick | Check | Expected result | Stop rule |
| --- | --- | --- | --- |
| CW-01 [ ] | Match driver/list/companions/schema/additions hashes and independent project/company IDs; test wrong targets and unknown tables. | Every wrong target or unclassified table is refused before writes. | Missing pin or any wrong-target case proceeds. |
| CW-02 [ ] | Compare the complete KEEP/WIPE inventory, including the seven protected settings/control tables below. | Only approved JNR operational rows are in scope; no duplicate/missing/global-key export or other-company deletion. | Scope differs or an item has no classification. |
| CW-03 [ ] | Capture full before-state rows/IDs and content checks for both companies and all protected tables. | A privately stored baseline can detect changed content, not just changed counts. | Only row totals exist or any protected table is omitted. |
| CW-04 [ ] | Compare all Marpet rows, links, integrations and stored-file identities. | Marpet is unchanged and never enters JNR archive/delete scope. | Any Marpet difference or cross-company selection. |
| CW-05 [ ] | Compare logins, profiles, memberships, roles, sessions and security records. | Every existing account/security row is unchanged. | An account, permission or session changes; keep credential evidence private. |
| CW-06 [ ] | Compare both companies' settings, hours/breaks, branding, templates, schedules, connections, mappings and seven KEEP tables. | Exact unchanged protected content; no private key exported. | Any change or key disclosure. |
| CW-07 [ ] | Compare all numbering prefixes/counters and old audit rows/chain. | Counters and old audit remain exact; only the explicitly approved new audit appends are accounted separately. | Number reset, old audit edit or unexplained append. |
| CW-08 [ ] | Prove writers are stopped and the real locks protect source, archive and kept rows during one outer transaction; include a competing-writer test. | No interleaving changes, hidden error or intermediate commit. | Locks/freeze/atomic refusal are unproved. |
| CW-09 [ ] | Test JNR Xero, Sage and QuickBooks separately, including unknown states. | Connected/unknown/null refuses; only explicitly disconnected passes; Marpet settings and Microsoft connection settings stay kept while pollers pause. | Any provider is missed or tokens are deleted to force a pass. |
| CW-10 [ ] | Inspect real archive ownership, unique company-scoped keys, access rules and foreign keys. | Owner-only archive; no link into wiped invoice/send/email rows; company link only to kept organisation; immutable guard always on. | Missing access protection, unsafe link or guard disabled. |
| CW-11 [ ] | Test archive read/insert/update/delete/truncate as anon, authenticated and service_role; test trusted owner append. | Those application roles are refused; owner can append a valid new row but cannot alter/delete/truncate existing evidence. | Any prohibited operation works. |
| CW-12 [ ] | On scratch only, try missing invoice/message, cross-company links and source/archive/list faults. | Entire operation refuses with no surviving partial archive, deletion or audit change. | Any partial result survives or a fault is ignored. |
| CW-13 [ ] | Match every JNR chase approval/send and invoice snapshot to its linked messages, full text, recipient, actor, times, state, IDs and totals. | One complete matching archive copy per required source record; counts/content checks agree. | Missing join, missing message or any altered/omitted field. |
| CW-14 [ ] | On scratch only, alter text/recipient/actor/time/snapshot/hash, create archive conflict and omit a copy. | Every case refuses atomically, without overwriting evidence. | It continues, overwrites or partly saves. |
| CW-15 [ ] | In the real driver, capture archive/new-audit protection after copying; prove the deletion order with real foreign keys. | JNR chase_sends, then chase_pauses, then approved parents; no disabled foreign key, nulled link or cascade into KEEP. | Only a temporary twin harness passes or kept evidence can be deleted. |
| CW-16 [ ] | Run the real combined dry path including archive, audit and every deletion. | Whole operation rolls back and both-company baseline is exactly restored. | Any surviving change or skipped path. |
| CW-17 [ ] | Apply the real combined driver to scratch with protected comparisons before commit and an independent comparison afterwards. | Only approved JNR operational rows vanish; every KEEP/Marpet/login/setting/counter/old audit is unchanged. Differences refuse before commit. | Comparisons run only afterwards or any protected difference survives. |
| CW-18 [ ] | After actual scratch invoice deletion, read complete archived evidence as owner, repeat application-role denial tests and independently review all 18 records. | Evidence remains complete and owner-only; reviewer signs the exact kit. | Any missing proof, accessible archive or unsigned verdict. This is not itself live approval. |

Private evidence index and signed verdict: __________. Exact manifest: __________.
Reviewer signature/date: __________. John permission/date: __________. Rhys go/no-go/time: __________.

## What stays and what goes

**Stays:** every Marpet row/file/relationship; AI request/usage history and the archive; existing logins, roles and security records; both companies' settings, connections/mappings, hours/breaks, branding and templates; numbering prefixes/counters; existing audit history; preserved chase approval/message evidence. Explicit KEEP tables include `chase_steps`, `costing_materials`, `costing_machines`, `costing_defaults`, `company_setup_progress`, `ai_helper_tolra_companies` and global `ai_helper_tolra_control`. Do not export global key material.

**Goes:** only JNR test operational rows named WIPE in the exact signed combined table list, including its scoped `chase_sends` and `chase_pauses` additions after evidence is safely archived. This includes the approved JNR test business records classified there; it is not “everything belonging to JNR”. Rhys and reviewer must read and sign the full list, not infer it from this summary. Do not use old kit table counts as the current inventory.

Stored-file deletion is **not authorised by this sheet**. File records and actual bytes are different. Never delete whole buckets, JNR branding, Marpet files or arbitrary folders as a cleanup shortcut. Any later file action needs its own exact reviewed scope.

## Rhys's commands — only after every gate passes

Run from the approved four-file folder, using the private variables set and checked with support: `WIPE_DB_URI` (no password), `WIPE_JNR_ID`, `WIPE_JNR_NAME` (exact approved values). Do not paste placeholders as identifiers. `$?` below must be checked immediately after each command. Logs/exports stay in a private non-git folder, not a shared terminal transcript. Ensure the kit working folder/output location is approved for private evidence before running.

| Tick | Step and command | What he should see | Stop if… |
| --- | --- | --- | --- |
| [ ] | Before check: `psql "$WIPE_DB_URI" -X -v ON_ERROR_STOP=1 -f 28-wipe-jnr-check.sql > b11-check-before.txt 2>&1` | Exit 0; JNR ID/exact name and Marpet baseline match the private independently checked record. | Any error, mismatch or missing table. |
| [ ] | Export: `psql "$WIPE_DB_URI" -X -v ON_ERROR_STOP=1 -v jnr_org="$WIPE_JNR_ID" -v export_file='b11-jnr-export-20261107.csv' -f 28-wipe-jnr-export.sql > b11-export.txt 2>&1` | Exit 0, complete private export/file list; make/check a SHA-256 and protected copies. This export is not a restore backup. | Empty/unexplained export or hash/copy failure. |
| [ ] | Dry run: `psql "$WIPE_DB_URI" -X -v ON_ERROR_STOP=1 -v jnr_org="$WIPE_JNR_ID" -v jnr_name="$WIPE_JNR_NAME" -v confirm='WIPE JNR PRODUCTION 2026-11-07' -v mode=dry -f 28-wipe-jnr.sql > b11-dry.txt 2>&1` | Exit 0, all expected `ok = t`; `ALL CHECKS PASS: DRY RUN, ROLLBACK, nothing saved`; independent unchanged comparison. | Any REFUSED/error/false/missing check or change. This date token is valid only on that UTC date. |
| [ ] | Reconfirm go/no-go and freeze with John and reviewer. Rhys alone then runs the same dry command with **only** `mode=commit` and log name `b11-commit.txt` changed. | Exact same checked target, kit, backup and approved window. Commit output has every expected pass, `ALL CHECKS PASS: COMMIT` and `COMMITTED.`, exit 0. | Anything changed since dry, time expired or approval is missing. Never type commit first. |
| [ ] | Run the before-check command again with log `b11-check-after.txt`; reviewer runs the approved independent protected-content comparison and UI checks. | Only signed WIPE rows removed; all protected content/Marpet/archive intact; correct logins and previews still work. | A difference, missing record or unclear result. Do not resume writers or repeat commit. |
| [ ] | John and reviewer accept the after-results; named owners resume only the approved paused work and watch for errors. | Private evidence is complete; each writer has an explicit resume decision. | A failed comparison, missing owner or uncertain state remains. |

Immediately after each command use `echo $?`; expect 0 as well as the required output. On this date the UK is on GMT, but still check actual UTC date. If delayed past 7 November, **stop and reschedule/reapprove the window and date token**; do not reuse this token or bypass its refusal.

**Connection lost, timeout or unclear commit?** Stop. Do not rerun commit. Rhys and support must establish whether the transaction committed using independent checks. Preserve output. An explicit pre-commit refusal should leave no change, but prove it. If a protected difference is found after commit, keep writers stopped and use the approved recovery decision with John. A full database restore also affects Marpet and loses later work; do not start one casually. Re-running commit is a scratch idempotence test, not a live recovery step.

Completion: [ ] Held, not run [ ] Refused safely [ ] Committed and all after-checks accepted.
Private logs/manifest/backup/compare record: __________.
Rhys signature/time: __________ John: __________ Reviewer: __________.

## Handover

Documentation only. Starting evidence for #250 was NOT SAFE with real combined-kit runtime checks NOT RUN; this sheet does not change that verdict. The private baseline runbook and rehearsal kit were read, not executed or copied as an approved live kit. No live SQL, deletion, archive installation, file deletion, connection or restore was performed. Preserve the 18 evidence gates even if later output looks green.

Related sheets named here may still be separate draft PRs. Use their reviewed versions from the agreed cutover pack; a draft title is not approval.
