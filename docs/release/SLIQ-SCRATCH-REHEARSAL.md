# SliQ import: scratch rehearsal, browser only (Rhys, Chrome)

A SCRATCH Supabase project only: never the production project, never JNR's live company. Nothing here is run by an AI. Every
step is a click in Chrome: the Supabase dashboard (SQL editor, Backups) and Tolra's Admin > Data page on the scratch deployment.
Keep this sheet open; write each figure in the boxes as you go.

Before you start
- The untouched SliQ export files (from John) are on the USB stick and in the read-only Drive folder. Copy them; never edit them.
- The mapping JSON has `confirmed: true` and, if every date could be day-first or month-first, a `dateSample` John has signed off.
- The scratch project has every release up to 151 (release preflight shows 145..151 "applied").

1. Apply release 152 on scratch
   1. Supabase dashboard > the SCRATCH project > SQL editor > New query.
   2. Paste the whole of `supabase/release/152_sliq_import_route.release.sql` as plain text. Run.
   3. Expect "Success. No rows returned". An error that starts "152:" means a prerequisite is missing: stop.

2. Verify 152
   1. New query: paste `supabase/verify/sliq_import_route_152.sql`. Run.
   2. Expect 8 rows, every `ok` true. Any false: stop.
   3. New query: paste `supabase/verify/release_preflight.sql`. Run. Expect "post-144 marker 152 sliq_import_route | applied".

3. Back up the scratch database (the "before" backup)
   1. Dashboard > Database > Backups: start a backup (or note the latest daily backup time). Write the time here: [          ]

4. Preflight in Tolra (writes nothing)
   1. Sign in to the SCRATCH Tolra as an admin of the scratch company. Admin > Data > "SliQ go-live import".
   2. Choose the mapping JSON and the SliQ files together. Press "Check files".
   3. Every file check must pass. Copy the file names and SHA-256 lines shown under the card onto the hash sheet.
   4. Press "Preflight (writes nothing)". Write the counts and money: customers [   ] invoices [   ] payments [   ]
      credit notes [   ] invoiced [      ] paid [      ] owed [      ]. Any problem listed: stop and fix the source or mapping.

5. Import the batches
   1. Run label `rehearsal-1`. Press "Import N batches", then "Import".
   2. Wait for "Imported: ... records created". If a batch fails, nothing in it was written: read the message, press
      "Retry from batch N" once only if the cause is a dropped connection; otherwise stop.

6. Reconcile
   1. Press "Run the reconciliation". Every row must say PASS. The signing sheet below it must say "PASS - all differences are zero"
      and list every file with the same SHA-256 as the hash sheet.
   2. Also in the SQL editor: paste `supabase/verify/sliq_reconcile.sql`, replace the one placeholder with the scratch company's
      organisation id, Run. Left as the placeholder it stops with an error (that is intended).
   3. Copy the signing sheet text into the rehearsal record.

7. Restore the "before" backup
   1. Dashboard > Database > Backups: restore the backup from step 3 (scratch project only). Wait until the project is healthy.
   2. Admin > Data on the scratch Tolra: the import history is as it was before step 5.

8. Import again (same files, same label `rehearsal-1`)
   1. Repeat step 4 (check files, preflight): the counts must equal step 4 exactly.
   2. Repeat step 5. Then repeat step 6.

9. Compare
   - Counts, invoiced, paid, credited, owed: equal to the first run.
   - Reconciliation: every row PASS both times; the signing sheet's file hashes are identical both times.
   - Run step 5 a third time without restoring: every batch says "already imported" and 0 records created.
   - Release preflight still shows 152 applied; the INV counter after the second run is the same as after the first.

Stop rules: any false verify row, any FAIL in the reconciliation, any count that differs between runs, or any error you did not
expect. Write down what you saw; do not retry on a guess.
