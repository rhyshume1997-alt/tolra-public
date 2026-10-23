# quoteflow-prod setup: run order

Run each file in the Supabase **SQL Editor** (New query → paste → Run) for the project named on the step.
Each must finish without a red error. If one fails, stop and report the error text.

Note: the old **JNREng** project (steps 04 to 06a) holds test and demo records only. Records kept in another system need their own route (see the private repository's docs).

Run `migrations/000` … `006` on quoteflow-prod first.

| # | Project | File | What it does | Expected result |
|---|---|---|---|---|
| A | quoteflow-prod | `supabase/migrations/007_tenant_onboarding.sql` | Multi-company memberships, switcher functions, tenant onboarding | Success |
| B | quoteflow-prod | `supabase/import/import_legacy_tenant.sql` | Defines the import function (imports nothing) | Success |
| 01 | quoteflow-prod | `supabase/setup/01_harden_function_grants.sql` | Closes functions Supabase opens to everyone by default | One empty result table ("function_still_open_to_anon", 0 rows) |
| 02 | quoteflow-prod | `supabase/setup/02_verify_007.sql` | Read-only checks | 20 rows, column **ok** = `true` on every row |
| 03 | quoteflow-prod | `supabase/setup/03_create_organizations.sql` | Creates JNR Engineering + Marpet; both emails invited as admin of both | 2 rows: jnr-engineering and marpet, `pending_invites` = 2 each |
| 04 | **JNREng** (old) | `supabase/setup/04_export_from_jnreng.sql` | Read-only export (JSON in one cell) | 1 row, 1 cell. Copy the cell |
| 05 | quoteflow-prod | `supabase/setup/05_import_into_quoteflow_prod.sql` | Paste the cell from 04 where marked, then run | A JSON report with `"ok": true` |
| 06a | **JNREng** (old) | `supabase/setup/06a_counts_jnreng.sql` | Read-only counts | 12 rows |
| 06b | quoteflow-prod | `supabase/setup/06b_counts_quoteflow_prod.sql` | Read-only counts per company | JNR column = 06a for every table (audit_log → legacy_audit_log); Marpet column all 0 except invites |
| 08 | quoteflow-prod | `supabase/migrations/008_org_logos.sql` | Private `org-logos` bucket (one folder per company, admins upload) and clears old bundled-file logo paths | 1 row: `bucket_public` = false, `policies` = 4, `foreign_logo_paths` = 0 |
| 09 | quoteflow-prod | `supabase/migrations/009_job_values_and_profile_guard.sql` | Job prices move to `job_values` (admin/office only); only the person can switch their own current company | 1 row: `jobs_value_column` = 0, `job_values_policies` = 4, `job_values_rows` = number of jobs that had a value |
| 09b | quoteflow-prod | `supabase/import/import_legacy_tenant.sql` (run the whole file again) | Updates the import function so the final data copy writes job prices to `job_values` | Success |
| 10 | quoteflow-prod | `supabase/migrations/010_document_vat.sql` | VAT options on documents: "Add VAT" per quote / invoice / sales order / PO, VAT rate per line, VAT on invoice carriage. Existing documents keep their totals | 1 row: `new_columns` = 10, then `invoices_with_carriage_vat`, `sales_orders_with_vat`, `purchase_orders_with_vat`, `quotes_without_vat` all 0 |
| 11 | quoteflow-prod | `supabase/migrations/011_usernames_and_login_limits.sql` | Sign-in usernames (set by admins in Admin > Users), sign-in/reset rate limits, `org_members()` returns the username | 1 row: `1 | 1 | true | false | false` |
| 12 | quoteflow-prod | `supabase/migrations/012_user_management.sql` | User management in the app: must-change-password flag, per-person page access (blocked in the database for quotes, invoices, sales orders, POs, RFQs, emails), secondary roles and safeguards in `set_member_access()`, last login filled from Supabase sign-ins | 1 row: `2 | 9 | 1 | 6 | N` (N = people who have ever signed in, 2 or more) |
| 13 | quoteflow-prod | `supabase/migrations/013_activity_trail.sql` | Activity trail: audit triggers on quote/invoice/delivery-note lines, quote attachments and machine bookings; `record_activity()` (per-record timeline, same access as the record) and `org_activity()` (admin Activity page) | 1 row: `5 | 2 | 1 | false` |

Checks:
- step 02 gives 20 true;
- the import report lists the rows read per table; the second company gets 0 rows, and a re-import adds 0.

In the step 05 report, legacy logins with no matching sign-in on the new project are listed under `unmatched_profiles`; access comes from the step 03 invites instead. `@jnr.test` logins are test accounts and are left behind on purpose.

## After step 06: create the two logins (quoteflow-prod)
Authentication → Users → **Add user → Create new user**:
- `owner@tolra.example`, a strong password, **Auto Confirm User** ticked
- `admin2@tolra.example`, the same settings

When each login is created, the invites from step 03 turn into admin memberships of **both** companies. JNR is the starting company. Re-run 06b: `members (admin)` = 2 for each company and `pending invites` = 0.

Logo: sign in, pick the company in the sidebar, then Settings → Company details → **Upload logo** (PNG or JPG, up to 1 MB). Each company uploads its own; a company without one prints its name instead.

Email links (recommended): Authentication → Emails → Templates → **Reset password**, set the link to `{{ .SiteURL }}/auth/set-password?token_hash={{ .TokenHash }}&type=recovery` so a reset link works on any device (by default it only works in the browser that asked for it). Invite links already work. Details: `docs/GO-LIVE.md` step 1.4.

Then Authentication → **Sign In / Providers** → Email: turn **Allow new users to sign up** OFF. From then on, users are added from the app (Admin → Users) or by `add_member`.
