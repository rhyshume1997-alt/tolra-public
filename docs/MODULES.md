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
- Allowed: `lib/integrations/**`, `lib/ai/**`, `lib/accounting/**`, `components/integrations/**`, `app/api/accounting/[provider]/[action]/route.ts`, related API routes, settings cards
- Goal: Isolated, off-by-default, feature-flagged per company. Deployed only when verified.
- Do not touch core financial or job logic.

## 7. Dashboard / Reports / Numbers / Shared UI
- Allowed: `app/(dashboard)/dashboard/**`, `app/(dashboard)/numbers/**`, `components/ui/**`, shared hooks, charts
- Goal: Read-only or thin. No business rules here.
- Reporting: revenue (PM-approved R0): `app/(dashboard)/reports/revenue/**`, `components/reports/revenue/**`, `lib/reports/revenue/**`. Read only, off by default, admin and office. Invoiced and cash basis shown separately and never added; quote pipeline never counted as revenue.
- Reporting, operations (#483, excluding revenue above): `app/(dashboard)/reports/page.tsx`, `components/reports/*` (cards and `reports-view.tsx`), top-level `lib/reports/*.ts` only, not `lib/reports/revenue/**` (`load-reports`, `reports-switch`, `on-time-completion`, `wip-ageing`, `machine-hours-variance`, `ncr-trend`, `last-despatch`). Read only (SELECT under the person's own session), off by default (`reports:on` marker in `hidden_nav`), admin and office. No costs shown. Figures come from `lib/jobs` functions (module 2); no business rules here beyond the report maths in `lib/reports`.

## 8. Database / Migrations / Releases
- Allowed: `supabase/**` ONLY when task explicitly says "migration allowed" and lists the file.
- Goal: Versioned, verified, never broken. Agents do not invent SQL.

## 9. ISO templates (PM-approved 6a)
- Allowed: `app/(dashboard)/admin/iso/**`, `components/iso/**`, `lib/iso/**`
- Goal: Admin-only, off by default, downloadable draft templates. No AI, no SQL, no saved documents. Outputs need company review and are not certification evidence.

## 10. Customer portal
- Allowed: `app/portal/**`, `app/api/portal/**`, `lib/portal/**`, `components/portal/**`, `tests/{unit,db,e2e}/portal-*`
- Goal: Customer sign-in, quotes and jobs view. Off by default: needs both the server flag `CUSTOMER_PORTAL_ENABLED` (exactly "true") AND the company switch. All authorisation lives in the release 154 functions (service role only).
- Rules: one generic refusal, and nothing ever says whether a contact, code, document or account exists. No TOTP. Never show the customer `sends` or `email`. Never log or audit an e-mail address, name, IP, code, ref or token. Sign-in e-mails go only through the platform's verified Resend sender (`EMAIL_FROM`); never through a company's Microsoft 365 mailbox and never written to `email_history`. The platform flag and the company switch are both enforced on the server before any portal work.
- Frozen elsewhere: `middleware.ts` belongs to module 1; any portal change to it is its own PR with explicit approval.

## 11. Tooly (scripted tours: admin, office, workshop)
- Allowed: `components/tooly/**` (the Tooly face and float; the tours are under `components/tooly/tour/**`), `tests/unit/tooly-*`
- Goal: a scripted tour per view that POINTS at screens and never clicks, saves or sends. Admin 23, office 17 and workshop 13 mandatory fixed steps (`tour-steps.ts`, `role-tour-steps.ts`); no AI, no quiz, no answers; works with AI off. A viewer has none.
- Off by default at two levels: the server env flag `TOOLY_ADMIN_TOUR_ENABLED` (exactly "true", one flag for all three views) AND the per-company marker of the view in `hidden_nav`: `tooly-admin-tour:on`, `tooly-office-tour:on`, `tooly-workshop-tour:on`. Each marker switches on only its own view. Both are enforced before the tour shows.
- First sign-in (module H): the tour opens by itself for a person who has not seen it (no extra switch; the two switches above still decide whether it exists). Each step has a closed-by-default note "What happens here and how it gets produced" (`tour-notes.ts`, one per step id, pinned by a test). "Skip tour" closes it and saves the seen flag. Once seen, a "Replay tour" button shows on the Dashboard only, inside `admin-tour.tsx` (never the float, sidebar or middleware); replay starts at step 1 and does not clear the flag.
- Saved "done" flag: module 1 (`lib/auth/tour-flag.ts`, auth user_metadata plus a browser copy). This module only calls it.
- Mounting the tour in the shell, the float and dialog layering belong to the Shell (module 7) and are their own PR. Quiz results need their own table later (not allowed here).

## 12. Issues (Raise an issue and the owner inbox; modules C and E, release 165)
- Allowed: `components/issues/**`, `lib/issues/**`, `components/platform/issues-inbox.tsx`, `app/platform/issues/**`, `app/api/platform/issues/**`, `supabase/**/165_*` and `owner_issues_165.sql`, `tests/{unit,db}/*issues*`, `tests/db/owner-issues-165.test.ts`
- Goal: any signed-in person (every role) can tell the Tolra team something went wrong; the platform owner triages across all companies. In-app only: no e-mail, no AI.
- Off by default at two levels: the per-company marker `issues:on` in `hidden_nav` (enforced by `raise_issue` in the database and hides the button) AND, for the owner inbox, the server env flag `OWNER_ISSUES_ENABLED` (exactly "true").
- Data: `public.issues` (companies read only their own, no direct writes) and `public.issue_owner_notes` (owner notes and PR link; no browser grant or policy). Writes go only through `raise_issue`, `platform_list_issues` and `platform_update_issue`.
- Shell mount: one line in `components/dashboard-shell.tsx` (module 7) renders `RaiseIssueButton`; nothing else in the shell changes. The `/platform/issues` page is reached by URL; linking it from the Companies screen (`app/platform/page.tsx`) is a separate change.

## Shared
- `lib/utils.ts`, types, zod schemas: only if the task lists them.
- Prefer new files under `lib/<module>/` or `components/<module>/` for extractions.

Future-proof: Each module exposes a small set of functions. Other modules call them; they never import internals.
