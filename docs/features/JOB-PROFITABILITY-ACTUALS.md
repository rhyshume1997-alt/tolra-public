# Optional actual job costing

This feature starts **off** for every company. The old bought-in/profit line and overview calculations remain unchanged. No payroll, employee pay rate, issued document or timer is changed. No migration has been applied to any real database.

## Before enabling

John and the company admin must agree:

- The company labour costing rate in pounds per hour. This is a business cost, not a person's pay.
- Each machine's hourly cost and whether it already includes its operator's labour and overheads.
- Whether extra overhead is needed; if so, its hourly rate and whether it uses labour hours or machine hours.
- That recorded hours, machine operators, supplier allocations and job estimates are complete. An explicit zero rate needs agreement too.

An admin with financial access opens a job's **Company costing rates**, saves rates disabled, checks them, then chooses **Approve rates and enable company costing**. Only that admin action enables the new view. Rate saves are bound to the company and revision opened; stale saves refuse. Each save keeps a private rate history. Saving disabled turns the view off again. All job views use the **current** approved rates; this is not a locked historical costing ledger.

## What the figures mean

Actual profit = issued invoice net value less issued credit notes, allocated supplier purchases, additional recorded labour, machine costs and additional overhead. Values exclude VAT and carriage, matching the existing profit basis. Reuses `lib/purchase-order-link.ts` for suppliers, quotes and invoices/credits; `lib/overview-metrics.ts` is unchanged.

Hours come from completed, non-void `operator_sessions` and `machine_runs`. Open, invalid or missing time keeps costing incomplete. Planned hours never replace recorded hours. For a job with no labour or machine work, office staff must explicitly confirm that in **Job estimate and required hours**. A read failure is never treated as an empty list.

Overlapping time is counted once per person or physical machine. A person's time recorded on two jobs at once keeps both incomplete until corrected. Machine-inclusive labour is removed only for that run's recorded operator and matching time. Machine-inclusive overhead is removed on the chosen basis. Missing operator identity keeps affected costing incomplete. This avoids guessing who operated a machine.

Prices and final costs use integer pence and halves round up. Recorded timestamps use millisecond precision. Sum chargeable labour time before rounding its cost once; round each machine's combined time cost once; round extra overhead once. Money display uses two decimal places. Margin is actual profit divided by net revenue, to one decimal; no margin when revenue is zero or negative.

Estimated profit uses ordered quote lines, the job's existing `job_machines.estimated_hours`, and the office's saved supplier cost, **additional** labour hours and **additional** overhead hours. Additional estimated hours exclude amounts already in machine rates. A blank estimate stays unknown. Actual profit can still be complete without an estimate; comparison waits for one. Warnings show hours or costs above the estimate. Quote-only POs shared by several jobs need a job allocation before the new view can report actual profit.

## Verification and migration

Migration **148** follows main's highest migration, 137, leaving 138–147 for pending branches (147 belongs to delivery-note work). Recheck number availability before release. It adds only four costing tables, same-company parent guards, financial read policies, read-only guards and narrowly granted RPCs. Direct API writes are revoked. Only admins set rates; financial office staff may save job estimates. The RPCs enforce existing MFA and section access rules. No production SQL is authorised.

Local checks:

```
npx vitest run tests/unit/job-profitability-actuals.test.ts tests/unit/job-profitability-ui.test.ts tests/unit/purchase-order-link.test.ts tests/unit/overview-metrics.test.ts
npm run typecheck
npm run lint
node scripts/check-migrations.mjs
node scripts/test-job-costing-db.mjs
```

The database runner accepts no database URL. It creates a fresh, network-isolated PostgreSQL container with synthetic records, checks its random identity before SQL, records commit/environment/SQL hash/time/exit code and original logs under `/tmp/tolra-costing-*`, then removes its own container. It checks actual migration 148, permissions, isolation, stale saves, financial input mapping, unchanged legacy records, rollback and re-release. Its prerequisite Auth/access helpers are synthetic stand-ins: it does **not** prove Supabase Auth, PostgREST or browser integration. Full disposable Supabase integration remains a release gate; local stack startup was blocked by registry access. No security check was relaxed.

Read-only verification: `supabase/verify/job_profitability_actuals_148.sql` (all six rows true). Release SQL matches the migration. Rollback: first disable costing and deploy without the new panel; export the four costing tables if their settings/history are needed, then use `supabase/release/148_job_profitability_actuals.rollback.sql` only on an approved target. It removes only this feature's data and functions. It does not undo invoices, purchases, timesheets or machine runs. Never restore a backup over live activity for this rollback.
