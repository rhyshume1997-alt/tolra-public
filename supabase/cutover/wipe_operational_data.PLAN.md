# Data wipe plan (quoteflow-prod) v2: PREPARED, NOT RUN ON PRODUCTION

Script: `supabase/cutover/wipe_operational_data.sql` (v2). One transaction; `dry_run` rolls back; refuses on any mismatch; prints a full reconciliation.
Inventory from the real production schema: `wipe-evidence/FK_AND_TRIGGER_INVENTORY.md` (+ the raw JSON). Storage: `wipe_storage_step.md` and `wipe_storage_list.sql`.

## Reviewer points (26 Nov) and where each is answered
| # | Point | Answer |
|---|---|---|
| 1 | Trigger disabling too broad | Exactly 8 allowlisted delete-time triggers are disabled (`v_trigger_allow`), each re-enabled and asserted back to its original state. 13 other delete-time guards are reviewed and left ON (`v_trigger_leave`). Any other delete-firing trigger = refusal. Cyclic tables are deleted in ONE statement (data-modifying CTEs), so no update trigger is touched. Inventory table: FK_AND_TRIGGER_INVENTORY.md. |
| 2 | Count EVERY table | The report prints before-count per wipe table per company (all 60 tables) and the after-count (must be 0, else the run refuses). |
| 3 | FK / cascade report from the real schema | FK_AND_TRIGGER_INVENTORY.md: 325 FKs into the wipe tables, auth.users and organizations with ON DELETE; the only CASCADE/SET NULL from outside the wipe list into a wipe table is `invoice_reminder_sends` (reviewed); the script refuses any other (guard). |
| 4 | Retained tables by hash | Every kept table, members, user profiles, DLN counter + hold, and the audit rows that existed before are compared before/after by row content hash (user ids masked). Rows that belong to a deleted user via CASCADE are the expected removals. Any difference = refusal. |
| 5 | Auth users | Each `{id, email}` must match auth.users exactly and belong to no company outside the wipe list; every reference is counted before (production: organization_members 4, user_profiles 3, site_network_members 1 cascade; jobs 1+1 SET NULL on wiped jobs; audit_log actor 6 stay) and after (none may remain except the audit log). |
| 6 | Live company audit rows | The 2 exact ids (below) must be the only rows; the hash chain is recomputed (verified on production read-only: both rows verify); the rows are in the backup export; the audit guard is disabled only for that one delete, re-enabled and asserted `O`. |
| 7 | Concurrency | `LOCK TABLE ... SHARE ROW EXCLUSIVE` on every wipe and retained table (alphabetical, 10 s lock timeout) before the counts are checked, and held to commit. Plus the maintenance window below. |
| 8 | Counters | Only QUO, J, INV, SO, PO, CRD, by explicit name, for the two named companies; the run refuses any other prefix; DLN and every other prefix are compared by hash. |
| 9 | Backup restores | See Backup. |
| 10 | Production-shaped rehearsal | See Rehearsal. |
| 11 | Storage | The exact 4 object paths from the wiped rows; no bucket or prefix deletes (the API `prefixes` argument holds full object paths). See wipe_storage_step.md. |

**Owner confirmation (point 8): CONFIRMED by Rhys, 26 Nov:** nothing from these records was ever sent to anyone; there was no customer or accountant. Resetting the six counters is therefore right. (Still needs the final yes with the counts.)

## Maintenance window (point 7)
1. Tell John and the office nobody uses Tolra (the offline mobile queue can write later, so ask the shop to stay out of the app and to be online when they return).
2. Optionally pause both companies so every request returns nothing: `update organizations set status='paused' where id in (<JNR>,<Marpet>)` (documented in supabase/README.md); resume afterwards with 'active'.
3. Run the dry run, read the report, then the real run (same params, `dry_run: false`) in the SAME session. The locks make a concurrent write wait (10 s timeout, then the run fails with nothing changed).
4. Storage step (wipe_storage_step.md), then verify, then resume the companies.

