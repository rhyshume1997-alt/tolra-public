# SliQ rehearsal on disposable synthetic copies

This is **fake data**, not John's exports or a completed JNR sign-off. No real customer data, production SQL, provider calls or messages are used. Product/importer code and migrations are unchanged. Base: `9b63382eababc73a314853897d447452b267c47e`; numbered schema through 144 plus existing one-time test releases through 151.

In a dedicated checkout with Node 22, Docker and Supabase CLI 2.40.7:

```sh
npm ci
npm run test:backend
set -a; . ./.env.test.local; set +a
npx vitest run -c tests/import/vitest.config.ts
npm run test:backend:stop
```

Do not reuse an occupied test stack: the suite requires zero organisations, literal loopback port 54322 and the existing isolated-backend checks before writing. It creates two synthetic companies, installs the existing rehearsal importer and marks this disposable database with its existing rehearsal identity. Writes use the existing `dryRun` → checksum-bound `writeRun` → `import_legacy_tenant` path. The whole stack must be discarded afterwards. This executor lacks space for the full Docker images; real database proof runs in the branch's disposable Actions workflow.

Only a temporary **copy** of `tests/import/fixtures/` is loaded. Original and copied CSV hashes are checked after import/reporting. Historical document dates are source data, with no assertions depending on today's date. These confirmed synthetic headers do **not** confirm the real report-style `.xls` mapping.

Nine cases cover:

1. Dry run changes no database rows and flags an existing similar customer name
2. Exact invoice/line/payment counts and source document references
3. Exact totals, full/partial payment evidence, and `Paid` without evidence staying unverified
4. Repeat write adds no customers, invoices or payments
5. Changed files and another company's report refuse without writes
6. New native numbers follow imported native references; the other company's counters stay unchanged
7. Read-only SQL rejects an attempted write with SQLSTATE 25006
8. A one-penny discrepancy produces FAIL without a repair
9. Read-only report leaves both companies and source files unchanged

Read `tests/import/results/reconciliation.md` and `.json` after running. The report snapshot uses **REPEATABLE READ READ ONLY** and is rolled back; report generation writes local files only. It never fixes target rows. Dry-run details are under `results/dry-run/`. Negative-test output is deliberately separate under `results/negative-penny/`. All generated files are ignored and available in the draft PR's Actions artifact.

Expected scoped figures: 3 invoices, 3 invoice lines, 2 evidenced payment rows; £255 net + £51 VAT = £306 gross; £174 evidenced payments. A third invoice's source `Paid` label claims £60 but has no payment evidence: no payment is invented. Customer matching preserves account-based source identities and **does not automatically merge** the similarly named existing customer; this remains a human review item. Native next references should be INV-9003 and QUO-9002, without altering the other company.

A scoped financial PASS is **not go-live approval**. The report keeps overall sign-off at NOT SIGNED OFF. Real exports/headers, `.xls` title/header/totals rows, credit notes/allocations, aged debtors, WIP/operations and human approvals remain unchecked by this focused fixture. Existing offline/full SliQ suites remain separate evidence.

Reviewer/tester: __________  Date: __________  Decision: __________  Signature: __________
