# #378 precision follow-up

Fixes #391's two assertions on the existing #378 branch. No migration, payroll, rate, enablement or legacy calculator change. Actual costing stays OFF by default until company approval.

- Revenue: reuse the existing invoice/credit eligibility and penny conversion. Check the absolute exposure of each eligible component with BigInt before calling the unchanged legacy aggregate. Unsafe intermediate exposure refuses with Costing incomplete, even if cancellation could make the final profit safe. No wrong penny is displayed.
- Recorded time: retain PostgreSQL's six fractional timestamp digits as integer microseconds internally, union overlapping intervals at that precision, and use BigInt half-up cost rounding. Existing millisecond display fields stay in milliseconds. Unsupported precision/range refuses instead of truncating.

Original two tests first: 0 passed, 2 failed, 0 skipped; before.log retained. After: 61 passed, 0 failed, 0 skipped across actual costing, precision and legacy purchase allocation tests. Four precision tests include both original findings, fractional machine/overhead inclusion and unsupported precision refusal. TypeScript and targeted lint pass. Logs: tests/reviews/profitability-fix/evidence.

No database or live records used. Combined migration execution, browser behaviour, production deployment and John-approved rates remain unproven. No merge, production SQL, private files, #359/go-live changes or John message.