## Production parameters (exact; `dry_run` stays true until the owner says go)
```json
{"confirm":"WIPE OPERATIONAL DATA","dry_run":true,"counters":"reset","counter_prefixes":["QUO","J","INV","SO","PO","CRD"],"allow_audit_row_delete":true,
 "wipe_orgs":["264fe031-5381-4d70-a8fd-113c1713bc65","2a213c03-c440-450d-9217-e2bbfcaff6b5"],
 "delete_org":"75b27c0c-2e85-486e-b1f4-4e9b9c045ca7",
 "delete_org_audit_ids":["133a7654-e02a-430f-9bbf-a46fa2ab23de","a1c3f71b-2729-4fb5-99f9-79bfb7f5d5f1"],
 "delete_users":[{"id":"6d084998-baad-49d3-b3aa-cad95a26560d","email":"rhumecoaching@gmail.com"},{"id":"dc05fa61-1b18-4892-9abf-43ae651535d8","email":"test@test.com"},{"id":"ec0f5683-4b49-44c8-98b5-6aa3c6cf01b7","email":"test@testmail.com"}],
 "keep_admins":["cabd4289-e7dd-448e-9fed-a7cfab216cda","8703c781-adff-43f5-a258-dc1eb49c2d13"],
 "expected":{"264fe031-5381-4d70-a8fd-113c1713bc65":{"customers":9,"suppliers":9,"quotes":28,"jobs":27,"sales_orders":21,"purchase_orders":10,"delivery_notes":10,"invoices":20,"machines":1,"stock":6},
             "2a213c03-c440-450d-9217-e2bbfcaff6b5":{"customers":1,"quotes":3,"jobs":2,"sales_orders":1,"invoices":1}}}
```
Run: define the two functions (`pg_temp.wipe_digest`, `pg_temp.tolra_wipe`) from the .sql, then `SELECT pg_temp.tolra_wipe('<json>'::jsonb);`. Dry run first. To see the full report of a real run without keeping it: `DO $$ BEGIN PERFORM pg_temp.tolra_wipe('{... "dry_run": false ...}'); RAISE EXCEPTION 'REPORT'; END $$;`.
Note: production counts are re-read live; the 9/9/28/27/21/10/10/20/1/6 and 1/3/2/1/1 numbers are the approved ones.

