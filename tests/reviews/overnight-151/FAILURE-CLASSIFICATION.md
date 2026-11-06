# Overnight SQL failure classification

SQL: immutable `int/xero-all` head `e7c4b6380964386e66e5d6a67ed37ad0aaed8da5`. App/test overlay: accepted #433 head `147ac28e0b9343ba5b041fdb9956767c180671ce`. Protected SQL bytes match the former. The original Code app did not call these new safe wrappers; the reviewed app fails closed until its matching SQL is integrated. These are implementation/integration-contract gaps, not a claim that the unmodified old app calls an absent RPC.

Reproduced30 failed assertions,0 skips: invitation32/6, picker8/12, financial32/5,151 package11/4, lifecycle5/3 (passed/failed). Groups overlap. Raw reports/logs: `evidence/baseline/`. Exact reproducible SQLSTATE probes: `node tests/reviews/overnight-151/diagnose-baseline.cjs`, which loads immutable Code SQL into a fresh nonce database, then drops it; results/hashes: `evidence/baseline-probes.json`.

## Root causes

- `151-pending-revocation`: 2 assertions
- `151-final-invite-write`: 7 assertions
- `151-dependent-verification`: 3 assertions
- `151-atomic-picker`: 13 assertions
- `148-half-up`: 5 assertions

`42883` is the underlying missing-function exception. Route503/store_failed assertions are translations; the direct probes prove the underlying state. `00000` means the database query succeeded but returned a wrong monetary value, false revocation, or false verification row; the JavaScript assertion itself has no SQLSTATE. Missing-helper permission/search-path tests cannot reach their intended mutation until the implementation exists. Verifiers correctly refuse missing safeguards.

All30 classify as implementation/integration dependencies, not environment or fixture failures. The exclusive disposable PostgreSQL17.6 fixture supplies minimal Auth/Storage structures; it is not hosted Auth/browser proof. Historical sandbox EPERM, inode exhaustion and fixture-bootstrap early exits are separate environment/harness issues, not any of these30 executed failures.

Affected definitions: `supabase/proposals/p151_xero_invite_hardening.sql`, its151 release/rollback and `supabase/proposals/p148_job_profitability_actuals.sql`/148 release. Applied numbered migration history stays unchanged.151's three dependent verifier assertions reflect missing final store, missing picker claim and missing completion column; their approved search-path/grant checks must remain strict.149 transfers OFF/held-document rules are not weakened.

## Exact failing tests

