# Profitability half pennies

Base: accepted #433 at147ac28e0b9343ba5b041fdb9956767c180671ce. Separate costing branch; no Xero helper work.

Tests first: `INTEGRATION_VERIFY_BASE=e7c4b6380964386e66e5d6a67ed37ad0aaed8da5 npx vitest run --config tests/reviews/night-cost-profit/vitest.db.config.ts --reporter=json --outputFile=/tmp/profit-half-before-executed.json`:39 passed/10 failed/0 skipped. New cases compare exact numeric strings, including values beyond JavaScript safe integers and the bigint limit, reject invalid ratios/overflow, preserve null costs, and create an old half-even snapshot before restoring the current function. The old snapshot remains byte-identical; only the open job's expected half-up value fails. Raw before evidence is committed.

An earlier unpinned setup stopped at the existing strict148 verifier:27 passed/22 pending,2 setup-suite failures. That is not a passing or executed49-case receipt. The accepted immutable Code verifier was used only for baseline fixture preparation while protected SQL still matched Code; the active148 assertions remained red. After correction, rerun without that pin so the edited148 release must pass its active verifier.

Planned narrow correction: integer numeric ratio rounds halves up for business actual costs, retaining bigint pence, null/missing-cost behaviour and historical snapshots. The frozen quotation engine and its60 half-even golden tests remain unchanged. No automatic refresh/recalculation of closed jobs. No grants/RLS, applied numbered history,143 rate source, candidate or production changes. Required checks and after-results are pending at this tests-first commit.
