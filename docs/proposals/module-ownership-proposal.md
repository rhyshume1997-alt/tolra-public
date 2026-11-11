# Module ownership proposal

**Status: proposal for review. Not in force.** Nothing here changes `docs/MODULES.md`, and nothing here is enforced by CI. Baseline: `main` at `0cea2ee5` (11 November 2026). The machine-readable form is `modules-registry.proposed.json` beside this file; the proposed edits to `MODULES.md` are in `MODULES-md-proposed-changes.md`.

## How ownership was established

Each of the 1286 non-test files on `main` has one of four statuses:

| Status | Files | Meaning |
|---|---|---|
| As written | 602 | Matches a path named in `docs/MODULES.md` |
| Inspected | 107 | Read individually: stated purpose, importers and callers |
| **Provisional** | 577 | Matched by path pattern only. **Not verified. Must not be enforced.** |
| Undecided | 0 | Needs an owner decision (section 7) |

"Callers" below means files that import the file, grouped by the module they fall in under this proposal. For provisional callers that grouping is itself unverified, so counts are evidence, not proof.

## 1. Modules

| Module | Non-test files | Notes |
|---|---|---|
| Database and Releases | 436 | As written |
| Integrations | 213 | Providers, e-mail transport, AI, accounting, costing. Not one interchangeable boundary: each provider folder is its own area |
| CI and Engineering Tooling | 127 | New (approved 11 Nov). Workflows, scripts, test and build configuration, rules documents, production configuration |
| Auth and Company Administration | 111 | Sign-in, MFA, roles, users, company settings, platform owner |
| Jobs, Workshop and Time | 110 | Includes `lib/jobs/**` and `components/jobs/**`. Active NCR and planned-vs-actual work is not touched by this proposal |
| Dashboard and Shared UI | 94 | Includes the application shell (ruled 11 Nov): root layout, error boundaries, client error reporting, chunk reload |
| Invoices and Receivables | 82 | Includes chase business rules (ruled 11 Nov) |
| Marketing and Public Website | 36 | New (approved 11 Nov). Home page, privacy page, public assets. Separate from the application shell |
| Integrations: Data Import area | 22 | SliQ and spreadsheet import (ruled 11 Nov) |
| Quotes and RFQ | 20 |  |
| Offline and PWA | 14 | New (approved 11 Nov) |
| Restricted shared files | 14 | Named files only (section 3) |
| Customers and Suppliers | 7 |  |

Extraction order is unchanged: Jobs, then Invoices, then Quotes.

## 2. Rulings recorded (11 November 2026)

- Three new modules: CI and Engineering Tooling; Marketing and Public Website; Offline and PWA.
- Chase business rules (`lib/chase`, `lib/chasing`, `lib/email/chase`, `components/chase`, `app/api/chase`) belong to Invoices and Receivables. E-mail transport and provider connections stay in Integrations.
- SliQ import and data import are a named Data Import area inside Integrations.
- The application shell (root layouts, error boundaries, client error reporting, chunk reload) belongs to Dashboard and Shared UI. Marketing and Public Website stays separate.
- `next.config.mjs` and `vercel.json` belong to CI and Engineering Tooling and need mandatory owner approval. Security headers, cron schedules and deployment configuration are reviewed separately.
- No open Shared module. Shared files are a closed list of exact paths.

## 3. Restricted shared files

Exact paths only, no wildcards. Changing one needs all four: the file in the PR allowlist, a task justification, a regression impact assessment, and human owner approval.

