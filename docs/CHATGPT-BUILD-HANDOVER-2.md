# Builder 2 handover

Draft PRs only. No Ready labels, merges, applied migrations, deployments or main commits. Original builders’ branches are untouched.

| Job | Work done | Branch | PR | Tests | Blocker |
| --- | --- | --- | --- | --- | --- |
| 6 | Connected settings, approval and claim UI; documented atomic-save and live-test gaps | chatgpt2/chase-wiring | #132 | 13 new tests reported passing; tsc and targeted ESLint passed; Vitest process stays open | No disposable database/provider; atomic settings RPC and concurrency check absent |
| 7 | Added go-live checklist with contact card and payment/email checks | chatgpt2/go-live-day-checklist | #133 | Date, required sections and diff whitespace checked; documentation only | JNR must fill named contacts and phone numbers before first shift |
| 8 | Added chase UI browser flows and optional isolated-backend runner | chatgpt2/e2e-chasing | Pending | 9 Playwright tests cleanly skipped without DB (not passes); tsc and targeted ESLint passed | No disposable database available for browser execution |
