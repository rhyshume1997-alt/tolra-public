# Current evidence scope

Software is NOT VALIDATED. No release, SQL, wipe or go-live approval is granted.

Frozen CA to CD code: `d73bb240a23b38a7080c0933e4f5b62ddd529f5f`, based on #247 `41c685c416305637d86b580324fff9e6cda037ff`. These are unmerged review branches. Recheck the actual final integration SHA before any decision.

| Evidence | Result | Exact scope |
| --- | --- | --- |
| Full unit suite on frozen code | PASS, 5,567 passed, 0 failed, 0 skipped | `evidence/2026-11-04-ca-cd/unit-summary.json`, exact SHA and log hashes. Supports unit conditions only. |
| CA focused release packaging | PASS, 19 | #272, ef3e76e3e6c0fdbc012a4f59bd55dddd2f26920b; historical supporting evidence, not runtime release proof. |
| CB refusal cases | PASS, 66 | #273, ff13614fcd8bd37d989faec74d387371ef7ac378; fake evidence only. |
| CC offline reconciliation | PASS, 35 | #274, d88f06333556e5c2a80e183a5067c5f7117562fa; synthetic snapshots only. |
| CD fake dry run | PASS, 9 tests | #275, d73bb240a23b38a7080c0933e4f5b62ddd529f5f; no file/database writes, no real import. |
| Fake reconciliation value result | NOT TESTED for final WIP valuation | 1 UNVERIFIED WIP valuation, accountant required. It is INCOMPLETE, never a full PASS. |
| TypeScript and changed-file lint | PASS on CA to CD code heads | Supporting local commands; final branch full lint/typecheck recorded separately in CI job. |
| Disposable database start | FAIL, environment/storage | Docker image registration failed ENOSPC before backend start. No release SQL applied, no database tests executed. |
| Exact combined #250 wipe, restore comparison, real imports | NOT TESTED | No local proof. #250 remains blocked. |
| Database/provider/browser/manual proofs | NOT TESTED | See OUTSTANDING-CHECKS.md. Old extras links do not prove this integration. |
| Rhys's URS/risk/process acceptance and VSR | NOT TESTED | All acceptance and signatures remain blank. |

IQ-001 records local checkout identification only. IQ-002 to IQ-006 remain NOT TESTED as complete installation protocols. Every OQ and PQ row remains NOT TESTED until its full expected result has actual exact-head evidence. Passing supporting unit files never completes screen, SQL, provider, backup, restore, WIP or company process checks.