| Path | Why it is shared |
|---|---|
| `lib/friendly-error.ts` | turns any error into a safe message; 87 importers in nine areas |
| `lib/fetch-all.ts` | pages through every row of a list; importers in six areas |
| `lib/db-features.ts` | detects which migrations the database has; importers in eight areas |
| `lib/db-missing.ts` | dependency-free "database does not have this yet" detection used by server and client code |
| `lib/demo.ts` | demo mode switch; importers in six areas |
| `lib/jnr-test-data.ts` | synthetic demo records loaded by four list pages |
| `lib/numbering.ts` | document numbering used by quotes, invoices and jobs |
| `lib/spreadsheet.ts` | CSV and spreadsheet writer; importers in seven areas |
| `lib/page-company.ts` | the company a page was opened for (company switch mid-form); importers in four areas |
| `lib/people.ts` | who-did-what names of the signed-in company; 24 importers in five areas |
| `lib/company-people.ts` | loads the company's people by name; importers in four areas |
| `types/index.ts` | shared record and role types; 10 importers across Auth, Jobs and the shell |
| `components/pdf/BaseDocumentPDF.tsx` | the one PDF layout every issued document prints through (quotes, invoices, credit notes, delivery notes, orders) |
| `components/pdf/pdf-totals.ts` | totals printed on every issued document |

Twelve files first proposed as shared were removed because inspection showed a single owner: `lib/compact-list-pref.ts` and `lib/use-database-has-073.ts` (Invoices), `lib/display-name.ts` and `lib/confirmed-user.ts` (Auth), and `lib/destinations.ts`, `lib/use-destinations.ts`, `lib/list-filter.ts`, `lib/view-mode.ts`, `lib/list-card-counts.ts`, `lib/empty-hints.ts`, `lib/use-saving.ts`, `lib/record-link.ts` (Dashboard and Shared UI, as list and navigation helpers).

## 4. Individually inspected files

