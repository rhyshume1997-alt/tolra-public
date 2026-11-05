# #378 independent review — NOT APPROVED

Public source: ccd74ea513307c5584a11f7cd368f38b742ce769; main base: 68f89ca7b801a10587ff9b51d6c820462847b65a. Synthetic records only. No database, feature or candidate changes.

| Requirement | Evidence | Result |
|---|---|---|
| Off by default | 148 `job_costing_settings.enabled DEFAULT false`; original off-state test | Source and calculation confirmed; deployed company state unproven |
| Existing profit stays | Byte equality for `lib/purchase-order-link.ts` and `lib/overview-metrics.ts`; `components/bought-in-profit.tsx` adds a separate job panel | Existing math unchanged; browser regression NOT EXECUTED |
| Avoid double costs | Original overlap, replay, operator, includes_labour/includes_overhead cases | Tests pass for those cases; not a proof of all inputs |
| Missing costs | Original missing rate/hour/approval/read/allocation cases return incomplete | Tested; explicit approved zero rate and explicit no-resource jobs remain legitimate zero costs |
| Penny exact | Two adversarial assertions below | FAIL; do not enable based on this review |
| 148 vs 147 | 148 is a separate migration; public 9d7725e has no 148 | No number collision in these snapshots. Applying both together NOT EXECUTED here |
| Admin/company isolation | 148 source uses financial gates, same-org parents and admin setter | Source review only; database permissions NOT EXECUTED in this review |

## Defects to fix

1. **Unsafe aggregate revenue (medium):** 91 individually valid numeric(14,2) invoices at 999999999999.99 pounds, one allocated purchase at the same amount, and 5,500p other costs produce a safe final profit. Expected 8,999,999,999,994,410p; returned 8,999,999,999,994,409p with state complete. The reused revenue sum uses Number before the final safe-integer check. Use exact intermediate sums or refuse an unsafe aggregate. This is an extreme boundary, not a claim about JNR's sales.
2. **Sub-millisecond time lost (low/boundary):** PostgreSQL timestamps can retain microseconds. 360 disjoint one-hour sessions each with 500 extra microseconds at 10,000p/hour produce 3,600,000.5p: half-up means 3,600,001p. `spanOf` uses Date.parse and returns 3,600,000p. Preserve precision or obtain explicit approval for a millisecond-only recording contract. This test does not claim current browser timers generate such inputs.

## Repeat and limits

`npx vitest run --config tests/reviews/profitability/vitest.config.ts`

Expected current result: 34 passed, 2 failed, 0 skipped (exit 1). Original 32 tests retained, only their fixture import relocated. Calculator fixture is byte-identical to pinned #378. Initial sandbox process-denial log is retained separately; final failures are assertions. No failures are hidden or marked expected-pass. Lint/typecheck are separate checks, not fixes for these defects.

Rates, overheads and enabling need company approval. Production data, full UI, migration execution, historical rate changes and deployment remain unproven here. Tester: Codex synthetic run; time/commit/hashes: evidence metadata. Human approval: ______; date: ______. Review fixes: pending.