## Backup (point 9)
- Export of both companies, the live company, the 3 test users and the storage list taken read-only from production (`quoteflow-prod-backup-v2-2026-11-26.json`, 4.7 MB, sha256 `99c700f3819c3a5c6d5f7d5369fb1cd81b2f577dd0bd5cf874dfcbe2b64fd2ff`, kept OUTSIDE the repo: it holds customer data). It now also contains every security_audit.audit_log row of the three companies (1,948 rows, including the live company's 2 rows with their hashes). Secrets tables are deliberately excluded.
- File vs production reconciliation: 46 of 58 tables identical by row count AND hash of the sorted row ids; the other 12 tables have no `id` column (composite keys: members, owed snapshots, archive state ...) and match by row count.
- Restore proof (method): on the production-shaped scratch copy, the same export logic was restored into temporary tables with `jsonb_populate_recordset` and compared with the source by row-content hash: 57 tables, 696 rows, 57/57 identical. The 4.7 MB production file itself could not be loaded through the SQL tool (size); if the owner wants a full restore test of the actual file, restore it with psql into a scratch schema and compare counts.

## Rehearsal (point 10), scratch project tolra-scratch-07nov, nothing on production
- **Production-shaped copy:** the scratch database holds an older copy of the real JNR Engineering and Marpet data (same ids, users, issued/paid/void invoices, immutable inspections and flow events, 26 quotes, 23 jobs, 15 invoices, 1,948-style audit trail). The corrected script was run for real on it inside a transaction that was rolled back (so the copy is intact), with the report returned: all 60 wipe tables per company reconcile to 0; the cycle among customers, jobs, quotes, rfqs and sales orders deleted in one statement; only the 8 allowlisted triggers disabled and restored; retained tables (57 compared) identical by hash; DLN counter row identical; audit rows identical; the 3 users deleted with their cascade rows accounted for. A second run added a synthetic live company with 2 audit rows: chain verified, rows deleted, audit guard re-enabled and asserted, company gone.
- **Negative tests (all refused):** DLN in the prefix list, wrong user email, audit id list short by one, a count mismatch, no confirm, audit rows without permission, a kept admin in the delete list, a user in another company; an unreviewed delete trigger; a cascading FK from a table outside the wipe list.
- **Earlier synthetic sets** (ZZ companies) ran clean as well (v1); v2 was re-proven on the production-shaped copy instead.
- **Not covered:** a real concurrent writer (the lock behaviour is by design, not stress-tested); the actual role the production run will use (assumed postgres/service role, enforced by the script refusing browser roles); the scratch copy is older than production (JNR 23 jobs against 27 now), so the numbers differ but the shape (issued invoices, immutable records, cycles) is the same.


## v2.1 local isolated-Postgres evidence (26 Nov, after the second review; no Supabase and no production SQL for these runs)
Script under test: `wipe_operational_data.sql` exactly as in the repo (run with `\i`, `pg_temp` functions), sha256 `ae08ae14b87441cb1457bf424efb4e28e127938f5e913c0aa639f848a634b69a`. Files: `wipe-evidence/local-isolated-postgres/`.
- **Environment:** local Postgres 16.15, empty cluster. Schema built from the scratch database's definitions: 131 tables (public + security_audit), 326 foreign keys, 482 triggers, 507 functions with their real bodies. Compared with the production inventory in this folder: 204 of 205 public FKs identical (on-delete rules identical; the missing one is the `issues` FK, added by hand), delete-time triggers identical (331 of 332 triggers; the missing one is the UPDATE-only `jobs_worksheet_custom_lock`). Prod-only items the scratch schema lacks (`issues` table, `jobs.worksheet_custom`, `job_values.id`) were added with types inferred from the export. Honest limit: the 65 exported tables are checked against the export; columns of tables the export does not hold are scratch's, not production's. Auth tables are stubs (users, mfa_factors, sessions).
- **Backup restore (point D):** the ACTUAL file `quoteflow-prod-backup-v2-2026-11-26.json` (4,687,308 bytes, sha256 `99c700f3819c3a5c6d5f7d5369fb1cd81b2f577dd0bd5cf874dfcbe2b64fd2ff`) restored into the local database: 63 tables, 2,828 rows, every table equal by row count (also against the file's own `row_counts`), no export key without a column, row-content hash equal per table (a load round-trip check; the export-vs-production check is the one in the Backup section above). The 3 test users and the 2 admins were loaded into the stub `auth.users`.
- **Dry run (A, G):** direct `dry_run:true` call raised `DRY_RUN_ROLLED_BACK` with the report in DETAIL; fingerprints of all 133 tables (every public and security_audit table plus auth.users) equal before and after; 0 DATA_WIPE rows; 3 organizations.
- **Real run in an explicit transaction (G):** `dry_run:false` returned the report; all 60 wipe tables are 0 for JNR and Marpet; 2 organizations left; 3 test users gone; QUO, J, INV, SO, PO, CRD = 0, DLN = 10 untouched; 0 triggers left disabled; 2 DATA_WIPE rows carrying `counters_previous` (JNR QUO 22, J 28, INV 13, SO 3, PO 9, CRD 4; Marpet QUO 3, J 4, INV 1); 1,946 existing audit rows verified by id, hash and row digest; ROLLBACK then restored all 133 fingerprints, 0 DATA_WIPE rows, 0 disabled triggers.
- **Locks (E):** `lock_test.out`: a wipe blocked by a competing writer aborts at 10.0 s with SQLSTATE 55P03 and changes nothing; the wipe's locks make a competing writer block, abort at its own timeout with 55P03, or proceed after the wipe ends.
- **Negative tests re-run on the patched script (9, all refused):** DLN in prefixes, unknown prefix, wrong user email, audit id list short by one, count mismatch, no confirm, audit rows without permission, kept admin in delete list, missing expected counts.
- **Not done before any real run (H):** refresh production counts, FK and trigger inventory and the 4-object Storage list at the maintenance window, and confirm nothing is writing to JNR or Marpet (read-only production SELECTs, left until Rhys says go). Not tested: the real production role, a long real concurrent writer beyond these cases, tampering with an audit row mid-run.

## v2.2 production schema compared (26 Nov, read-only catalog queries approved by Rhys 14:42)
See `wipe-evidence/prod-schema-compare/PROD_SCHEMA_COMPARE.md`: production run role is `postgres` (non-superuser, owner of all tables, DELETE on auth.users); 11 differences found, one touches deletion behaviour (`issues.user_id` FK to auth.users ON DELETE SET NULL; issues is KEPT, its one row names Rhys); one allowlisted trigger's function body differs (the trigger is disabled during the run). Re-rehearsed on the corrected schema as a non-superuser: dry run, real run in a transaction, 9 negative tests and the lock tests all pass. The script file itself is unchanged (sha256 ae08ae14b87441cb1457bf424efb4e28e127938f5e913c0aa639f848a634b69a).