| Path | Module | Confidence | Evidence |
|---|---|---|---|
| `DEPLOYS.md` | CI and Engineering Tooling | high | deploy log |
| `README.md` | CI and Engineering Tooling | high | repository documentation |
| `app/error.tsx` | Dashboard and Shared UI | high | application shell (ruled 11 Nov) |
| `app/global-error.tsx` | Dashboard and Shared UI | high | application shell (ruled 11 Nov) |
| `app/globals.css` | Dashboard and Shared UI | medium | styles for the whole application |
| `app/layout.tsx` | Dashboard and Shared UI | high | application shell (ruled 11 Nov) |
| `app/not-found.tsx` | Dashboard and Shared UI | high | application shell (ruled 11 Nov) |
| `components.json` | CI and Engineering Tooling | high | component generator configuration |
| `components/document-attachments.tsx` | Invoices and Receivables | high | correction: files on delivery notes and purchase orders; all 3 importers are Invoices pages |
| `components/pdf/CreditNotePDF.tsx` | Invoices and Receivables | medium | credit note document |
| `components/pdf/DeliveryNotePDF.tsx` | Invoices and Receivables | high | correction: all importers are Invoices code |
| `components/pdf/InvoicePDF.tsx` | Invoices and Receivables | high | correction: all importers are Invoices code |
| `components/pdf/PurchaseOrderPDF.tsx` | Invoices and Receivables | high | correction: all importers are Invoices code |
| `components/pdf/QuotePDF.tsx` | Quotes and RFQ | medium | quote document |
| `components/pdf/SalesOrderPDF.tsx` | Quotes and RFQ | medium | sales order document |
| `docs/handover/B5-FINANCIAL-415-e42d927.md` | CI and Engineering Tooling | high | dated handover or release note |
| `docs/handover/BUILDER-4-415-EMAIL-MFA-REVIEW.md` | CI and Engineering Tooling | high | dated handover or release note |
| `docs/handover/BUILDER-4-417-EMAIL-CI-CASES.md` | CI and Engineering Tooling | high | dated handover or release note |
| `docs/handover/EMAIL-READY-FOR-KEYS.md` | CI and Engineering Tooling | high | dated handover or release note |
| `docs/release/KNOWN-LIMITATIONS-AND-RECOVERY.md` | CI and Engineering Tooling | high | dated handover or release note |
| `docs/release/SLIQ-SCRATCH-REHEARSAL.md` | CI and Engineering Tooling | high | dated handover or release note |
| `lib/access-recheck.ts` | Auth and Company Administration | medium | re-checks access while the app stays open |
| `lib/add-machine-reason.ts` | Jobs, Workshop and Time | medium | callers: Jobs 1 |
| `lib/admin-user-save.ts` | Auth and Company Administration | medium | callers: Auth 1 |
| `lib/approval-queue.ts` | Integrations | medium | rule for "e-mails needing approval" (drafted, not snoozed); read by the approval page, the dashboard count and the sidebar badge |
| `lib/attention.ts` | Dashboard and Shared UI | medium | callers: Dashboard 1 |
| `lib/auth-links.ts` | Auth and Company Administration | high | callers: Auth 2 |
| `lib/auto-booking.ts` | Jobs, Workshop and Time | medium | machine bookings made when a job is saved |
| `lib/brand-pending.ts` | Dashboard and Shared UI | high | shell colours and placeholder until the company profile loads; all five component importers are shell files |
| `lib/branding.ts` | Auth and Company Administration | medium | sign-in page branding per company |
| `lib/chunk-reload.ts` | Dashboard and Shared UI | high | application shell (ruled 11 Nov) |
| `lib/compact-list-pref.ts` | Invoices and Receivables | medium | only importer is the Invoices compact list |
| `lib/company-access.ts` | Auth and Company Administration | high | callers: Auth 7 |
| `lib/company-form.ts` | Auth and Company Administration | medium | company settings form |
| `lib/company-sync.ts` | Auth and Company Administration | high | callers: Auth 2 |
| `lib/confirmed-user.ts` | Auth and Company Administration | medium | one auth-server confirmation of the signed-in user per page |
| `lib/costing.ts` | Integrations | medium | costing engine availability |
| `lib/delete-result.ts` | Invoices and Receivables | medium | callers: Invoices 1 |
| `lib/destinations.ts` | Dashboard and Shared UI | medium | which pages a shortcut may point at |
| `lib/display-name.ts` | Auth and Company Administration | medium | display names of company users; 3 of 5 importers are Auth |
| `lib/document-attachments.ts` | Invoices and Receivables | medium | files on delivery notes and purchase orders (migration 067) |
| `lib/document-integrity.ts` | Invoices and Receivables | medium | refuses to print a quote or invoice whose stored totals differ from its lines; imported only by the PDF layer, so a change affects Quotes documents too |
| `lib/document-snapshot.ts` | Invoices and Receivables | medium | callers: Invoices 4, Quotes 1 |
| `lib/drawing-revision.ts` | Jobs, Workshop and Time | medium | callers: Jobs 1 |
| `lib/empty-hints.ts` | Dashboard and Shared UI | medium | the one-line hint on an empty list |
| `lib/floor-attendance.ts` | Jobs, Workshop and Time | medium | Whole floor clocked-in count |
| `lib/global-search.ts` | Dashboard and Shared UI | medium | top-bar search |
| `lib/hand-made-delivery-note.ts` | Invoices and Receivables | medium | callers: Invoices 1 |
| `lib/inbox-auto-check.ts` | Integrations | medium | browser timer that asks POST /api/mail/check to read the company inbox; started by the shell, listened to by the RFQ page |
| `lib/inspectors.ts` | Jobs, Workshop and Time | medium | authorised inspectors for job inspection |
| `lib/list-card-counts.ts` | Dashboard and Shared UI | medium | Open / Done / Archived counts on list tabs |
| `lib/list-filter.ts` | Dashboard and Shared UI | medium | list-page filter from the URL |
| `lib/mask-email.ts` | Auth and Company Administration | medium | callers: Auth 1 |
| `lib/open-drafts.ts` | Invoices and Receivables | medium | the single rule for "an open draft invoice"; the dashboard only reads it |
| `lib/open-drawing.ts` | Jobs, Workshop and Time | medium | callers: Jobs 1 |
| `lib/order-from-quote.ts` | Quotes and RFQ | medium | callers: Quotes 1 |
| `lib/parts-quantity.ts` | Jobs, Workshop and Time | medium | callers: Jobs 1, unassigned 1 |
| `lib/payment-attempts.ts` | Invoices and Receivables | medium | callers: Invoices 1 |
| `lib/pdf-warm.ts` | Dashboard and Shared UI | medium | pre-fetches the export PDF code (lib/export-records); its only caller today is the Jobs page |
| `lib/photo-image.ts` | Jobs, Workshop and Time | medium | job photos prepared on the device |
| `lib/png.ts` | Auth and Company Administration | medium | callers: Auth 1 |
| `lib/range-label.ts` | Invoices and Receivables | medium | callers: Invoices 1 |
| `lib/record-link.ts` | Dashboard and Shared UI | low | direct links to one record by id |
| `lib/reopen-sign-off.ts` | Jobs, Workshop and Time | high | callers: Jobs 2 |
| `lib/report-client-error.ts` | Dashboard and Shared UI | high | application shell (ruled 11 Nov) |
| `lib/resend.ts` | Integrations | medium | Resend provider helper |
| `lib/run-bookings.ts` | Jobs, Workshop and Time | medium | callers: Jobs 1 |
| `lib/run-plan.ts` | Jobs, Workshop and Time | high | callers: Jobs 3, unassigned 1 |
| `lib/schedule-live.ts` | Jobs, Workshop and Time | high | callers: Jobs 3 |
| `lib/send-outcome.ts` | Integrations | high | callers: Integrations 2 |
| `lib/shell-status.ts` | Dashboard and Shared UI | high | callers: Dashboard 2, unassigned 1 |
| `lib/sign-in-access.ts` | Auth and Company Administration | high | callers: Auth 2 |
| `lib/snapshot-hash.ts` | Jobs, Workshop and Time | medium | callers: Jobs 1 |
| `lib/so-machines.ts` | Jobs, Workshop and Time | medium | callers: Jobs 3, Quotes 1 |
| `lib/sync-status.ts` | Offline and PWA | medium | callers: Offline 1 |
| `lib/use-database-has-067.ts` | Invoices and Receivables | high | callers: Invoices 2 |
| `lib/use-database-has-068.ts` | Quotes and RFQ | medium | callers: Quotes 1 |
| `lib/use-database-has-073.ts` | Invoices and Receivables | medium | asks whether migration 073 (invoice screen) is applied |
| `lib/use-database-has-075.ts` | Jobs, Workshop and Time | high | callers: Jobs 5 |
| `lib/use-destinations.ts` | Dashboard and Shared UI | medium | hook over lib/destinations |
| `lib/use-now.ts` | Jobs, Workshop and Time | medium | callers: Jobs 1 |
| `lib/use-saving.ts` | Dashboard and Shared UI | medium | double-submit guard hook used by forms in five areas |
| `lib/username.ts` | Auth and Company Administration | high | callers: Auth 3, unassigned 1 |
| `lib/view-mode.ts` | Dashboard and Shared UI | medium | cards / compact / table preference for list pages |
| `lib/who-when-load.ts` | Dashboard and Shared UI | medium | callers: Dashboard 1 |
| `lib/whole-floor.ts` | Jobs, Workshop and Time | medium | callers: Jobs 1 |
| `lib/working-hours.ts` | Jobs, Workshop and Time | medium | planned paid hours on the time screens |
| `next.config.mjs` | CI and Engineering Tooling | high | production configuration (ruled 11 Nov): security headers and CSP; OWNER APPROVAL MANDATORY |
| `package-lock.json` | CI and Engineering Tooling | high | lockfile |
| `package.json` | CI and Engineering Tooling | high | dependency manifest |
| `postcss.config.mjs` | CI and Engineering Tooling | high | build configuration |
| `tailwind.config.ts` | CI and Engineering Tooling | high | build configuration |
| `vercel.json` | CI and Engineering Tooling | high | production configuration (ruled 11 Nov): region and cron schedule; OWNER APPROVAL MANDATORY |

