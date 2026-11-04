# L1 — independent lag cross-review and handover

Builder 6, 4 November 2026. Explicit Rhys assignment; atomic `claims/L1`. Draft follow-up into `codex/b4-lag-pages`; original builder branches unchanged. Read AGENTS.md and the coordination handover/ownership records at `d7596ca` (absent from main and the candidate). No main merge, production SQL, deployment or Ready label.

Reviewed #343 at `a4ebfbfae996b077e5956aec8bf28a35fab20d14` and #344 at `40ad1d6e6aeb6a47c715d0e0aa8072e3426fdc86`, against `9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8`. These PRs are complementary, not two implementations: #343 only adds `LAG-MORE-TIMESHEETS-CUSTOMERS.md`; #344 changes three production files and adds tests/evidence.

## Findings

- **No production mistake found within this review.** Dashboard calculations/return shape and `rowToJob` are unchanged; the dashboard edit overlaps independent request groups, retaining office exclusion of money queries and the dependent plan read. Frozen-clock admin, office and failed-invoice results match the original candidate snapshots. This is mock result parity, not proof of a transactional snapshot during concurrent real database writes.
- The jobs list selects **24 columns**. Identity/customer: `id, job_no, customer, description`; state/dates: `stage, due_date, status, started_at, finished_at, inspected_at, inspected_by, finished_by, date_received, date_required`; worksheet: `specification, drawings, customer_po, quote_ref, quantity_required, drawing_no`; links/actions: `is_internal, related_job_id, assigned_to, converted_from_sales_order_id`. These cover the mapper, requiredDate/jobStatus, board, worksheet dialog and export fields. `created_at` remains in ORDER BY; SQL does not require it in the projection. Mapper fallbacks `reference, customer_name, customer_id` are not jobs columns in the declared schema; adding them would break that query.
- CSV/Excel use `JOB_COLUMNS` on mapped rows; new tests compare every actual getter for complete, legacy-date and internal/zero-quantity cases. Word/PDF use `selectedJobRows` fields from that same mapped row plus unchanged file/run/inspection helpers. All their mapped fields remain present.
- Single print and Workshop Pack receive **IDs**, then independently call `loadWorksheet`, whose `jobs.select("*")` is unchanged; attached drawings/POs also retain their own reads. Narrowing the board query does not narrow the printed worksheet. The worksheet dialog passes only fields already selected. This was traced in source; no browser/physical-print run is claimed.
- The **real default 20,000 guard** was independently exercised with 19,999/20,000/20,001 rows at server cap 400. All expected rows survive, the last request starts at 19,600, and reaching 20,000 reports truncation. Exactly 20,000 is conservatively flagged too; the flag means the bound was reached, not proof a 20,001st row exists. Duplicate filtering/error propagation remain.
- Smaller-cap support survives: first short page is confirmed; later shorter page ends the loop. Existing cap-1/200/400/exact-multiple tests pass. A stable server cap/order is assumed; neither version guarantees a consistent snapshot during inserts/deletes.
- Jobs recurring timer checks visibility before starting reads, fires at 300 seconds, makes no timer/focus read while hidden, refreshes on becoming visible and cleans up listeners/timer. An already-started request is not cancelled by hiding the tab, and sync-triggered refreshes remain separate; that is unchanged behaviour. Five-minute polling deliberately permits up to five minutes of background staleness while visible.
- #343's route/helper references and dependency explanations agree with the pinned candidate: time guards/revision ordering stay necessary; customers' four document reads already run in parallel. It makes no latency claim and supplies no extra implementation to merge into #344.

## Changes and checks

Only test coverage and this handover were added: one real export-cell parity case and three default-limit boundary cases. No production edit was warranted. Existing assertions and snapshots were retained.

- On untouched `9c3f5c6`, copied the unchanged snapshot fixtures and ran only `dashboard result parity|jobs row parity`: **4 passed**, six other tests deliberately excluded by the test-name filter; snapshots were not regenerated. Temporary copied files were removed from L2 afterwards.
- On reviewed #344 plus these tests: `node node_modules/vitest/vitest.mjs run tests/unit/fetch-all.test.ts tests/unit/page-loading-lag.test.ts tests/unit/lag-review-boundary.test.ts tests/unit/import-columns.test.ts`: **42 passed / 4 files**, no failures/skips.
- Explicit unchanged-config ESLint on both changed test files: exit 0. `git diff --check`: pass. Reused supplied dependencies for this focused independent review; no broad suite rerun or claim to reproduce builder 4's full-suite evidence.

Next: reviewer checks this draft with #344; Rhys/Code compare the approved assembled test app's figures, exports, print and visible/hidden behaviour. Real backend/browser/offline and latency proof remain open. L2 supplies the timing tool; no production measurement was run.
