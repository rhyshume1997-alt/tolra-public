# Tolra validation pack

This is a blank evidence pack for a company using an ISO 9001 quality process. It helps the company show what it asked for, what could go wrong, how it tested the software and who accepted the results. It is not a certificate or a claim that tests have already passed for that company.

The files live in `tests/validation/` because public code PRs block files under `docs/`. No real customer data or credentials belong here. Store completed evidence privately; commit only fake examples and blank templates to this public repository.

1. Process owner approves [URS](URS.md) and [risks](RISK-ASSESSMENT.md), including intended use and missing requirements.
2. Complete [IQ](IQ.md) for the disposable test installation.
3. Complete [OQ](OQ.md), saving automated logs and manual screen/database evidence separately.
4. Company staff complete [PQ](PQ.md) using fake versions of their own working day.
5. Fill in [traceability](TRACEABILITY.md), resolve deviations, then sign the [VSR](VSR-TEMPLATE.md).

Each protocol has numbered steps, expected results, pass/fail/not-run and evidence columns. Leave a result blank until performed. Record actual behaviour, tester, date, environment and exact commit with every result. A command's exit code is evidence only for that command; it does not establish RLS, provider behaviour or a whole screen workflow by itself.

From repository root after `npm ci`:

```sh
# Read-only check of this pack's IDs, test paths and links; no DB/network.
node tests/validation/check-pack.mjs
# Run only the explicitly mapped unit suites; no migrations or database.
node tests/validation/check-pack.mjs --run-unit
# Collect browser cases without running them or seeding a database.
npx playwright test --list
```

To run a mapped browser file later, the environment owner must first supply a disposable database with the expected schema and fake users. Review its fixtures before running: some browser suites seed test data. For example, in that approved environment only:

```sh
npx playwright test tests/e2e/company-switch-two-tabs.spec.ts
```

No setup script in this pack applies SQL, deploys or starts provider sends. Database/RLS, live OAuth, real email delivery, backup restoration and the company's PQ remain operator checks. Do not set a production URL to make a test run. Where code has a known gap, record a failed or not-run step and a deviation rather than signing it off.
