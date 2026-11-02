# Builder 2 handover

Draft PRs only. No Ready labels, merges, applied migrations, deployments or main commits. Original builders’ branches are untouched.

| Job | Work done | Branch | PR | Tests | Blocker |
| --- | --- | --- | --- | --- | --- |
| 6 | Connected settings, approval and claim UI; documented atomic-save and live-test gaps | chatgpt2/chase-wiring | #132 | 13 new tests reported passing; tsc and targeted ESLint passed; Vitest process stays open | No disposable database/provider; atomic settings RPC and concurrency check absent |
| 7 | Added go-live checklist with contact card and payment/email checks | chatgpt2/go-live-day-checklist | #133 | Date, required sections and diff whitespace checked; documentation only | JNR must fill named contacts and phone numbers before first shift |
| 8 | Added chase UI browser flows and optional isolated-backend runner | chatgpt2/e2e-chasing | #134 | 9 Playwright tests cleanly skipped without DB (not passes); tsc and targeted ESLint passed | No disposable database available for browser execution |
| 9 | Reviewed and commented on 21 open PRs; fixed costing render and preview total with regressions | chatgpt2/pr-review | #135 | 7 new tests reported passing; tsc and targeted ESLint passed | Other review findings remain open as listed in docs/BUILDER2-PR-REVIEW.md |
| 10 | Added six-bank layout tests and fixed only reproduced parser faults | chatgpt2/bank-csv-formats | #136 | 15 pre-fix failures; 16/16 new cases reported passing after fix; tsc and ESLint passed | Merge overlap with #131; actual bank export variations still need checking |
| 11 | Added 30 UK messages and fixed reproduced phrase, future and reference-prefix errors | chatgpt2/paid-claim-more-tests | #137 | 30/30 new and 39/39 original tests reported passing; tsc and ESLint passed | Copied detector in #117 must be reconciled; blank-sender adapter finding remains open |
| 12 | Added 40 receivables/money cases; fixed invalid-date overdue calculation | chatgpt2/receivables-tests | #138 | 5 failures before fix; new and original receivables tests checked; see exact counts in handover | Full-suite run follows in job 16 |
| 13 | Plain-English screen pass and correction of the staff guide markup example | chatgpt2/plain-english-pass | #139 | 4 new wording and 3 costing render tests reported passing; tsc and targeted ESLint passed | Consolidate copied components and accessible selectors with chase/bank integration branches |