| Root | SQLSTATE | Suite / exact test | File |
|---|---|---|---|
| 151-pending-revocation | 00000 | integration / revocation must remain available between exchange and callback | `tests/reviews/integration/security.db.test.ts` |
| 151-final-invite-write | 42883 | integration / guarded final invite write must reject expiry during provider exchange; a missing RPC is not security proof | `tests/reviews/integration/security.db.test.ts` |
| 151-final-invite-write | 42883 | integration / positive control: the guarded final invite write must complete a fresh valid consent | `tests/reviews/integration/security.db.test.ts` |
| 151-dependent-verification | 00000 | night-151-package / integrated151 must satisfy every active verifier row, including required final-store and picker helpers | `tests/reviews/night-151-package/release.db.test.ts` |
| 151-final-invite-write | 42883 | night-151-package / verifier refuses a temp-schema-first path on public.integration_invite_store_connection(text,uuid,uuid,text,text,text,text,text,text,timestamptz,integer) | `tests/reviews/night-151-package/release.db.test.ts` |
| 151-atomic-picker | 42883 | night-151-package / verifier refuses a temp-schema-first path on public.integration_xero_picker_claim(text,text,integer,integer) | `tests/reviews/night-151-package/release.db.test.ts` |
| 151-final-invite-write | 42883 | night-151-package / verifier refuses a missing final-write helper and an authenticated grant on picker claims | `tests/reviews/night-151-package/release.db.test.ts` |
| 148-half-up | 00000 | night-cost-profit / 148 is installed: preflight marker applied, every 148 verify row true and 143's verify still true | `tests/db/job-profitability-148.test.ts` |
| 148-half-up | 00000 | night-cost-profit / reuses 143's rates only: labour (machine override), machine hourly, overhead_pct; an edit through 143's save moves an OPEN job's live figure | `tests/db/job-profitability-148.test.ts` |
| 148-half-up | 00000 | night-cost-profit / rollback drops only 148 (143's rates and save function untouched), the release applies again, verify true, a second install refuses | `tests/db/job-profitability-148.test.ts` |
| 148-half-up | 00000 | night-cost-profit / 148 actual-cost rounding follows the money half-up rule outside the frozen quotation-engine exception | `tests/reviews/night-cost-profit/profit-rates.db.test.ts` |
| 148-half-up | 00000 | night-cost-profit / a half-penny actual machine cost from 143 rates is retained as one penny in 148 business money | `tests/reviews/night-cost-profit/profit-rates.db.test.ts` |
| 151-final-invite-write | 42883 | xero-invite-adversarial / 2 replay, actual concurrent redemption, expiry and revocation replaying the OAuth callback repeats neither token exchange nor connection storage | `tests/reviews/xero-invite-adversarial/adversarial.db.test.ts` |
| 151-pending-revocation | 00000 | xero-invite-adversarial / 2 replay, actual concurrent redemption, expiry and revocation revocation remains possible during OAuth and prevents the final connection | `tests/reviews/xero-invite-adversarial/adversarial.db.test.ts` |
| 151-final-invite-write | 42883 | xero-invite-adversarial / 3 company, creating-admin and selected-Xero-organisation bindings changing a hidden company/admin form value cannot change the binding | `tests/reviews/xero-invite-adversarial/adversarial.db.test.ts` |
| 151-final-invite-write | 42883 | xero-invite-adversarial / 5 successful consent keeps transfers OFF and held documents held consent alone neither activates transfers nor releases held pending sends, including a subsequent sweep | `tests/reviews/xero-invite-adversarial/adversarial.db.test.ts` |
| 151-dependent-verification | 00000 | xero-invite-adversarial / 6 migration 151 actual verification and rollback the actual verification file returns true on every row | `tests/reviews/xero-invite-adversarial/adversarial.db.test.ts` |
| 151-dependent-verification | 00000 | xero-invite-adversarial / 6 migration 151 actual verification and rollback rollback refuses open invitations, then succeeds after they are cancelled; reapplying restores verified 151 | `tests/reviews/xero-invite-adversarial/adversarial.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / wrong and missing CSRF are refused without consuming the valid choice | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / sequential replay is refused by the REAL database limiter after the first successful choice | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / two independent SQL transactions cannot both claim a single-use picker nonce | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / two concurrent actual picker POSTs cannot both pass a single-use claim before either RPC transaction commits | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / limiter outage refuses without contacting Xero and permits a later explicit retry | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / successful selection keeps transfers OFF, held documents unchanged, and the sweep sends nothing | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / actual choice and connection audit rows are recorded under the correct company/admin | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / changed or disappeared offered connection IDs are refused after the live re-list | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / an offered tenant owned by another company cannot be claimed or deleted | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / creator demotion during token refresh is refused by the final SQL write | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / provider refresh failure cannot store anything or expose provider error text | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |
| 151-atomic-picker | 42883 | xero-picker-adversarial / unselected consent connections are removed even when the admin chooses after six minutes within the ten-minute offer | `tests/reviews/xero-picker-adversarial/picker.db.test.ts` |

## Accepted browser branch evidence

#433 `147ac28e0b9343ba5b041fdb9956767c180671ce`: [Actions42162456124](https://github.com/rhyshume1997-alt/tolra-public/actions/runs/42162456124),8 actual Chromium cases passed,0 failed/skipped/flaky, against real disposable Supabase. Public IPv4/IPv6 egress restrictions were active; the reserved-address rejection check passed and firewall counters are in artifact13477114809, SHA256 `5b174d173849cccae5bf8a92b8b3e0278d6d34b1efd36a22b889c624432361cb`. That receipt proves that branch, not these pending SQL corrections. The earlier synthetic Xero navigation incident and its correction remain documented in #433. No new provider calls are part of this SQL reproduction.
