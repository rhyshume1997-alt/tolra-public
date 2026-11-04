# CD: fake-only data load rehearsal

This is NOT cutover approval. John's real SliQ data is required at cutover, and releases 140 and 141 are required for JNR. Nothing in this job imports or deletes a record.

Assumption: use the existing owner's analyser and reconciliation engine unchanged, through a new fixed-fixture wrapper. Run from repository root:

```
node scripts/cutover-dry-run/cli.mjs
```

The command accepts no arguments, target URL, output folder, write option or real customer files. It reads only committed synthetic fixtures, runs the existing import analyser in memory, compares the fake Tolra snapshot, checks input hashes again and prints JSON. It writes no files, opens no database connection and imports no database writer module. Redirecting stdout to a private log is an operator choice, not an import.

Local result on this branch: fake run completed; database writes 0; file writes 0; all source and target hashes unchanged. Import analyser: writable true, errors 0, held 2, needs review 0. Writable does not mean approved: the two held records remain excluded and no live collision check occurred. Reconciliation: INCOMPLETE, BLOCKER 0, WARN 0, UNVERIFIED 1, INFO 0. Outstanding: `wip_valuation`, accountant to confirm; job sale price is not cost. This limitation is deliberately retained. The report includes exact input hashes and the outstanding reason.

Next, the separately authorised operator must:

1. Identify and freeze the final integrated SHA. Obtain an actual backup and restore it onto a clearly disposable database, verify the dump hash and full restore comparison. Never test destructive SQL on real data.
2. Prove reviewed releases in order: verified 138, 140, 141, verified 144, 145, 146. Follow the reviewed preflight and per-release checks, not this fake command. The local fixture's frozen-baseline chronology is not independent proof of the real cutover sequence.
3. Confirm John's actual export headers, stable customer and document identities, pence, paid amounts, credit allocations, refund records, jobs, WIP and next numbers. Do not use names alone. Do not round imported invoice totals or treat absent exports as zero.
4. Rehearse the exact combined wipe kit on a disposable restore. Preserve and verify locked append-only chase approval evidence before invoice deletion. Compare every Marpet row, login, setting, number and audit event before and after. Disconnect Xero, Sage and QuickBooks for JNR only. Refuse missing evidence. #250 remains blocked pending that exact rehearsal.
5. Run the existing importer's reviewed dry run against the disposable target, resolve held and ambiguous rows explicitly, then obtain independent authorisation before any actual import. This wrapper has no import mode.
6. Export independently complete before/after snapshots, run the existing comprehensive reconciliation and `scripts/jnr-reconcile/cli.mjs` using reviewed normalized snapshots. Resolve WIP valuation with the accountant and independently check every next number exceeds imported numbers. Save private reports linked to the exact final commit.
7. Run mandatory database proofs and the post-release browser suite, then the fail-closed release gate. Missing, failed, old-head or unaccepted skipped evidence stops the process. A unit fixture match proves none of the real steps above.

No real JNR/Marpet file, key, email address or database URL belongs in public evidence. Ownership/handover: #271. No SQL has been applied by this job.
