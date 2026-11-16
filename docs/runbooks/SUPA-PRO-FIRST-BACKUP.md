# SUPA-PRO — pay for the right Supabase plan and prove a backup works

Operator: Rhys. Witness: __________. Date/time (UK and UTC): __________.
This is an instruction sheet, not permission to buy a plan or change production. Rhys approves the cost and runs the steps. Supabase holds Tolra's database. Its database backup does not include the actual uploaded files in Storage. We need both.

**Stop rule:** if a result is missing, wrong or unclear, stop. Call the technical support person agreed with John (name/number: __________). Do not restore over live Tolra to test a backup.

| Tick | Rhys does this | What he should see | Stop if… |
| --- | --- | --- | --- |
| [ ] | Open Supabase from the saved, trusted address. Select the agreed organisation and live Tolra project. Compare its name and project reference with the private go-live record. | Both match; the old JNR system and a test project are not selected. | Either identifier is wrong or nobody can confirm it. |
| [ ] | Open Billing. Read the current Pro price, included backups, retention, billing period and any extra charges. Record the quoted cost privately; get the payer's approval. | A named payer approves the actual charge for this organisation/project. | Payment or the scope of the upgrade is unclear. Do not add paid extras by accident. |
| [ ] | Rhys uses the dashboard's current upgrade steps. Reopen Billing and the intended project afterwards. | Pro is active for the project which will hold live Tolra; no payment failure or pending change. | Only a receipt appears, the plan is pending, or another project was upgraded. |
| [ ] | Open the project's database backup page. Read the schedule and wait for the first completed backup. Use a manual backup button only if this plan actually offers one. | A completed backup with the correct project and a timestamp after the upgrade. Record its time and expiry privately. | No completed backup exists. Paying for Pro is not proof that one has finished. |
| [ ] | Check what that backup can restore and for how long. Record whether point-in-time recovery is separately bought and enabled. | Written coverage and retention from the actual dashboard/current terms. | Anyone assumes Pro automatically includes point-in-time recovery or uploaded file contents. |
| [ ] | Follow DUMP for the named database helpers. Separately run the already approved full encrypted backup/file recovery procedure (`backup-run.sh` / `restore-backup.sh`), with its own checked instructions and target guards. Keep both sets of evidence. | A dated backup, matching checksum, safe key custody and private logs. | The full-backup procedure/target is not agreed, a file is missing, or a secret appears in a public log. |
| [ ] | Rhys restores the exact database dump using DUMP and proves the full backup/file restore separately in the approved empty, separate target. | Exit success AND all required row/content, money, login and stored-file comparisons pass. | The target could be live, comparison is incomplete, or any comparison differs. |
| [ ] | Record the proof below and give John the result in plain words. Keep the backup expiry on the operating calendar. | Someone can find the backup, unlock it and repeat the proved restore. | Only the person who made it knows where the file/key is. |

First completed dashboard backup: __________. Encrypted full backup ID/hash: __________.
Restore target (private record): __________. Comparison evidence: __________.
Result: [ ] Complete, restored and checked [ ] Not proved — hold wipe/cutover.
Rhys: __________ Date/time: __________. Witness: __________.

## Handover

Documentation only. No upgrade, payment, backup or restore was performed by builder 4. A dashboard database backup and a complete file-inclusive restore are separate proofs. DUMP uses the exact helpers from the private backup branch; they do not back up file bytes. Do not record this sheet as an operational pass until Rhys supplies the evidence.

Related sheets named here may still be separate draft PRs. Use their reviewed versions from the agreed cutover pack; a draft title is not approval.