## 5. Targeted verification of path-based placements

The 509 code files placed by path pattern were checked against their importers. A conflict is a file whose importers (two or more) all sit in a different module. 148 of the 509 are in priority areas by path keyword (money, VAT, payments, auth, sessions, roles, tokens, audit, integrations, database client, PDF, import and export). 13 conflicts were found:

| Path | Placed in | All importers are in | Outcome |
|---|---|---|---|
| `components/ai-finance-check-panel.tsx` | Integrations | Invoices and Receivables | Left provisional: a component provided by one module and used on another module's pages |
| `components/document-attachments.tsx` | Dashboard and Shared UI | Invoices and Receivables | Corrected to Invoices |
| `components/email/send-email-button.tsx` | Integrations | Invoices and Receivables | Left provisional: a component provided by one module and used on another module's pages |
| `components/inbound-email-links.tsx` | Integrations | Quotes and RFQ | Left provisional: a component provided by one module and used on another module's pages |
| `components/job-picker.tsx` | Jobs, Workshop and Time | Invoices and Receivables | Left provisional: a component provided by one module and used on another module's pages |
| `components/pdf/DeliveryNotePDF.tsx` | Dashboard and Shared UI | Invoices and Receivables | Corrected to Invoices |
| `components/pdf/InvoicePDF.tsx` | Dashboard and Shared UI | Invoices and Receivables | Corrected to Invoices |
| `components/pdf/PurchaseOrderPDF.tsx` | Dashboard and Shared UI | Invoices and Receivables | Corrected to Invoices |
| `components/print-layout-picker.tsx` | Dashboard and Shared UI | Jobs, Workshop and Time | Left provisional: a component provided by one module and used on another module's pages |
| `lib/ai-helper/tolra-caps.ts` | Integrations | Auth and Company Administration | Left provisional: a component provided by one module and used on another module's pages |
| `lib/server/cron-auth.ts` | Auth and Company Administration | Integrations | Undecided (section 7) |
| `lib/server/cron-pass.ts` | Auth and Company Administration | Integrations | Undecided (section 7) |
| `lib/server/cron-skip.ts` | Auth and Company Administration | Integrations | Undecided (section 7) |

