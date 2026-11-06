# Preliminary representative-role and release verification

PRELIMINARY until a final reviewed candidate SHA is known. This separate branch continues #460's test integration; no candidate, #454, #455 or Code branch is edited. Exact source SHA is recorded by each Actions run. Real Supabase/Auth/Postgres/app are disposable; all business data and users are synthetic. Xero/Microsoft/AI/email providers are mocked, with browser provider interception and host IPv4/IPv6 egress restrictions during execution.

This job reuses existing reviewed tests unchanged. It is not a new framework, provider activation or substitute for a final candidate run. Listing the cases is setup only; the workflow must execute all **163 database** and **47 browser** cases with no failures/skips/flaky cases. Backend unavailability or a missing result fails the job.

| Requested area | Executed suite files |
| --- | --- |
| 143 rates, historical snapshots, exact pennies, missing costs | `tests/db/costing-rates-143.test.ts`, `costing-save-143.test.ts`, `job-profitability-148.test.ts`; `tests/e2e/quote-pricing-costing.spec.ts` |
| Xero invitation identity, expiry, revocation, late writes, concurrency, permissions | `tests/db/xero-invite-151.test.ts`, `xero-invite-store-picker-151.test.ts`, `xero-invite-late-write-151.test.ts`, `xero-invite-cancel-during-callback-151.test.ts`, `xero-151-permissions.test.ts`; `tests/e2e/integrations-connect.spec.ts` |
| Xero stays OFF and held documents stay held | `tests/db/xero-launch-hold-149.test.ts`; `tests/e2e/integrations-guided-setup.spec.ts` |
| AI cap/key changes and default-OFF connection cards | `tests/db/ai-cap-key-off-150.test.ts`; `tests/e2e/ai-helper.spec.ts`, `integrations-guided-setup.spec.ts` |
| Microsoft/Resend cards and configuration/connection refusal | `tests/e2e/integrations-guided-setup.spec.ts`, `integrations-connect.spec.ts` |
| Admin, office, workshop, viewer, anonymous, two-company isolation and MFA | `tests/e2e/roles.spec.ts`, `admin-mfa.spec.ts`; database role matrices above |
| Workshop sign-in, machine schedule and inspection authority/revision rules | `tests/e2e/roles.spec.ts`, `schedule.spec.ts`, `inspection.spec.ts`, `inspectors.spec.ts` |
| Admin/office/workshop print restrictions, worksheet packs, revisions and phone layout | `tests/e2e/print-layout-settings.spec.ts`, `worksheet.spec.ts` |

The database suite can intentionally roll release fixtures back; the workflow restores only missing 145–151 fixtures and verifies every active row before building the browser app. Existing 143/148/149/150/151 definitions, grants, RLS, MFA, release order and preflight pins remain intact. No test is disabled or relaxed.

Run the explicit commands in `.github/workflows/builder3-representative-roles.yml` against a fresh `npm run test:backend` stack. Do not run write tests on hosted/real databases or reuse an occupied test stack. `CI` web checks still supply unit/typecheck/lint/build; the draft merge gate is separate and is not claimed green when full candidate integration has not run.

Results and unresolved failures belong to the exact run's artifact/PR receipt, not this plan. Final candidate, live provider delivery/consent, actual workshop hardware, physical printers and human acceptance remain unchecked regardless of mocked-provider passes. Any blocked browser execution is reported as NOT RUN, never as a discovery pass.
