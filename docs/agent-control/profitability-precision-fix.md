# #378 precision follow-up

Fixes #391's two assertions on the existing #378 branch. No migration, payroll, rate, enablement or legacy calculator change. Actual costing stays OFF by default until company approval.

- Revenue: reuse the existing invoice/credit eligibility and penny conversion. Check the absolute exposure of each eligible component with BigInt before calling the unchanged legacy aggregate. Unsafe intermediate exposure refuses with Costing incomplete, even if cancellation could make the final profit safe. No wrong penny is displayed.
- Recorded time: retain PostgreSQL's six fractional timestamp digits as integer microseconds internally, union overlapping intervals at that precision, and use BigInt half-up cost rounding. Existing millisecond display fields stay in milliseconds. Unsupported precision/range refuses instead of truncating.

Original two tests first: 0 passed, 2 failed, 0 skipped; before.log retained. After: 61 passed, 0 failed, 0 skipped across actual costing, precision and legacy purchase allocation tests. Four precision tests include both original findings, fractional machine/overhead inclusion and unsupported precision refusal. TypeScript and targeted lint pass. Logs: tests/reviews/profitability-fix/evidence.

No database or live records used. Combined migration execution, browser behaviour, production deployment and John-approved rates remain unproven. No merge, production SQL, private files, #359/go-live changes or John message.

## CI packaging correction

Observed CI run 41990347549 at fa5e358: web failed **1 test, 5155 passed, 0 skipped**. Exact error: `148_job_profitability_actuals.sql can't be applied as one transaction: line 3: transaction control "BEGIN;"; line 171: transaction control "COMMIT;"`. This was my migration packaging error, not an environment limit. The migration is now transaction-free and the existing release generator supplies its one transaction in 148_job_profitability_actuals.release.sql. No test/guard was weakened. Original full job log is retained compressed with its hash.

After correction: focused calculation/allocation plus release-wrapper **247 passed, 0 failed/skipped**; full unit suite **5156 passed, 0 failed/skipped**. One local sandbox attempt had seven child-process permission failures; its original log remains, and the unchanged suite passed with process permission. These are local results, not a claimed green remote integration. The new pushed head gets its own CI record. #391's reviewer NOT SAFE verdict is not cleared by this coding change: final independent review/integration, company rates and production proof remain outstanding; actual costing stays disabled.
