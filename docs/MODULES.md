# Tolra SaaS Modules

Break work into these. Agents own one module at a time. Cross-module changes require a separate task that only updates interfaces.

## 1. Auth / Company / Users / Admin
- Allowed: `app/(dashboard)/admin/users/**`, `app/api/admin/**`, `lib/company.ts`, `lib/use-user.ts`, `lib/auth/**`, `lib/mfa-*`, `middleware.ts`, related components
- Goal: Stable multi-tenant login, MFA, permissions, company isolation. Freeze after verification.
- Interface: `getCompanyContext()`, `requireRole()`, user save/update functions.

## 2. Jobs / Schedule / Time / Workshop
- Allowed: `app/(dashboard)/jobs/**`, `app/(dashboard)/schedule/**`, `app/(dashboard)/time/**`, `lib/job-*`, `lib/machine-*`, `lib/time-*`, related components
- Goal: Extract board, status flows, machine plans, time sheets from god pages into components/hooks. Core workshop flow solid.
- Current problem: `jobs/page.tsx` 142k, `schedule/page.tsx` 56k.
- Also owns (read-only, off by default, admin and office): `lib/jobs/**` (planned vs actual #471: `planned-vs-actual*.ts`, `load-planned-vs-actual.ts`; NCR register #469: `ncr-register*.ts`, `load-ncr-register.ts`) and its UI `components/jobs/planned-vs-actual-panel.tsx`, `components/jobs/ncr-register.tsx`, `components/jobs/jobs-reports-settings-card.tsx`. The report functions are SELECT-only and write nothing; the reports (module 7) call them and never import internals beyond these.

## 3. Quotes / RFQ / Sales Orders
- Allowed: `app/(dashboard)/quotes/**`, `app/(dashboard)/rfq/**`, `app/(dashboard)/sales-orders/**`, `lib/quote-*`, `lib/rfq-*`, related
- Goal: Extract pricing, status, conversion logic.
- Current: `quotes/page.tsx` 108k.

## 4. Invoices / Delivery Notes / Purchase Orders / Payments / Receivables
- Allowed: `app/(dashboard)/invoices/**`, `app/(dashboard)/delivery-notes/**`, `app/(dashboard)/purchase-orders/**`, related lib files (`invoice-*`, `delivery-*`, `purchase-*`, `payments.ts`)
- Goal: Extract totals, linking, void/write-off, financial integrity. Lock after verification.
- Current: `invoices/page.tsx` 124k.

## 5. Customers / Suppliers
- Allowed: `app/(dashboard)/customers/**`, `app/(dashboard)/suppliers/**`, related lib
- Goal: Simple CRUD + linking. Low risk.

## 6. Integrations (Xero, AI, Email, M365, Costing Engine, Resend)
- Allowed: `lib/integrations/**`, `lib/ai/**`, `components/integrations/**`, related API routes, settings cards
- Goal: Isolated, off-by-default, feature-flagged per company. Deployed only when verified.
- Do not touch core financial or job logic.

## 7. Dashboard / Reports / Numbers / Shared UI
- Allowed: `app/(dashboard)/dashboard/**`, `app/(dashboard)/numbers/**`, `components/ui/**`, shared hooks, charts
- Goal: Read-only or thin. No business rules here.
- Reporting: revenue (PM-approved R0): `app/(dashboard)/reports/revenue/**`, `components/reports/revenue/**`, `lib/reports/revenue/**`. Read only, off by default, admin and office. Invoiced and cash basis shown separately and never added; quote pipeline never counted as revenue.
- Reporting, operations (#483, excluding revenue above): `app/(dashboard)/reports/page.tsx`, `components/reports/*` (cards and `reports-view.tsx`), `lib/reports/*` (`load-reports`, `reports-switch`, `on-time-completion`, `wip-ageing`, `machine-hours-variance`, `ncr-trend`, `last-despatch`). Read only (SELECT under the person's own session), off by default (`reports:on` marker in `hidden_nav`), admin and office. No costs shown. Figures come from `lib/jobs` functions (module 2); no business rules here beyond the report maths in `lib/reports`.

## 8. Database / Migrations / Releases
- Allowed: `supabase/**` ONLY when task explicitly says "migration allowed" and lists the file.
- Goal: Versioned, verified, never broken. Agents do not invent SQL.

## 9. ISO templates (PM-approved 6a)
- Allowed: `app/(dashboard)/admin/iso/**`, `components/iso/**`, `lib/iso/**`
- Goal: Admin-only, off by default, downloadable draft templates. No AI, no SQL, no saved documents. Outputs need company review and are not certification evidence.

## Shared
- `lib/utils.ts`, types, zod schemas: only if the task lists them.
- Prefer new files under `lib/<module>/` or `components/<module>/` for extractions.

Future-proof: Each module exposes a small set of functions. Other modules call them; they never import internals.