Everything else placed by pattern stays **provisional**.

## 6. Test ownership rules

- A test accompanies the single implementation module it verifies.
- Every changed test is listed explicitly in the PR allowlist.
- A multi-module regression test may accompany one module task when it verifies that module's existing contract; it never authorises implementation changes in another module.
- Tests are not weakened, deleted or skipped without secure owner approval.
- Tests are not a Shared module.

Measured on `main`: 310 test files reference one module, 292 reference several, 219 reference no source file (database and browser tests) and 282 files under `tests/` are support code, fixtures or notes. Inheritance alone therefore does not place most test files; the explicit allowlist does.

## 7. Still needs an owner decision

- **app/(dashboard)/approval/page.tsx**: The approval page shows three things owned by different modules: chase approvals (Invoices), job reopen approvals (Jobs) and drafted e-mails (Integrations). It needs one owner or a split.
- **app/api/cron/** and lib/server/cron-*.ts**: Cron routes run e-mail, Xero, snapshot and purge jobs; lib/server/cron-auth.ts is their security control. All callers are cron routes. Owner: Integrations, Auth (as a security control) or CI and Engineering Tooling?
- **lib/people.ts and lib/company-people.ts**: On the restricted shared list because five areas import them, but their responsibility (the company's people) could make Auth and Company Administration the single owner.

## 8. What this proposal does not do

- It does not authorise CI enforcement. A future file-allowlist check must use only verified and approved boundaries.
- It does not change any application code, test, workflow or migration.
- It does not move or rename any file.
