# Go-live smoke and dry run: runbook

One-off, diagnostic. Candidate under test: `31f965e7f0cbb2d9caf336b0a2067411bec8fb45` (branch `claude/delivery-notes-golive`, draft PR #359). This branch (`claude/golive-smoke`) only adds files. `scripts/golive-smoke/shas.sh` fails the job if `lib/`, `app/`, `components/` or `supabase/` (or the package files, `tests/support`, the e2e helpers and config) differ from the candidate. Synthetic data only. Loopback databases only. No hosted project, no production SQL, no secrets.

## What runs where

| Where | What | Not here |
|---|---|---|
| **Public**: `.github/workflows/golive-smoke.yml` on this branch (one run, from the push that registers it; `workflow_dispatch` for a re-run) | Fresh disposable local Supabase: migrations 000-144. The smoke company is made **before** the releases, as JNR exists before them. Releases 145, 146, 147 in order. The 147 hold. The SliQ part on synthetic exports through the real importer. One ordered browser walk with the DLN counter step inside it. The gate. | Restored copies of production, rollbacks, the wipe, Marpet. |
| **Private**: `quoteflow-jnr` `.github/workflows/mock-prod-run.yml`, prepared at `claude/mock-prod-run` head `05dc0d69632f777a133ba8c0d67741786046df69` | Production-shaped copy (fake JNR and fake Marpet) built from migrations 000-137 only. Backup and restore drill. Preflight. Release order with order guards. Rollback drill. DLN step on a restored copy. Wipe rehearsal. | Anything in this public job. The kit files stay private; none is copied here. |

The private run's labelled lines that this smoke relies on (the label text as defined at `05dc0d6`). Read each label's PASS/FAIL from that run's `LABEL` lines. This job does not run them:

- `Every release applied in plan order, own verify all t, marker applied`
- `Out-of-order releases refused (every release that has an order guard) with no data change`
- `Release 147 (job delivery note): refused before 146 and when re-applied with no data change; its rollback keeps every delivery note`
- `Day-of DLN counter step on a copy of the restored database: notes refused before the step and after an undo, set, verify all PASS, second run and lower/equal refused, both routes number on`
- `Rollbacks of every release verified in reverse order; 146 refuses with a reservation; usage history kept; reset needed after 146`
- `Wipe rehearsal 0 FAIL`, `JNR only approved transaction rows removed`, `Marpet all protected rows unchanged`, `Final combined JNR wipe on a SEPARATE restored copy equals the wipe on the original`

## Order in the public job

1. Reserve the ports, check out the code, and run `shas.sh` (candidate, branch head, tree ids).
2. `npm ci`. Start the stack. **SMOKE 1**: the migrations applied match the files, 000-144.
3. **SMOKE 2**: `seed-company.mjs` makes the smoke company (slug `t-golive-*`, four roles, `@example.test`) through `create_organization` and `add_member`.
4. **SMOKE 3-5**: `install-releases.sh` uses the same mechanism as ci.yml's install step. For each release: the marker must say `not applied`, then the release file is applied, the marker must say `applied`, and every row of the verify file must be `t`. **SMOKE 6**: release 147 holds the smoke company.
5. **SMOKE 7**: `node --test` for the generator, the pre-processor and the gate.
6. **SMOKE 8-16**: `tests/e2e/golive-smoke/sliq-import.vitest.ts`.
7. Build the app. Install Chromium. **SMOKE 17-39**: `tests/e2e/golive-smoke/walk.smoke.ts` runs through `playwright.golive-smoke.config.ts`. It uses the suite's own global setup plus a loopback stand-in costing engine.
8. The gate (always runs). Then the evidence artifact `golive-smoke-evidence`, with no passwords, and the stack is stopped.

## The DLN counter step inside the walk

`scripts/golive-smoke/dln-step.sh` runs the candidate's `supabase/cutover/set_dln_next_number.sql` and `verify_dln_next_number.sql` unchanged, through `psql -v company_slug=... -v last_pad_number=4521`, as the operator and the verifier will on the day.

- **18**: both browser routes are refused before the step: a delivery note for a job with no order (job card) and a hand-made note. The API is also refused with 55000. No note is written and no number is taken.
- **19**: the step sets the counter. Expected: exit 0, `counter 0 -> 4521, next delivery note DLN-4522; ... (was held: t)`.
- **20**: verify returns 10/10 PASS.
- **21**: a second run and a different number are both refused. The counter and the marker are unchanged.
- **25 and 26**: after the step, the note from the sales order is `DLN-4522` and the no-order note (release 147's route) is `DLN-4523`.

## Reading the lines

`SMOKE <n> <name>: PASS|FAIL [hh:mm:ssZ] (<seconds>s) <detail>`. The detail gives the figures that were checked.

- A step that needs a failed step is written `FAIL ... not run: needs step N`.
- `KNOWN GAP <name>: ...` means behaviour the candidate does not have. It is named from what the code actually did, and it does not fail the gate.
- `FINDING <name>: ...` means a real defect seen on the way. It is reported and does not fail the gate.

The gate prints:

- every SMOKE line
- the KNOWN GAP and FINDING lines
- the SHAs
- the Playwright and Vitest report counts
- `counts: 39 steps, P PASS, F FAIL, M MISSING`

It fails on any FAIL, a missing or duplicate step, an unknown step, a skipped, failed or flaky test, or a failed SHA check.

| n | step | proves |
|---|---|---|
| 1-6 | stack, company, 145, 146, 147, hold | Fresh 000-144. Releases in order with verify all true. The company existing at install is held. |
| 7 | unit tests | Generator, pre-processor, gate (including seeded FAIL, skip and missing). |
| 8 | sliq-preprocess | The header is found by name. Group and totals rows are skipped and the totals reconcile. A Quotes report is refused as invoices. VAT that is not 20% is listed. |
| 9 | invalid date | One bad dd/mm/yyyy refuses the whole file. The importer refuses 2026-02-31 and writes nothing. |
| 10-12 | dry run, once, repeat | The dry run writes nothing. The first commit imports once. A repeat creates 0 and leaves the row counts unchanged. |
| 13 | payments | `amount_paid` equals the payment rows. Balances match the synthetic Unpaid and Aged Debtors reports to the penny. Equal twin payments are both kept. |
| 14-15 | credits | A negative SliQ credit note becomes a positive one linked to its invoice. A credit note with no invoice, or an unknown one, is refused. |
| 16 | e-mails | A multi-address cell is split. A cell with no valid address is kept in the notes. |
| 17-21 | customers, DLN hold and step | Described above. |
| 22-24 | quote, job | Real costing panel: 3 x 33.335 -> 33.34 (half away from zero). Send, accept with PO, then the sales order and the job. Finish and inspect. |
| 25-29 | delivery notes | DLN-4522 from the order. The workshop despatches it. DLN-4523 without an order. The print sheet and the PDF carry the goods-out wording and the Received by / Signature / Date line. The e-mail with the PDF goes to the Resend mock sink. |
| 30-32 | invoices, payment | 100.02 + 20.00 = 120.02 issued, then paid in two parts. 1.5 x 0.09 = 0.135 -> 0.14, with VAT per line 0.05 (not 0.04). |
| 33 | chase | One DRAFT for the owed invoice. Nothing is e-mailed. The paid invoice is not chased. |
| 34 | account | Owed per customer to the penny. There is no statement document (KNOWN GAP). |
| 35 | search | Quote by customer, invoice by number. |
| 36-39 | refusals | Workshop: no money screens, and the send route answers 403. Viewer: no edits and no notes. Outsider: sees nothing. Business rows are identical before and after. |

## Not covered

- Production, restored copies, rollbacks, the wipe and Marpet: these are the private mock-prod-run's job.
- The admin second step (MFA) server, Microsoft 365 sending, Xero and accounting connections.
- Offline and tablet behaviour, phone layouts, real SliQ files, PO lines, quote-item imports, opening WIP (a KNOWN GAP), a real costing engine (a loopback stand-in is used), real e-mail delivery (only the mock sink is used), and load or volume.
- The run gives one result per step. It does not repeat steps or measure flakiness.
