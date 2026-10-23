# Supabase SQL: setup, data move and verification

The browser talks to Supabase with the anon key, so row level security (RLS) is the authorisation layer.
**Apply each migration once, in order, and never re-run an older one on a database that already has later ones.**
Older files recreate legacy policies and helpers: re-running 001 or 005 brings back organisation-only `FOR ALL`
policies that widen access again (proven by `tests/db/catalogue.test.ts`), and re-running 006 would replace helpers
that 007, 009 and 012 redefined (and its own `COMMIT` means it can't be tried inside a transaction and rolled back). Fix a live
database with a new forward-only migration instead, and check what is really installed with the read-only
`verify/catalogue.sql` (compare its output with `tests/db/catalogue.snapshot.json`). `006_production_hardening.sql`
runs after 000 to 005 on a fresh database. `007_tenant_onboarding.sql` comes after 006 (then `008_org_logos.sql`, which only adds the logo bucket): 007 adds organisation memberships (one login, several organisations),
redefines the access helpers on top of them and replaces the `user_profiles` admin policies and guard.

The database is a generic multi-tenant product database: no migration contains data of any customer (tenant).
Tenants are created by the platform owner with `public.create_organization(...)` and people are added to them with
`public.add_member(...)` (007). One login can be a member of several organisations, with a role in each, and switches between them in the app.

All ids are `uuid`. Document numbers stay text (`quote_ref`, `invoice_ref`, `job_no`, `dn_number`, `so_number`, `po_ref`).

## Files

| File | Purpose |
|------|---------|
| `migrations/000_base_schema.sql` | Everything a fresh project needs before 001: extensions, organizations, user_profiles, the business tables, access helpers, RLS switched on, the append-only `security_audit` schema. **Replaces the three legacy root files.** |
| `migrations/001` to `005` | Customers/suppliers/quote line items/attachments, job worksheet, machine schedule, organization settings, invoice and delivery note line items. |
| `migrations/006_production_hardening.sql` | Role matrix policies, audit hardening, `next_doc_number`, `create_with_lines`, constraints, storage rules, company profile column, `reseed_doc_counters()`. Run after 000 to 005. |
| `migrations/007_tenant_onboarding.sql` | `organization_members` (+ backfill from existing profiles), access helpers based on the membership, `switch_organization()`, `my_organizations()`, `org_members()`, `set_member_access()`, `create_organization()`, `add_member()`, `organization_invites`, the `auth.users` trigger that turns pending invites into a profile and memberships, `platform_org_summary()`. |
| `migrations/008_org_logos.sql` | Private `org-logos` storage bucket for each organisation's document logo (`<organization_id>/...`, readable by its members, writable by its admins); removes logo paths that point outside the organisation's folder. Run after 007. |
| `migrations/009_job_values_and_profile_guard.sql` | Moves `jobs.value` into `job_values` (readable and writable by admin/office only; the workshop sees jobs but not their price) and lets only the person switch their own current organisation. Run after 008, then re-run `import/import_legacy_tenant.sql`. |
| `migrations/010_document_vat.sql` | VAT per document and per line: `vat_enabled` on quotes, invoices, sales orders and purchase orders; `vat_pct` / `vat_exempt` on quote and invoice lines and on sales orders (PO lines keep theirs in `items`); `carriage_vat` on invoices. Defaults match how existing documents were printed, so nothing is recalculated. The company switch and default rate live in `company_profile` (`vatRegistered`, `defaultVatRate`). |
| `migrations/011_usernames_and_login_limits.sql` | `user_profiles.username` (unique, lower-case, set only through the admin route; the profile guard refuses it from clients), `auth_rate_limits` + `auth_rate_hit()` (service role only; hashed keys) used by `/api/auth/signin` and `/api/auth/reset`, and `org_members()` with the username. Username lookup is server-side only: nothing anonymous can read usernames or e-mails. |
| `migrations/012_user_management.sql` | `user_profiles.must_change_password` (service role only), `organization_members.hidden_sections` + `section_allowed()` with RESTRICTIVE policies on quotes, quote lines/attachments, invoices, invoice lines, sales orders, purchase orders, RFQs and e-mail history; `set_member_access()` gains secondary role and hidden sections, blocks self-demotion and keeps one active admin (primary or secondary); trigger on `auth.users.last_sign_in_at` fills `last_login_at`; `org_members()` with the new fields. |
| `migrations/013_activity_trail.sql` | Row-change audit triggers on `quote_line_items`, `quote_attachments`, `invoice_line_items`, `delivery_note_items`, `machine_bookings`; helpers `security_audit.activity_parent/changes/snapshot/label` (field diffs, never whole rows); `record_activity(table, id)` checks the record's role / page access / organisation; `org_activity(...)` admin only. Nothing can update or delete `security_audit.audit_log`. |
| `migrations/014_password_setup_gate.sql` | A temporary password gives no business access: the access helpers (`current_user_organization_id`, `user_organization_id`, `current_user_role`, `current_user_secondary_role`, `has_org_role`) also require `must_change_password = false`, so every organisation-scoped policy, RPC and storage rule refuses until the person chooses their own password. Reading one's own profile and memberships still works. |
| `migrations/015_cross_org_link_guards.sql` | Same-organisation triggers (the existing `enforce_same_org_parent`) on the remaining business links: `quotes.rfq_id`, `sales_orders.quote_id/customer_id/converted_to_job_id`, `jobs.quote_id/converted_from_sales_order_id`, `invoices.job_id`, `delivery_notes.sales_order_id/customer_id`. Fire only when the link or organisation changes; NULL links, ON DELETE SET NULL and the deferrable order/job import pair are unchanged. Existing invalid links are reported as NOTICEs, never changed. |
| `verify/cross_org_links.sql` | Read-only: lists any business link pointing at another organisation's record. Expected: no rows. |
| `migrations/016_document_economics.sql` | `create_with_lines` (how the app creates quotes and invoices) refuses priced lines without a description, quantities of zero or with more than 3 decimal places, negative prices or prices with more than 2 decimal places, documents with no lines, and header totals that differ from what the stored lines add up to (same rounding policy as `lib/money.ts`). Delivery notes and existing documents are unchanged. |
| `verify/document_totals.sql` | Read-only: quotes and invoices whose stored totals differ from their lines under the current rounding policy. Historical facts to review, never to overwrite. |
| `migrations/017_session_and_deferred_link_checks.sql` | PostgREST pre-request check: a signed-in REST/RPC request whose session was revoked (sign-out, password change) is refused at once instead of when its token expires. Deferred constraint triggers re-check the deferrable order/job links at commit. |
| `verify/unmarked_bans.sql` | Read-only: banned logins without the app's deactivation marker, for the platform owner to review. |
| `migrations/018_atomic_order_conversion.sql` | `convert_sales_order(order)`: sales order to job in one transaction (row lock, returns the already-linked job on any retry, quote number J-#### when free, net value in `job_values`, quote line descriptions/quantities in the specification, no invented drawing). Unique index "one job per sales order", created only when no duplicates exist. |
| `verify/duplicate_conversions.sql` | Read-only: sales orders with more than one job. Expected: no rows. |
| `migrations/019_issued_document_history.sql` | `issuer_snapshot` / `customer_snapshot` on quotes and invoices, written by `create_with_lines` at issue (never from the caller); documents are inserted as drafts, lines added and checked, then issued in one transaction. Issued invoices: API users can't change amounts, customer, dates, terms, references, VAT settings, snapshots or lines, can't move them back to draft or delete them; status, payment and job link stay open. The database owner (imports, maintenance) is not restricted. |
| `migrations/020_quote_lifecycle.sql` | `accepted_at` / `rejected_at` on quotes; status moves forward only (draft -> sent -> accepted / rejected; decisions final); once not a draft, a quote's customer, value, VAT, terms, validity, description, customer notes, snapshots and lines are locked and it can't be deleted (internal notes and status stay open). API roles only; owner imports unaffected. |
| `migrations/021_draft_quote_correction.sql` | `replace_draft_quote(quote, expected_updated_at, header, lines)`: corrects a draft quote's header and lines in one transaction with the creation checks; refuses issued quotes and stale edits (HTTP 409). Line, totals and snapshot logic moved into shared functions (`check_priced_line`, `check_document_totals`, `org_standard_vat_rate`, `issuer_snapshot`, `customer_snapshot`) used by `create_with_lines` too (behaviour unchanged). |
| `migrations/022_worksheet_safety.sql` | `jobs.worksheet_version`, raised by a trigger whenever a worksheet field changes (stage/status changes don't; client values ignored), so saves can be compare-and-swap. `date_required` and `due_date` kept equal on every change and on insert. |
| `migrations/023_audit_event_rules.sql` | `audit_event_allowed(action, table)`; `write_audit` now refuses (42501) events the caller couldn't have performed: read events need read access to that kind of record, write events need write access, user management is admin-only, `CHANGE_OWN_PASSWORD` only about yourself. Trigger-written audit rows are unaffected. |
| `migrations/024_activity_money_redaction.sql` | `record_activity` removes money-named fields (value, price, cost, amount, total, VAT, paid, rate, ...) from changes, snapshots and metadata unless the caller is admin or office; an update that changed only money isn't shown to them. Stored audit rows are unchanged. |
| `migrations/025_job_email_quota.sql` | `security_audit.email_send_ledger` (insert-only, no API access) and `reserve_job_email()`: job e-mail limits (10/person/hour, 100/company/day) checked and reserved in one transaction under a per-company lock; deleting or editing `email_history` no longer resets them; a repeated request key returns the earlier attempt. |
| `migrations/026_delivery_note_email_record.sql` | `log_delivery_note_email()`: e-mail history and the note's `emailed_at` in one transaction, admin/office only; "copied" no longer marks the note as e-mailed. |
| `migrations/027_draft_issue_and_delivery.sql` | Invoices and purchase orders start as drafts. `issue_invoice()` gives a draft the next INV number (drafts never use one up), records issuer/customer and sets `issued`; issued invoices are owed whether or not e-mailed; `sent_date` records the confirmed send. POs: status `issued`, `sent_at`, issue lock (supplier, items, value fixed). Quotes and invoices can't leave draft unless their lines add up to their stored totals. `invoices.payment_unverified`: imported invoices without payment details aren't assumed unpaid (first run flags already-imported ones). |
| `import/export_legacy.sql` | Read-only. Run on the OLD single-tenant (JNREng) project; returns one JSON document with the data. |
| `import/import_legacy_tenant.sql` | Run on the NEW project; defines `public.import_legacy_tenant(jsonb, uuid)` (owner only): imports the export into one given organisation. |
| `fixtures/demo_documents.sql` | Anonymised sample paperwork (`public.load_demo_documents(org uuid)`). **Demo or staging only. Never in production.** |
| `verify/catalogue.sql` | Read-only fingerprint of RLS, policies, functions, triggers and API grants (md5 per definition). Run on any database to prove what is installed; a fresh 000 to latest build must match `tests/db/catalogue.snapshot.json`. |
| `config.toml` | Local disposable test stack only (`npm run test:backend`, see `docs/TESTING.md`). Never `supabase link` or `db push` from this directory. |
| `production-hardening.sql`, `iso-security-patch.sql`, `critical-prelaunch-security.sql` | **Legacy, only for the old JNREng project** (bigint ids). A new project must not run them. Kept for history. |

---

## Path A: set up a NEW product project and create tenants

1. Create the Supabase project. Note the project URL and the anon / service role keys.
2. In the SQL editor run, one file at a time and in this order:
   `000_base_schema.sql`, `001_customers_suppliers_quotes.sql`, `002_job_worksheet.sql`, `003_machine_schedule.sql`,
   `004_organization_settings.sql`, `005_document_fields.sql`, `006_production_hardening.sql`, `007_tenant_onboarding.sql`, `008_org_logos.sql`, `009_job_values_and_profile_guard.sql`, `010_document_vat.sql`, `011_usernames_and_login_limits.sql`, `012_user_management.sql`, `013_activity_trail.sql`, `014_password_setup_gate.sql`, `015_cross_org_link_guards.sql`, `016_document_economics.sql`, `017_session_and_deferred_link_checks.sql`, `018_atomic_order_conversion.sql`, `019_issued_document_history.sql`, `020_quote_lifecycle.sql`, `021_draft_quote_correction.sql`, `022_worksheet_safety.sql`, `023_audit_event_rules.sql`, `024_activity_money_redaction.sql`, `025_job_email_quota.sql`, `026_delivery_note_email_record.sql`, `027_draft_issue_and_delivery.sql`.
   Each file must finish without an error. 006 may print `NOTICE`s; a `WARNING` about duplicate numbers can only
   happen on a database that already holds data. After 007 the database has **no organisations and no users**.
3. Create each tenant (company) with `create_organization(name, slug, admin_email, company_profile)` and add the other
   people with `add_member(org_id, email, role)`. Only the platform owner can run them (SQL editor or service role;
   both are revoked from `anon` and `authenticated`). The slug must match `^[a-z0-9-]{2,48}$` and be unique.
   `create_organization` returns the new organisation id. This is the setup for JNR Engineering and Marpet, where
   **both** owner@tolra.example and admin2@tolra.example are admin of **both** organisations:
   ```sql
   select public.create_organization('JNR Engineering','jnr-engineering','owner@tolra.example',
     '{"name":"JNR Engineering","documentName":"JNR Engineering","addressLines":["PLACEHOLDER"],"vatNumber":"PLACEHOLDER"}'::jsonb);
   select public.add_member((select id from organizations where slug='jnr-engineering'),'admin2@tolra.example','admin');
   select public.create_organization('Marpet','marpet','owner@tolra.example',
     '{"name":"Marpet","documentName":"Marpet","addressLines":["PLACEHOLDER"],"vatNumber":"PLACEHOLDER"}'::jsonb);
   select public.add_member((select id from organizations where slug='marpet'),'admin2@tolra.example','admin');
   ```
   The placeholders (`documentName`, `addressLines`, `vatNumber`, and optionally `phone`, `email`, `website`,
   `defaultQuoteTerms`, ...) are for the owner to edit later in the app under Settings > Company details (documents
   refuse to print until `documentName`, `addressLines` and `vatNumber` are set). `company_profile` is optional
   (defaults to `{}`; `name` defaults to the organisation name).
   What the calls do:
   * `create_organization` creates the organisation (`status = 'active'`) and its `organization_settings` row with the
     profile, then adds the given e-mail as `admin`;
   * `add_member` adds (or updates) a member with the given role (`admin`, `office`, `workshop`, `viewer`) and returns
     `member` or `invited`;
   * if an `auth.users` row with that e-mail already exists (case-insensitive), the person gets an `organization_members`
     row for the organisation. Their `user_profiles` row is created if they have none, with this organisation as their
     **current** organisation; if they already have a profile it stays as it is (their current organisation is not
     changed unless it is unusable). Being a member of another organisation is fine;
   * if the person has no account yet, a row is stored in `organization_invites` (`organization_id, email, role`; one per
     organisation and e-mail). When their `auth.users` row is created (Authentication > Users > Invite, or sign-up) the
     `on_auth_user_created_apply_invite` trigger creates their profile (current organisation = the first invite,
     `full_name` from the user metadata) and a membership for **every** pending invite of that e-mail, deletes the
     invites and never blocks the sign-up, even if it fails (it only logs a warning).
   Invite the first admin under Authentication > Users > Invite user (the second admin the same way, or they already exist).
   Everyone after that is invited from the app (Admin > Users), which adds the membership itself (the trigger and the
   app do not conflict). Inviting an e-mail that already has a login in another organisation simply adds them here.
   **Switching:** a person who belongs to more than one organisation gets an organisation selector at the top of the
   sidebar and picks the organisation to work in (it calls `switch_organization`; the app then reloads at the dashboard).
   Their role, and everything they can see, follows the membership of the organisation they are in. Admins manage
   members of their current organisation only (Admin > Users); deactivating someone there leaves their other
   organisations alone.
4. Overview of all tenants (owner only): `select * from public.platform_org_summary();`
5. Optional, demo or staging only: `supabase/fixtures/demo_documents.sql`, then
   `select public.load_demo_documents((select id from public.organizations where slug = 'my-demo-tenant'));`. Never in production.
6. Run the verification queries below and the role-matrix test plan.

Running 000 to 007 a second time is safe (idempotent). Applying 007 to a database that already has profiles creates a
membership for each of them in their current organisation (same roles), so nobody loses access.

---

## Path B: import a JNREng-format export into a tenant of the new project

JNREng holds **test and demo records only**; records kept in another system need their own route (see the private repository's docs), and this importer cannot read them. Path B is the tested route for a JNREng-format export (used for the rehearsals). JNREng is only ever **read** and stays untouched.

1. Build the new project with **Path A steps 1 to 3**, creating the JNR organisation (slug `jnr-engineering`).
   Do not load the demo fixtures.
2. Make sure the users exist on the new project (Authentication > Users > Invite) with the **same e-mail addresses** they
   had on JNREng. They get new auth ids; the importer matches profiles to them by e-mail (case-insensitive), gives each
   profile its new id and gives it a membership (`organization_members`, with the legacy role) in the JNR organisation; a person
   who already has a profile elsewhere keeps that current organisation and just gains the membership. A profile whose e-mail is not in the new project is
   skipped and listed in the report; invite that user and run the import again, it only adds what is missing.
3. On the new project run all of `import/import_legacy_tenant.sql` once (it creates `legacy_import_map`,
   `legacy_audit_log` and the function; it imports nothing yet).
4. On **JNREng** run `import/export_legacy.sql` (a single read-only SELECT). Copy the single result cell.
5. On the **new** project run (paste the JSON between the `$json$` markers):
   ```sql
   select public.import_legacy_tenant($json$ ...the JSON... $json$::jsonb,
                                      (select id from public.organizations where slug = 'jnr-engineering'));
   ```
   The legacy organisation id is not assumed to exist: every imported row gets `organization_id` = the target
   organisation. The call runs in one transaction (all or nothing) and returns a JSON report: counts per table (`read`, `inserted`,
   `already_imported`, `matched_existing`, `skipped`), line items created, `unmatched_profiles`, `skipped`, `notes`
   and the `doc_counters`. Read it. Running it again imports nothing twice.
6. Run the verification queries below.
7. Switch the production site over (see "Cut-over" below).

What the import does:

| Legacy (JNREng) | New |
|-----------------|-----|
| bigint ids | fresh uuid per row; the mapping is kept in `legacy_import_map(source, old_id, new_id)` |
| `jobs.job_ref` | `jobs.job_no` |
| `delivery_notes.dn_ref`, `.job_id` (text), `.signed_by` | `dn_number`, `job_ref` (job number), `signed_by_name` |
| `sales_orders.order_ref`, `.expected_delivery`, `.quote_id` (text) | `so_number`, `delivery_date`, `quote_id` (uuid, re-pointed; `quote_ref` filled) |
| `quotes.sent_date`, one description/quantity/material/unit_price | `sent_at`; one `quote_line_items` row |
| `invoices.paid_date`, one description/quantity/unit_price | `paid_at`, `invoice_date`, `amount_paid` (= total when paid); one `invoice_line_items` row (VAT % from vat / subtotal) |
| `delivery_notes.items` (jsonb) | `delivery_note_items` rows |
| `purchase_orders.po_ref`, `items` jsonb | `po_ref` + `po_number`, `items` stays jsonb |
| `jobs.quote_id`, `invoices.job_id`, `jobs.converted_from_sales_order_id`, `sales_orders.converted_to_job_id`, `quotes.rfq_id` | re-pointed to the new uuids |
| `email_history.related_to_id`, `.drafted_by` | re-pointed to the new uuid / new user (empty when the user was not imported) |
| `created_by` / `updated_by` | the new user with the same e-mail, else empty |
| `user_profiles.id` | the new `auth.users.id` found by e-mail |
| `security_audit.audit_log` | `public.legacy_audit_log` (read-only archive, organisation admins can read it) |
| legacy organization id | not created; all rows go to the `p_target_org` organisation |

`created_at` / `updated_at` are kept. `quotes.material` is appended to the line description; `quotes.quantity` and
`unit_price` become the line quantity and price. Legacy document numbers (e.g. `JNR-Q-357`, `INV-2026-426`) are kept
unchanged. Because they do not match `PREFIX-digits`, the next numbers issued by the app start at `QUO-0001`, `INV-0001`,
`J-0001`, `PO-0001`. To continue an old sequence instead, raise the counter by hand (only if you want that):
```sql
insert into public.doc_counters (organization_id, prefix, last) values ((select id from public.organizations where slug = 'jnr-engineering'), 'QUO', 357)
on conflict (organization_id, prefix) do update set last = greatest(public.doc_counters.last, excluded.last);
```
The import calls `public.reseed_doc_counters()` itself. Call it again (`select public.reseed_doc_counters();`, owner
only) after any other bulk load.

The importer writes through the normal tables, so the new audit trail gets one `INSERT` row per imported row (actor
empty = SQL editor). The old hash chain cannot be validated after a move, which is why the old rows are archived
separately in `legacy_audit_log` rather than appended to the new chain.

### Verification queries after the import

```sql
-- 1. Counts: compare with the "counts" block at the top of the exported JSON (minus skipped profiles)
select 'organizations' t, count(*) from public.organizations union all
select 'user_profiles', count(*) from public.user_profiles union all
select 'customers', count(*) from public.customers union all
select 'suppliers', count(*) from public.suppliers union all
select 'stock', count(*) from public.stock union all
select 'rfqs', count(*) from public.rfqs union all
select 'quotes', count(*) from public.quotes union all
select 'quote_line_items', count(*) from public.quote_line_items union all
select 'invoices', count(*) from public.invoices union all
select 'invoice_line_items', count(*) from public.invoice_line_items union all
select 'jobs', count(*) from public.jobs union all
select 'sales_orders', count(*) from public.sales_orders union all
select 'purchase_orders', count(*) from public.purchase_orders union all
select 'delivery_notes', count(*) from public.delivery_notes union all
select 'email_history', count(*) from public.email_history union all
select 'legacy_audit_log', count(*) from public.legacy_audit_log;

-- 2. Every imported row has exactly one mapping, per table
select source, count(*) from public.legacy_import_map group by source order by source;

-- 3. Links re-pointed: these must return 0 rows
select j.job_no from public.jobs j where j.quote_ref is not null and j.quote_id is null and j.converted_from_sales_order_id is null;
select i.invoice_ref from public.invoices i where i.job_id is not null and not exists (select 1 from public.jobs j where j.id = i.job_id);
select so.so_number from public.sales_orders so where so.converted_to_job_id is not null and not exists (select 1 from public.jobs j where j.id = so.converted_to_job_id);

-- 4. Documents without a line item (quotes/invoices that had no description, price or quantity); review by hand
select quote_ref from public.quotes q where not exists (select 1 from public.quote_line_items l where l.quote_id = q.id);
select invoice_ref from public.invoices i where not exists (select 1 from public.invoice_line_items l where l.invoice_id = i.id);

-- 5. Totals still add up (header total vs sum of lines; small rounding differences come from the old unit_price)
select q.quote_ref, q.total_value, sum(l.quantity * l.unit_price) as lines_total
from public.quotes q join public.quote_line_items l on l.quote_id = q.id group by q.id having abs(q.total_value - sum(l.quantity * l.unit_price)) > 0.5;

-- 6. Profiles and next numbers
select u.email, o.slug, m.role, m.active, (p.organization_id = o.id) as is_current
from public.organization_members m join auth.users u on u.id = m.user_id join public.organizations o on o.id = m.organization_id
join public.user_profiles p on p.id = m.user_id order by 1, 2;
select * from public.doc_counters;
```

### Cut-over (planned, at merge time; for records kept in another system see the private repository's docs, not this)

1. Create the new project, create the JNR organisation, run Path B steps 2 to 6 ahead of time as a rehearsal (the import is repeatable: run it again
   right before the switch to pick up newer JNREng rows, nothing is duplicated; a row that changed on JNREng after it
   was first imported is **not** updated).
2. Freeze JNREng (stop entering data), export again, run the import again, verify.
3. Change the production site's environment variables to the new project (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) and set the Auth site URL / redirect URLs of the new
   project to the production domain; merge and deploy the branch.
4. Users sign in through the invitation e-mail (set a password) on the new project. JNREng remains the rollback:
   point the variables back at it and deploy `main`.

---

## Verification after running the migrations

```sql
-- 1. Every policy on the public tables (look for any without has_org_role on business tables)
select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public' order by 1,2;

-- 2. Must return 0 rows: legacy or non-role policies left on business tables
select tablename, policyname from pg_policies
where schemaname='public'
  and tablename in ('customers','suppliers','stock','rfqs','quotes','jobs','invoices','machines','quote_line_items',
                    'quote_attachments','invoice_line_items','sales_orders','purchase_orders','delivery_notes',
                    'delivery_note_items','email_history')
  and policyname not like '% rbac %';

-- 3. Tables in public without RLS (expect none, apart from views)
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;

-- 4. Unique number indexes that failed because of duplicates (expect 6 rows; fewer means duplicates exist, see WARNINGs)
select indexname from pg_indexes where schemaname='public' and indexname like '%\_org\_uniq';

-- 5. Constraints still NOT VALID (validate after cleaning old data: ALTER TABLE .. VALIDATE CONSTRAINT ..)
select conrelid::regclass, conname from pg_constraint where contype='c' and not convalidated;

-- 6. anon must have no access (expect false everywhere)
select has_table_privilege('anon','public.organizations','select'), has_table_privilege('anon','public.quotes','select'),
       has_function_privilege('anon','public.next_doc_number(text)','execute'),
       has_function_privilege('anon','public.create_organization(text,text,text,jsonb)','execute'),
       has_function_privilege('authenticated','public.import_legacy_tenant(jsonb,uuid)','execute');   -- last one only after import_legacy_tenant.sql
```

## What 006 does
1. Access helpers (`current_user_organization_id`, `user_organization_id`, `current_user_role`, `has_org_role`) only
   resolve for `user_profiles.active` users of an organization with `status = 'active'`. Anon cannot execute them.
2. `organizations`: RLS on, members read their own row, admins may rename it (column `name` only), anon revoked, no insert/delete.
3. Removes **every** policy on the business tables and recreates one role-checked policy per command
   (matrix in the file header). Viewers can never delete. `email_history` insert requires `drafted_by = auth.uid()`.
4. Audit: `security_audit` grants, `set_audit_hash` as SECURITY DEFINER with a per-organization advisory lock,
   `log_row_change` uses `auth.jwt() ->> 'email'`, new `public.write_audit(...)`; clients cannot write audit rows directly.
5. Document numbers: `doc_counters` + `public.next_doc_number(prefix)`; counters seeded by `public.reseed_doc_counters()`
   (owner only, re-runnable, never moves a counter backwards).
6. `public.create_with_lines(...)`: header and lines in one transaction (SECURITY INVOKER, RLS applies).
7. Unique per-organization document numbers (WARNING, not failure, if duplicates already exist).
8. CHECK constraints (NOT VALID, enforced for new rows), same-organization parent triggers, email_history status/type checks.
9. Storage: mime allow-list (pdf, png, jpeg, webp) and 20 MB cap; quote-attachments admin/office only.
10. `organization_settings.company_profile` (admin-only writes). Nothing is seeded.
11. Indexes. 12. Columns the app needs.

### RPCs for app code
```ts
await supabase.rpc('next_doc_number', { p_prefix: 'QUO' });   // 'QUO-0014'; prefixes QUO, INV, J, PO, RFQ
await supabase.rpc('create_with_lines', { p_parent: 'quotes', p_header: {...}, p_child: 'quote_line_items', p_fk: 'quote_id', p_lines: [{...}] }); // returns uuid
await supabase.rpc('write_audit', { p_action, p_entity_table, p_entity_id, p_old, p_new, p_metadata, p_ip, p_user_agent }); // organization and actor come from auth.uid()
```

## Role-matrix test plan (run in the SQL editor as postgres)

Pick one user per role in the same organization plus an admin in a second organization. Impersonate with:
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '<user uuid>', true);
-- statements to test
rollback;
```

| As | Statement | Expected |
|----|-----------|----------|
| viewer | `delete from invoices;` | 0 rows deleted (invoices still there) |
| viewer | `insert into invoices (organization_id, invoice_ref, total) values (<own org>, 'INV-9', 1);` | error: violates row-level security |
| viewer | `select count(*) from jobs;` | all jobs of own org |
| viewer | `select count(*) from quotes;` / `customers` / `invoices` | 0 |
| viewer | `delete from jobs;` / `insert into jobs ...` | 0 rows / error |
| viewer | `select next_doc_number('QUO');` | error: not authorised |
| viewer | `update user_profiles set role='admin' where id=<self>;` | error: only admins can change role... |
| office | `select count(*) from invoices;` / `sales_orders` | 0 |
| office | insert/update/delete on quotes, customers, rfqs | allowed |
| office | `delete from jobs;` | 0 rows (admin only) |
| workshop | insert/update jobs and delivery_notes | allowed |
| workshop | `delete from delivery_notes;`, `select from quotes` | 0 rows / 0 |
| admin | all of the above | allowed |
| admin | `select count(*) from legacy_audit_log;` (after the import) | the archived rows of own organization |
| admin of org B | `select * from quotes` | only org B rows; update/delete of org A rows touches 0 rows |
| any | `update user_profiles set active=false where id=<user>;` then the user queries | everything returns 0 / errors |
| any | `update organizations set status='paused' where id=<org>;` then queries | everything returns 0 / errors (reset to 'active' after) |
| anon | `select * from organizations;` | permission denied |
| any signed-in user | `select public.create_organization(...)` / `select public.import_legacy_tenant(...)` / `select public.platform_org_summary();` / `select public.reseed_doc_counters();` | permission denied |
