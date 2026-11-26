# FK and trigger inventory from the REAL production schema (read-only queries, 26 Nov 2026)

Source: pg_constraint / pg_trigger on quoteflow-prod. Wipe tables = the 60 tables in wipe_operational_data.sql. Raw data: prod-fk-inventory.json, prod-triggers-on-wipe-tables.json (same folder).

## 1. Foreign keys INTO the wipe tables, auth.users and organizations: 325

| into | ON DELETE | count |
|---|---|---|
| auth | CASCADE | 18 |
| auth | NO ACTION | 2 |
| auth | RESTRICT | 9 |
| auth | SET NULL | 85 |
| organizations | CASCADE | 53 |
| organizations | NO ACTION | 63 |
| wipe tables | CASCADE | 43 |
| wipe tables | NO ACTION | 5 |
| wipe tables | RESTRICT | 15 |
| wipe tables | SET NULL | 32 |

### Flagged: CASCADE / SET NULL / SET DEFAULT from a table OUTSIDE the wipe list

**Into a wipe table (the only way a wipe can reach a table outside the list):** exactly one: `public.invoice_reminder_sends.invoice_id -> invoices` (CASCADE, no organization_id). Reviewed: reminder sends belong to the wiped invoices; the script counts them, lists them, and refuses any other such FK (guard v_fk_reviewed).

**Into auth.users (what deleting the 3 test users does to retained tables):**

| table | column | ON DELETE | has organization_id |
|---|---|---|---|
| auth.identities | user_id | CASCADE | False |
| auth.mfa_factors | user_id | CASCADE | False |
| auth.mfa_recovery_code_sets | user_id | CASCADE | False |
| auth.oauth_authorizations | user_id | CASCADE | False |
| auth.oauth_consents | user_id | CASCADE | False |
| auth.one_time_tokens | user_id | CASCADE | False |
| auth.scim_users | user_id | SET NULL | False |
| auth.sessions | user_id | CASCADE | False |
| auth.webauthn_challenges | user_id | CASCADE | False |
| auth.webauthn_credentials | user_id | CASCADE | False |
| public.attendance_event_network_ips | user_id | CASCADE | True |
| public.attendance_events | recorded_by | SET NULL | True |
| public.clock_in_network_exemptions | updated_by | SET NULL | True |
| public.clock_in_network_exemptions | user_id | CASCADE | True |
| public.clock_in_network_locks | locked_by | SET NULL | True |
| public.clock_in_network_refusals | user_id | CASCADE | True |
| public.import_mappings | updated_by | SET NULL | True |
| public.issues | user_id | SET NULL | True |
| public.organization_invites | created_by | SET NULL | True |
| public.organization_members | user_id | CASCADE | True |
| public.site_network_members | updated_by | SET NULL | True |
| public.site_network_members | user_id | CASCADE | True |
| public.site_network_names | renamed_by | SET NULL | True |
| public.site_network_ops | created_by | SET NULL | True |
| public.site_network_settings | updated_by | SET NULL | True |
| public.site_networks | created_by | SET NULL | True |
| public.time_day_flag_ops | created_by | SET NULL | True |
| public.time_day_flags | updated_by | SET NULL | True |
| public.time_settings | updated_by | SET NULL | True |
| public.time_sync_rejections | resolved_by | SET NULL | True |
| public.time_week_approvals | approved_by | SET NULL | True |
| public.user_preferences | user_id | CASCADE | False |
| public.user_profiles | id | CASCADE | True |
| security_audit.platform_admins | user_id | CASCADE | False |
| security_audit.session_company | user_id | CASCADE | True |

Actual rows that reference the 3 users (production, counted): organization_members 4 (CASCADE, expected), user_profiles 3 (CASCADE), site_network_members 1 (CASCADE, retained table: that one row goes with the user), jobs.assigned_to 1 and jobs.finished_by 1 (SET NULL, jobs are wiped anyway), security_audit.audit_log.actor_user_id 6 (no FK, rows stay). auth.sessions / identities / mfa rows cascade with the user (auth schema).

**Into organizations (deleting the empty live company):** 63 NO ACTION, 53 CASCADE. The live company has 0 rows in every NO ACTION table except security_audit.audit_log (2 rows, owner-approved delete, hash chain verified).

## 2. Triggers on the wipe tables: 332 user triggers

Delete-time triggers other than the three always-on guards (support read-only, admin MFA, audit log_row_change): **21**.

| table.trigger | function | timing | decision | why |
|---|---|---|---|---|
| credit_note_lines.credit_note_lines_issue_lock | credit_note_lines_issue_lock | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| credit_notes.credit_notes_issue_lock | credit_note_issue_lock | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| customers.customers_in_use_guard | customers_in_use_guard | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| delivery_note_items.delivery_note_items_link_guard | delivery_note_items_link_guard | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| delivery_notes.delivery_notes_link_guard | delivery_notes_link_guard | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| document_attachments.document_attachments_guard | document_attachments_guard | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| import_batches.import_batches_immutable | import_batches_immutable | BEFORE | DISABLED for the transaction, re-enabled and asserted | refuses any change/removal of committed or undo import batches, even for the owner |
| import_source_batches.import_source_batches_immutable | import_source_batches_immutable | BEFORE | DISABLED for the transaction, re-enabled and asserted | always raises |
| import_source_rows.import_source_rows_guard | import_source_rows_guard | BEFORE | DISABLED for the transaction, re-enabled and asserted | refuses updates; delete path checked by the rehearsal |
| invoice_line_items.invoice_lines_issue_lock | invoice_lines_issue_lock | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| invoice_line_items.invoice_lines_within_despatched | invoice_lines_within_despatched | AFTER | DISABLED for the transaction, re-enabled and asserted | AFTER trigger that rewrites order-line despatch state when a linked line is deleted |
| invoices.invoice_issue_lock | invoice_issue_lock | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| job_files.job_files_guard | job_files_guard | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| job_flow_events.job_flow_events_immutable | job_flow_events_immutable | BEFORE | DISABLED for the transaction, re-enabled and asserted | always raises (history is immutable) |
| job_inspections.job_inspections_immutable | job_inspections_immutable | BEFORE | DISABLED for the transaction, re-enabled and asserted | always raises (inspection records) |
| job_signoffs.job_signoffs_immutable | job_signoffs_immutable | BEFORE | DISABLED for the transaction, re-enabled and asserted | always raises (sign-offs) |
| purchase_orders.purchase_order_issue_lock | purchase_order_issue_lock | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| quote_line_items.quote_lines_issue_lock | quote_lines_issue_lock | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| quotes.quote_lifecycle_guard | quote_lifecycle_guard | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |
| quotes.quote_revision_withdrawn | quote_revision_withdrawn | AFTER | DISABLED for the transaction, re-enabled and asserted | AFTER delete: updates the previous quote version's status (writes another row) |
| suppliers.suppliers_in_use_guard | suppliers_in_use_guard | BEFORE | left ENABLED (lets non-browser roles through; the script refuses to run as anon/authenticated; proven by the rehearsal) | role-conditioned guard: only the browser roles anon/authenticated are held to it |

Any other delete-firing trigger that appears on a wipe table makes the script refuse (unreviewed trigger). Insert/update-only triggers are never touched; cyclic tables are deleted in one statement so no update trigger is needed.
