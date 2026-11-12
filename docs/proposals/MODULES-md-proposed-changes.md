# Proposed changes to docs/MODULES.md

**Status: proposal. `docs/MODULES.md` is unchanged.** Apply only after the ownership proposal beside this file is approved.

## Add three modules

- **CI and Engineering Tooling**: `.github/**`, `scripts/**`, test and lint configuration (`vitest*.ts`, `playwright*.ts`, `.eslintrc.json`, `tsconfig.json`), build configuration, `package.json` and the lockfile, the rules documents, and production configuration (`next.config.mjs`, `vercel.json`, both with mandatory owner approval), and the two scheduled dispatchers (`app/api/cron/daily/route.ts`, `app/api/cron/nightly/route.ts`), which coordinate work across modules while each scheduled operation keeps its own module.
- **Marketing and Public Website**: `app/page.tsx`, `app/privacy/**`, `app/robots.ts`, `app/sitemap.ts`, `components/marketing/**`, `lib/marketing.ts`, `public/**`.
- **Offline and PWA**: `lib/offline/**`, `app/sw.js/**`, `app/offline.html/**`, `app/manifest.webmanifest/**`, and the offline banner, sync status and PWA registration components.

## Change existing modules

- **Jobs / Schedule / Time / Workshop**: add `lib/jobs/**`, `components/jobs/**`, `components/time/**`, `components/workshop/**`.
- **Invoices / Delivery Notes / Purchase Orders / Payments / Receivables**: add chase business rules (`lib/chase/**`, `lib/chasing/**`, `lib/email/chase/**`, `components/chase/**`, `app/api/chase/**`) and the invoice, delivery note, purchase order and credit note PDF documents.
- **Integrations**: state that e-mail transport and provider connections live here, name a **Data Import** area (`lib/sliq-*`, `lib/import-*`, `components/sliq-import.tsx`, `components/data-import*.tsx`), and state that each provider folder is its own area, not one interchangeable boundary.
- **Dashboard / Reports / Numbers / Shared UI**: add the application shell (`app/layout.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`, `lib/chunk-reload.ts`, `lib/report-client-error.ts`, the shell components).
- **Auth / Company / Users / Admin**: name sign-in, MFA, company choice, settings and platform pages explicitly, and the scheduled-job security controls (`lib/server/cron-auth.ts`, `cron-pass.ts`, `cron-skip.ts`). Each scheduled job route keeps the module of the work it does.
- **Approval page** (`app/(dashboard)/approval/page.tsx`): Dashboard and Shared UI, as presentation and coordination only. Chase approval rules stay with Invoices and Receivables, job reopen approval rules with Jobs, and e-mail transport and draft sending with Integrations; the page is to use typed interfaces those modules expose.

## Replace the "Shared" paragraph

Replace "`lib/utils.ts`, types, zod schemas: only if the task lists them" with: shared files are the closed list of exact paths in the module registry; changing one needs the file in the PR allowlist, a task justification, a regression impact assessment and human owner approval. `lib/people.ts` and `lib/company-people.ts` are on that list.

## Replace "related components" and "related lib"

Each module lists explicit paths. Where a path is not yet verified, the registry marks it provisional and it is not enforced.

## Add test ownership rules

- A test accompanies the single implementation module it verifies.
- Every changed test is listed explicitly in the PR allowlist.
- A multi-module regression test may accompany one module task when it verifies that module's existing contract; it never authorises implementation changes in another module.
- Tests are not weakened, deleted or skipped without secure owner approval.
- Tests are not a Shared module.

## Add a pointer

State that `docs/modules.json` (once approved) is the machine-readable copy, and that a unit test keeps the two documents in step.

## Status wording

Use three statuses for every path: VERIFIED, PROVISIONAL and REQUIRES DECISION. Only VERIFIED boundaries may ever be enforced by CI.
