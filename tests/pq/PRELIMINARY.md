# Preliminary execution of the fake PQ run sheet

PRELIMINARY: final candidate SHA is unknown. This branch is a separate test integration of #454 at `3a2de7c6513c1a5c2891f9e4529a8814da4b6fbb`, the #455 fixture at `2dd86eb7ec02d94c238e8af815d090bb5692b14c`, and the #458 alert fix at `14ed8218b948a5d17afb75a08ef03e3b0c6f8e04`. Their branches and candidate are unchanged. Cherry-picked history preserves provenance; no new application/migration behavior is introduced by this test job.

In a dedicated checkout with Node 22, Supabase CLI 2.40.7 and Docker:

```sh
npm ci
node tests/pq/pq.mjs prepare
npx playwright install chromium
npx playwright test -c tests/pq/preliminary.config.ts
node tests/pq/pq.mjs stop
```

The twelve checks follow tests/pq/RUN-SHEET.md: admin sign-in, fake customers, company rates, quote totals, customer PO/job links, actual costs, unavailable missing costs, pending delivery PDF, draft invoice, approval draft, provider cards/AI off, and workshop login/schedule/financial refusal. They use the real app/Auth/database on the dedicated 55321/55322 stack with synthetic data only. Provider calls are blocked. They read documents and generate a local print PDF without sending, approving, dispatching or signing anything.

Actual outcomes are written to `tests/pq/results/preliminary.json`: exact source SHA, candidate SHA null, PASS/FAIL/NOT RUN per step, backend identity and unchanged financial rows. A row becomes PASS only after its assertions and screenshot succeed; a failure leaves subsequent rows NOT RUN and fails the command. The strict workflow requires all twelve PASS. Screenshots and PDF are in the same run's Actions artifact. Do not fill human signatories from automated results.

This is a twelve-step synthetic rehearsal, not the full agreed validation pack or live verification. Physical workshop devices/printers, John/Rhys acceptance, live provider consent/delivery and the final candidate remain unchecked. Rerun on the final reviewed candidate source before sign-off. The separate representative-role/security/cost-snapshot job supplies additional executed evidence.
