# JNR transfer day: SliQ data load

Assumption: Claude uses the reviewed `claude/sliq-import` importer, checked at 3593615, and a separately approved release containing its database support. #247 does not include release files 140 to 143. This plan gives no permission to install SQL or write live data. All automated checks for this document use repository fake fixtures only.

1. **Pick the copy.** Name the exact source commit, JNR company ID, target database and person doing the work. Keep Marpet separate. Do the first run on a disposable copy. Never guess which company is selected.
2. **Save the starting point.** Before transfer, the authorised operator takes and checks a recoverable database and file backup. Save counts and balances for JNR and Marpet. Keep SliQ available as the fallback. Record the stop/restore decision maker and cutoff time.
3. **Freeze the files.** At the agreed transfer time, stop new entries in SliQ and Tolra. Export customers, suppliers, stock, quotes, sales orders, open jobs, opening work in progress, purchase orders, invoices and payments as required by the reviewed mapping. Keep original files unchanged, outside the public repository. Record filenames, checksums, export time and the SliQ totals John signs. Payments are not inferred from customer emails.
4. **Check the headings.** Use the actual SliQ mapping and date format. Do not rename headings until they happen to pass. Missing or unknown required headings, duplicate account IDs or invoice references, invalid dates, fractional pennies, unmatched customers and unexplained paid amounts stop the write. Same-name customers must be resolved by their source account IDs.
5. **Try it without writing to the database.** This exact example uses fake repository files only:

   `node scripts/sliq-import/cli.mjs tests/fixtures/sliq/basic --mapping synthetic --out /tmp/tolra-fake-report`

   There is no `--write`, `--install-importer` or database URL. It creates local report files; it changes no database. The fake fixture may deliberately report held rows. That is a correct refusal, not permission to ignore them. The real-data dry run uses the frozen private folder and reviewed SliQ mapping, with its report kept private. A read-only target collision check is separate and requires the named company and authorised target.
6. **Read the report.** Keep `report.json`, `report.md` and `ambiguity.csv`, plus `jobs-verification.csv` and `wip-verification.csv` when produced. Match each source checksum and input option to the frozen files. List every held, excluded or renamed document. Each exception needs a named human decision; do not fabricate a successful rehearsal flag or edit the report to enable writing.
7. **Check customers first.** Source account IDs, names and addresses must match. A duplicate name alone must not join two customers. Then check supplier references and the other supporting records required by the importer.
8. **Check open work.** Count every open job and its linked customer, quote and sales order. Check quantities, due dates and source numbers using the jobs sheet. Opening work value is work in progress, not an issued invoice, payment or sales revenue. John signs each held or manually re-keyed item. If the chosen importer cannot represent an item, keep it on a written exception list and stop that item's transfer.
9. **Check purchase orders.** Reconcile open orders, suppliers, lines, amounts, VAT, received quantities and remaining amounts. Do not mark an order received merely to clear a difference.
10. **Check invoices and payments.** Match invoice references, customers, net, VAT, gross, credits, payments and remaining debt to SliQ. Reconcile unpaid count and aged debt independently to the penny. Unknown payment evidence stays payment to confirm. Never manufacture payments to make totals agree.
11. **Rehearse the complete write separately.** Only the authorised operator may run the reviewed write on the disposable copy after the dry-run report and guards pass. They must show the actual importer transaction, reconciliation, repeat-run/no-duplicate proof and unchanged Marpet counts/balances. No SQL or write is run by this checklist. A report-only dry run is not a write rehearsal.
12. **Get the transfer decision.** John signs the numbers and exceptions. Rhys separately approves the exact frozen files, target company, reviewed importer commit and transfer window. Missing release packaging, failed guards, missing rehearsal evidence or an unexplained penny means STOP. Keep the files and reports; do not rerun with weaker checks.
13. **Load only the approved bundle.** The operator follows the reviewed CLI write instructions using the unchanged report and source hashes. The importer owns its dependency order and single transaction; do not import payments before invoices or manually run files out of order. This plan intentionally supplies no live-write command or credential.
14. **Check before staff resume.** Repeat the full reconciliation: customers, open jobs/orders, POs, invoices, payments, credits and aged debt. Verify company separation, document numbering continuity and unchanged Marpet records. Check one complete fake workflow in the rehearsal first. Resume live entry only after the named people sign. On failure, stop writes and follow the reviewed recovery decision; never wipe/import again as a guess.

## Reconciliation record

| Check | SliQ source | Dry-run report | Rehearsal result | Transfer result | Person and evidence |
| --- | --- | --- | --- | --- | --- |
| Source hashes and export time | NOT RECORDED | NOT RUN | NOT RUN | NOT RUN | |
| Customers and account IDs | NOT RECORDED | NOT RUN | NOT RUN | NOT RUN | |
| Open jobs, sales orders and WIP | NOT RECORDED | NOT RUN | NOT RUN | NOT RUN | |
| Open POs and received quantities | NOT RECORDED | NOT RUN | NOT RUN | NOT RUN | |
| Invoice count, net, VAT and gross | NOT RECORDED | NOT RUN | NOT RUN | NOT RUN | |
| Payments, credits, unpaid count and aged debt | NOT RECORDED | NOT RUN | NOT RUN | NOT RUN | |
| Held rows and human decisions | NOT RECORDED | NOT RUN | NOT RUN | NOT RUN | |
| Repeat run adds no duplicates | NOT APPLICABLE | NOT APPLICABLE | NOT RUN | NOT RUN | |
| Marpet unchanged and company isolation | NOT RECORDED | NOT RUN | NOT RUN | NOT RUN | |

Never put real exports, amounts, addresses, company identifiers or credentials in this public checklist. Private signed reconciliation is required for go live. Fake fixture tests establish parser/guard behaviour, not the correctness of John's real exports.
