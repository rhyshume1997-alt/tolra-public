-- READ ONLY. Release preflight (docs/RELEASE-CHECKLIST.md, step 2). One query, one result table of check / value /
-- expected, so it works in the Supabase SQL editor (which shows only the last statement's result). Nothing is
-- written, no setting is changed. Run it on the test project first, then on production.
WITH me AS (
  SELECT r.rolname, r.rolsuper, r.rolcreaterole FROM pg_roles r WHERE r.rolname = current_user
),
hooks AS (
  SELECT string_agg(
           CASE WHEN s.setrole = 0 THEN 'database-wide' ELSE 'role ' || s.setrole::regrole::TEXT END
           || CASE WHEN s.setdatabase = 0 THEN '' ELSE ' in ' || (SELECT datname FROM pg_database WHERE oid = s.setdatabase) END
           || ': ' || split_part(cfg, '=', 2), '; ' ORDER BY cfg) AS v
  FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
  WHERE cfg LIKE 'pgrst.db_pre_request=%'
),
pgrst_settings AS (
  SELECT string_agg(cfg, '; ' ORDER BY cfg) AS v
  FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
  WHERE cfg LIKE 'pgrst.%'
),
fn AS (
  SELECT p.proname, n.nspname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit')
),
col AS (
  SELECT table_name, column_name FROM information_schema.columns WHERE table_schema IN ('public', 'security_audit')
),
markers(migration, present) AS (
  VALUES
    ('013 activity trail',                 EXISTS (SELECT 1 FROM fn WHERE proname = 'org_activity')),
    ('014 password set-up gate',           EXISTS (SELECT 1 FROM fn WHERE proname = 'current_user_organization_id' AND (prosrc ILIKE '%must_change_password%' OR prosrc ILIKE '%_session_membership%'))),
    ('015 same-company link triggers',     EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_same_org_rfq_id')),
    ('016 document line checks',           EXISTS (SELECT 1 FROM fn WHERE proname IN ('create_with_lines', 'check_priced_line') AND prosrc ILIKE '%decimal%')),
    ('017 session check + deferred links', EXISTS (SELECT 1 FROM fn WHERE proname = 'check_request_session')),
    ('018 atomic order conversion',        EXISTS (SELECT 1 FROM fn WHERE proname = 'convert_sales_order')),
    ('019 issued document history',        EXISTS (SELECT 1 FROM col WHERE table_name = 'invoices' AND column_name = 'issuer_snapshot')),
    ('020 quote lifecycle',                EXISTS (SELECT 1 FROM col WHERE table_name = 'quotes' AND column_name = 'accepted_at')),
    ('021 draft quote correction',         EXISTS (SELECT 1 FROM fn WHERE proname = 'replace_draft_quote')),
    ('022 worksheet safety',               EXISTS (SELECT 1 FROM col WHERE table_name = 'jobs' AND column_name = 'worksheet_version')),
    ('023 audit event rules',              EXISTS (SELECT 1 FROM fn WHERE proname = 'audit_event_allowed')),
    ('024 activity money redaction',       EXISTS (SELECT 1 FROM fn WHERE proname = 'redact_money')),
    ('025 job e-mail quota',               EXISTS (SELECT 1 FROM col WHERE table_name = 'email_send_ledger')),
    ('026 delivery note e-mail record',    EXISTS (SELECT 1 FROM fn WHERE proname = 'log_delivery_note_email')),
    ('027 drafts, issue, delivery',        EXISTS (SELECT 1 FROM fn WHERE proname = 'issue_invoice')),
    ('028 archive (never delete)',         EXISTS (SELECT 1 FROM fn WHERE proname = 'set_archive_state')),
    ('029 job inspection step',            EXISTS (SELECT 1 FROM col WHERE table_name = 'jobs' AND column_name = 'inspected_at')),
    ('030 totals follow VAT registration', EXISTS (SELECT 1 FROM fn WHERE proname = 'org_vat_registered')),
    ('031 inbound mail',                   EXISTS (SELECT 1 FROM fn WHERE proname = 'record_inbound_email')),
    ('032 invoice part payments',          EXISTS (SELECT 1 FROM fn WHERE proname = 'record_invoice_payment')),
    ('033 pre-launch hardening',           EXISTS (SELECT 1 FROM fn WHERE proname = 'resolve_job_email')),
    ('034 workflow day-one gaps',          EXISTS (SELECT 1 FROM fn WHERE proname = 'audit_event_allowed' AND prosrc LIKE '%''invoices'' THEN ARRAY[''admin'', ''office'']%')),
    ('035 who did what',                   EXISTS (SELECT 1 FROM fn WHERE proname = 'company_people')),
    ('036 two-level access',               EXISTS (SELECT 1 FROM fn WHERE proname = 'platform_enter_organization')),
    ('037 failed inspection and rework',   EXISTS (SELECT 1 FROM fn WHERE proname = 'open_replacement_rework')),
    ('038 booking day plan',               EXISTS (SELECT 1 FROM col WHERE table_name = 'machine_bookings' AND column_name = 'day_plan')),
    ('039 platform new company audited',   EXISTS (SELECT 1 FROM fn WHERE proname = 'platform_create_organization')),
    ('040 job photos',                     EXISTS (SELECT 1 FROM fn WHERE proname = 'finalise_job_photo')),
    ('042 internal jobs and machines',     EXISTS (SELECT 1 FROM fn WHERE proname = 'create_job')),
    ('043 sales order machines',           EXISTS (SELECT 1 FROM fn WHERE proname = 'set_job_machines')),
    ('044 machine runs',                   EXISTS (SELECT 1 FROM fn WHERE proname = 'start_machine_run')),
    ('045 job sign-off',                   EXISTS (SELECT 1 FROM fn WHERE proname = 'sign_off_job')),
    ('046 bench pause',                    EXISTS (SELECT 1 FROM fn WHERE proname = 'bench_runs_state')),
    ('049 paused-machine acknowledgement', EXISTS (SELECT 1 FROM fn WHERE proname = 'acknowledge_paused_machine')),
    ('050 attendance',                     EXISTS (SELECT 1 FROM fn WHERE proname = 'record_attendance_event') AND EXISTS (SELECT 1 FROM col WHERE table_name = 'time_settings' AND column_name = 'breaks_paid')),
    ('051 job labour',                     EXISTS (SELECT 1 FROM fn WHERE proname = 'record_labour_event') AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_machine_runs_labour')),
    ('052 weekly review and approval',     EXISTS (SELECT 1 FROM fn WHERE proname = 'approve_time_week') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'time_week_locked' AND prosrc LIKE '%time_week_approvals%')),
    ('058 quote to job',                   EXISTS (SELECT 1 FROM fn WHERE proname = 'accept_quote')),
    ('059 delivery note auto invoice',     EXISTS (SELECT 1 FROM fn WHERE proname = 'uninvoiced_delivery_notes')),
    ('061 auto book next free slot',       EXISTS (SELECT 1 FROM fn WHERE proname = 'machine_next_free_start')),
    ('064 booking run identity',           EXISTS (SELECT 1 FROM fn WHERE proname = 'guard_booking_run_identity') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'guard_run_booking_identity')),
    ('065 admin MFA onboarding',           EXISTS (SELECT 1 FROM fn WHERE proname = 'organizations_require_admin_mfa_guard') AND EXISTS (SELECT 1 FROM col WHERE table_name = 'organization_members' AND column_name = 'mfa_enrolment_required')),
    ('066 company access',                 EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_set_company_access') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'my_admin_companies') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'set_member_access' AND prosrc LIKE '%''last_company''%')),
    ('067 document attachments',           EXISTS (SELECT 1 FROM fn WHERE proname = 'replace_draft_invoice') AND EXISTS (SELECT 1 FROM col WHERE table_name = 'document_attachments' AND column_name = 'storage_path')),
    ('068 quote versions',                 EXISTS (SELECT 1 FROM fn WHERE proname = 'revise_quote') AND EXISTS (SELECT 1 FROM col WHERE table_name = 'quote_line_items' AND column_name = 'declined')),
    ('072 customer sign-off',              EXISTS (SELECT 1 FROM fn WHERE proname = 'sign_off_job_customer') AND EXISTS (SELECT 1 FROM col WHERE table_name = 'organization_settings' AND column_name = 'customer_signoff_enabled')),
    ('073 invoice screen',                 EXISTS (SELECT 1 FROM fn WHERE proname = 'void_invoice') AND EXISTS (SELECT 1 FROM col WHERE table_name = 'invoices' AND column_name = 'invoice_note')),
    ('074 day flags on the job sheet',     EXISTS (SELECT 1 FROM fn WHERE proname = 'set_time_day_flags') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'time_week_revision' AND prosrc LIKE '%time_day_flags%')),
    ('075 site network, refused sync',     EXISTS (SELECT 1 FROM fn WHERE proname = 'report_time_sync_rejection') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'add_site_network') AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_attendance_events_network')),
    ('076 data import',                    EXISTS (SELECT 1 FROM fn WHERE proname = 'import_company_data') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'import_undo') AND to_regclass('public.import_runs') IS NOT NULL AND EXISTS (SELECT 1 FROM fn WHERE proname = 'invoice_issue_lock' AND prosrc LIKE '%quoteflow.data_import_undo%')),
    ('077 audit hash index lookup',        EXISTS (SELECT 1 FROM fn WHERE nspname = 'security_audit' AND proname = 'set_audit_hash' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '5f4b0bcedcdf8a8c044e2e78a88a7221')),
    ('078 ip retention, CRD numbers',     EXISTS (SELECT 1 FROM fn WHERE proname = 'purge_site_network_ips') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'next_doc_number' AND prosrc LIKE '%''CRD''%') AND to_regclass('public.attendance_event_network_ips') IS NOT NULL),
    -- 085 keeps 079's WHERE TRUE in the body it extends: either body means 079 is applied.,
    ('079 import under pg-safeupdate',    EXISTS (SELECT 1 FROM fn WHERE proname = 'import_company_data_run' AND md5(regexp_replace(prosrc, '\s', '', 'g')) IN ('f7c672e961be898619c046d76458680e', '0a2fec5746b0b1262cb2af6fe792bd7c'))),
    ('080 activity labels, job work',     EXISTS (SELECT 1 FROM fn WHERE proname = 'convert_sales_order' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = 'dc8165549871bd15047765ac4fba811e')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'security_audit' AND proname = 'activity_label' AND prosrc LIKE '%credit_ref%')),
    ('081 job flow and release',          EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'inspect_job')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'job_release_state' AND prosrc LIKE '%job_early_release_active%')),
    ('082 traceability, records, suppliers', EXISTS (SELECT 1 FROM fn WHERE proname = 'purchase_orders_supplier_status') AND EXISTS (SELECT 1 FROM fn WHERE proname = 'job_inspections_traceability')
                                          AND EXISTS (SELECT 1 FROM col WHERE table_name = 'suppliers' AND column_name = 'supplier_status') AND EXISTS (SELECT 1 FROM col WHERE table_name = 'jobs' AND column_name = 'traceable')),
    ('083 authorised inspectors',         EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'set_authorised_inspector') AND to_regclass('public.inspector_authorisations') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'inspection_pass_authorised')),
    ('084 integrations (Xero)',           EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'integration_claim_next') AND to_regclass('public.integration_sends') IS NOT NULL
                                          AND to_regclass('public.integration_secrets') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_integration_enqueue')),
    ('085 import: credit and delivery notes', EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'import_people_guard')
                                          AND EXISTS (SELECT 1 FROM col WHERE table_name = 'invoices' AND column_name = 'sent_by_name')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'import_company_data_run' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '0a2fec5746b0b1262cb2af6fe792bd7c')),
    ('088 converted sales order guard',  EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'sales_orders_converted_money_guard')
                                          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_converted_order_money' AND tgrelid = 'public.sales_orders'::regclass)
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'jobs_converted_order_link_guard')
                                          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_converted_order_link' AND tgrelid = 'public.jobs'::regclass)),
    ('089 invoice receipt guard',         EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'invoice_receipts_guard')
                                          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_invoice_receipts' AND tgrelid = 'public.invoices'::regclass)),
    ('090 clock action in its own company', EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)')
                                          AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b27723bfaaf334678d8d23bb1c1f0756')),
    ('091 invoice issue guard',           EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'invoice_issue_guard')
                                          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_invoice_via_issue' AND tgrelid = 'public.invoices'::regclass)),
    ('092 release ends job time',         EXISTS (SELECT 1 FROM col WHERE table_name = 'operator_sessions' AND column_name = 'end_reason')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'machine_runs_labour' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '48f0b169d1beb1de9976f542ac182b3e')),
    ('093 platform owner login protected', EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'admin_login_is_protected')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'admin_set_company_access' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '378818d240f26ff55595ff4168f7a40e')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'set_member_access' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '2fc2a6a96b80cc9f7a7f8baf9b67df04')),
    ('094 activity one row per change',   EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'org_activity' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = 'a29b5655c21474b4b40d54760de5a9c4')),
    ('095 finance check audit events',    EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'audit_event_allowed' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '7e8d396511ddb056daa61953bfccd12b')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'write_audit' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = 'a6531bb5559ae9936387729bb91071a0')),
    ('099 part despatch invoice quantity', EXISTS (SELECT 1 FROM col WHERE table_name = 'invoice_line_items' AND column_name = 'sales_order_line_id')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'job_finish_draft_invoice' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '8c4d3694cec4ac679916f916afc41985')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'replace_draft_invoice' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '8e8e4cc70d1cd7ad4c3268c49e52f305')),
    ('100 customer archive',              EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'set_archive_state' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '0b3bc80a57f0e0e16e4f0d7f42c5eccf')),
    ('101 ai helper',                     to_regclass('public.ai_helper_requests') IS NOT NULL AND to_regclass('public.ai_helper_secrets') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'ai_helper_reserve')),
    ('102 security guards',               EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'admin_may_edit_profile')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'organization_settings_guard_nav' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '99579bb09f2fcf9458103b3128af20c8')),
    ('103 ai helper service role',        EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'ai_helper_settle' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = 'ca5166191666584107491f95ccce4702')),
    ('105 invoice write-off',             EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'write_off_invoice' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = 'c7449f4564711533d43a1aa252eddfdf')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'reverse_write_off' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '4750ac042335694164b634edca559f23')
                                          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoices_write_off_guard' AND tgrelid = 'public.invoices'::regclass)),
    ('106 email templates',               to_regclass('public.email_templates') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM col WHERE table_name = 'ai_helper_settings' AND column_name = 'finance_check_enabled')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'ai_helper_set_finance_check')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'reserve_company_email')),
    ('107 integrations connect',          to_regclass('public.integration_app_credentials') IS NOT NULL AND to_regclass('public.integration_connect_invites') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'integration_invite_redeem')),
    ('108 email schedules',               to_regclass('public.email_schedules') IS NOT NULL AND to_regclass('public.email_schedule_runs') IS NOT NULL
                                          AND to_regclass('public.invoice_reminder_sends') IS NOT NULL AND to_regclass('public.timesheet_sends') IS NOT NULL),
    ('109 user date format',              to_regclass('public.user_preferences') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM col WHERE table_name = 'user_preferences' AND column_name = 'date_format')),
    ('110 rfq clarification in one step',  EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'log_rfq_clarification')),
    ('113 reopen sign-off',               to_regclass('public.reopen_requests') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'reopen_record')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'decide_reopen_request')),
    ('114 clock-in network lock',         to_regclass('public.clock_in_network_locks') IS NOT NULL AND to_regclass('public.clock_in_network_unverified') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clock_in_network_lock' AND tgrelid = to_regclass('public.attendance_events'))),
    ('115 browser error alert budget',    to_regclass('security_audit.browser_error_alerts') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'claim_browser_error_alert')),
    ('116 overview owed snapshots',       to_regclass('public.overview_owed_snapshots') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'capture_overview_owed')),
    ('117 job problems',                  to_regclass('public.job_problems') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'report_job_problem')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'resolve_job_problem')),
    ('118 job part logs',                 to_regclass('public.job_part_logs') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'log_job_parts')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'job_parts_done')),
    ('119 ban ends session',              EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'session_is_active' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = 'af6457cae4d8b89cd34b5963574fbe58')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = '_session_membership' AND md5(regexp_replace(prosrc, '\s', '', 'g')) IN ('dd70574344856582b9819431b45e6c5c', '4fa415c7b3222def6c37e93353e804c2'))),
    ('120 email history drafted_by lock', EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'email_history_drafted_by_lock' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '14f7b3e1e4488d7df58a5e72568d2e91')
                                          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'email_history_drafted_by_lock' AND tgrelid = 'public.email_history'::regclass)),
    ('121 rls helper speed',              EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = '_session_membership' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '4fa415c7b3222def6c37e93353e804c2')),
    ('122 ai helper cap default',         EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_status()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '3ef44c838451b46ea14030164d9b1384')),
    ('123 quote customer po',             EXISTS (SELECT 1 FROM col WHERE table_name = 'quotes' AND column_name = 'customer_po')
                                          AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_quote_customer_po(uuid, text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '00f8488bd689f3e473209d520218d402')),
    ('124 purchase order link',           to_regclass('public.purchase_orders') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM col WHERE table_name = 'purchase_orders' AND column_name = 'quote_id')
                                          AND EXISTS (SELECT 1 FROM col WHERE table_name = 'purchase_orders' AND column_name = 'job_id')
                                          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_same_org_job_id' AND tgrelid = to_regclass('public.purchase_orders'))
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'purchase_order_issue_lock' AND md5(regexp_replace(prosrc, '\s', '', 'g')) = '9f903e888bca6d55322cc877488c1019')),
    ('125 inbound email links',           EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.link_inbound_email(uuid, text, uuid, text, text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '2f7a1169a7087cf17a3f872a8f08a088')
                                          AND EXISTS (SELECT 1 FROM col WHERE table_name = 'inbound_emails' AND column_name = 'link_suggestions')),
    ('126 booking time zero quote guards', EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.delete_machine_booking(uuid)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '1fee96ce68caa2bcbf89f416587e75ba')
                                          AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.accept_quote(uuid, text, date, uuid[])') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '4f354d3878197aabe53db19807f99305')),
    ('127 mailbox read',                  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.mailbox_record_inbound(uuid,text,text,text,text,text,timestamp with time zone,text,text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '4a7ede00d54804941fc17a291bde6b4c')
                                          AND to_regclass('public.integration_mailbox_sync') IS NOT NULL
                                          AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.mailbox_sync_claim(uuid,integer)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'a9985b00301c4579f1f6797205c21834')),
    ('128 workshop network',              to_regclass('public.clock_in_network_refusals') IS NOT NULL AND to_regprocedure('public.rename_site_network(uuid,uuid,text)') IS NOT NULL
                                           AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.site_network_ip_purge(uuid,integer)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '53348dc930741ac3eae1ec3258337871')),
    ('129 accountant invite',             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organization_invites' AND column_name = 'token_hash')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'create_accountant_invite')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'redeem_accountant_invite')
                                          AND EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = 'handle_new_auth_user' AND position('ACCOUNTANT_INVITE_USED' IN prosrc) > 0)),
    ('131 rls select wrap',               EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invoices' AND p.policyname = 'invoices rbac select'
                                                 AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '6a18e9fed9ee8dd956c314df2b296562'))
),
checks(n, check_name, value, expected) AS (
  SELECT 1, 'postgres version', current_setting('server_version'), '17.x expected (local tests ran on 17.6); any other major: stop and report'
  UNION ALL SELECT 2, 'connected as', current_user || ' (superuser ' || (SELECT rolsuper FROM me)::TEXT || ', createrole ' || (SELECT rolcreaterole FROM me)::TEXT || ')', 'postgres; createrole true'
  UNION ALL SELECT 3, '017 needs: may change authenticator settings',
    (pg_has_role(current_user, 'authenticator', 'MEMBER WITH ADMIN OPTION') AND (SELECT rolcreaterole FROM me))::TEXT, 'true'
  UNION ALL SELECT 4, '017 needs: may read auth.sessions', has_table_privilege(current_user, 'auth.sessions', 'SELECT')::TEXT, 'true'
  UNION ALL SELECT 5, '017 needs: auth.sessions has id, user_id, not_after',
    (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'sessions' AND column_name IN ('id', 'user_id', 'not_after'))::TEXT, '3'
  UNION ALL SELECT 6, 'existing PostgREST request hooks', coalesce((SELECT v FROM hooks), 'none'),
    'none (before 017) or only public.check_request_session (after). Anything else: stop, 017 will refuse until both checks are combined'
  UNION ALL SELECT 7, 'all pgrst.* settings in the database', coalesce((SELECT v FROM pgrst_settings), 'none'), 'record for the release notes'
  UNION ALL SELECT 8, 'migration history table',
    CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN 'absent (migrations were applied by hand; use the markers below)'
         ELSE 'present (may not list hand-applied files; the markers below are authoritative)' END, 'informational'
  UNION ALL SELECT 9, '036 needs: may reference auth.sessions', has_table_privilege(current_user, 'auth.sessions', 'REFERENCES')::TEXT, 'true'
  UNION ALL SELECT 10, '040 needs: may read storage.objects past its row rules (finalise_job_photo checks the stored object)',
    (has_table_privilege(current_user, 'storage.objects', 'SELECT') AND (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user))::TEXT, 'true'
  UNION ALL SELECT 11, '065 needs: may read auth.mfa_factors (who has set up an authenticator app)',
    (to_regclass('auth.mfa_factors') IS NOT NULL AND has_table_privilege(current_user, 'auth.mfa_factors', 'SELECT'))::TEXT, 'true'
  UNION ALL SELECT 12, '077 needs: audit_log_org_created_idx is the valid (organization_id, created_at DESC) index',
    EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('security_audit.audit_log_org_created_idx') AND i.indisvalid AND i.indisready
            AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX audit_log_org_created_idx ON security_audit.audit_log USING btree (organization_id, created_at DESC)')::TEXT,
    'true (false: 077 would build it inside its transaction, holding audit writes for the build; RELEASE.md 077)'
  UNION ALL SELECT 13, '077 needs: security_audit.set_audit_hash is 006''s (or already 077''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'f52ea7c6a9b6178d866b73e7a84d784e' THEN '006' WHEN '5f4b0bcedcdf8a8c044e2e78a88a7221' THEN '077' ELSE 'other' END
              FROM fn WHERE nspname = 'security_audit' AND proname = 'set_audit_hash'), 'missing'),
    '006 before 077, 077 after (other: stop, 077 refuses to replace it)'
  UNION ALL SELECT 14, '078: audit rows already holding a clock-in address (075 check rows audited before 078; never rewritten)',
    (SELECT count(*) FROM security_audit.audit_log a WHERE a.entity_table = 'attendance_event_networks'
       AND (a.new_data ->> 'ip' IS NOT NULL OR a.old_data ->> 'ip' IS NOT NULL))::TEXT,
    '0 (the check was never switched on). More than 0: those copies stay in the hash-chained log for good; RELEASE.md 078, tell Rhys'
  UNION ALL SELECT 15, '078: check rows holding an address (078 moves those under 30 days old and clears the rest)',
    CASE WHEN to_regclass('public.attendance_event_networks') IS NULL THEN 'n/a (075 not applied)'
         ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public.attendance_event_networks WHERE ip IS NOT NULL', FALSE, TRUE, '')))[1]::TEXT END,
    '0 before 078 normally (check off by default); 0 after 078 always'
  UNION ALL SELECT 16, '078: highest credit note number per company (the next CRD carries on above it)',
    -- credit_notes is 034's: read through query_to_xml so the preflight still runs on an older database (the rehearsal's 013 base).
    CASE WHEN to_regclass('public.credit_notes') IS NULL THEN 'n/a (034 not applied)'
         ELSE coalesce((xpath('/row/top/text()', query_to_xml($q$SELECT string_agg(o.slug || ' ' || x.top, '; ' ORDER BY o.slug) AS top
              FROM (SELECT cn.organization_id, max(substring(cn.credit_ref FROM '^(?:CRD|CN)-(\d{1,9})$')::INT)::TEXT AS top
                    FROM public.credit_notes cn WHERE cn.credit_ref ~ '^(CRD|CN)-\d{1,9}$' GROUP BY cn.organization_id) x
              JOIN public.organizations o ON o.id = x.organization_id$q$, FALSE, TRUE, '')))[1]::TEXT, 'none') END,
    'informational; JNR: after S-day seed_credit_note_number(org, ''CRD-2166'') unless SliQ''s credit notes are in Tolra'
  UNION ALL SELECT 17, '079 needs: public.import_company_data_run is 076''s (or already 079''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '648b7e0652cf46eacf73685343ef9572' THEN '076' WHEN 'f7c672e961be898619c046d76458680e' THEN '079'
                                                                 WHEN '0a2fec5746b0b1262cb2af6fe792bd7c' THEN '085 (079 kept in it)' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'import_company_data_run'), 'missing'),
    '076 before 079, 079 after (085 after 085; other: stop, 079 refuses to replace it; missing: 076 not applied)'
  UNION ALL SELECT 18, '080 needs: public.org_activity is 035''s and public.convert_sales_order 068''s (or already 080''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '292d6e2612099e36dd107422bd50e1b5' THEN '035' WHEN 'ae7e2416ce0a54b0d8ccb721aeb2d245' THEN '080' WHEN 'a29b5655c21474b4b40d54760de5a9c4' THEN '094' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'org_activity'), 'missing') || ' / ' ||
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '5555212a1d32070ce74209e718c3896d' THEN '068' WHEN 'dc8165549871bd15047765ac4fba811e' THEN '080' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'convert_sales_order'), 'missing'),
    '035 / 068 before 080, 080 / 080 after (094 / 080 after 094; other: stop, 080 refuses to replace it)'
  UNION ALL SELECT 19, '080: jobs still described ''Converted from SO-...'' whose quote has ordered lines (080 describes them by that work)',
    -- quote_line_items.declined is 068's: read through query_to_xml so the preflight still runs on an older database (the rehearsal's 013 base).
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'quote_line_items' AND column_name = 'declined')
           OR NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'jobs' AND column_name = 'converted_from_sales_order_id') THEN 'n/a (068 not applied)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(DISTINCT j.id) || ' (' || coalesce(string_agg(DISTINCT j.job_no, ', '), '') || ')' AS n
              FROM public.jobs j
              JOIN public.sales_orders s ON s.organization_id = j.organization_id AND (s.id = j.converted_from_sales_order_id OR s.converted_to_job_id = j.id)
              WHERE s.quote_id IS NOT NULL AND j.description = 'Converted from ' || s.so_number
                AND EXISTS (SELECT 1 FROM public.quote_line_items l WHERE l.quote_id = s.quote_id AND l.organization_id = s.organization_id
                              AND NOT l.declined AND btrim(l.description) <> '')$q$, FALSE, TRUE, '')))[1]::TEXT, '0') END,
    'informational before 080 (JNR: at least J-0010; each gets its quote''s work and one more worksheet revision); 0 () after 080'
  UNION ALL SELECT 20, '081 needs: public.job_release_state is 037''s and public.delivery_note_try_draft 059''s (or already 081''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'a7454c7da7ee23564436acfa6a330cd6' THEN '037' WHEN 'c16ea537b0b5706ab6db6e160214e17d' THEN '081' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'job_release_state'), 'missing') || ' / ' ||
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'ef7acce200b6f0349c84f076725d77c1' THEN '059' WHEN '52a9771fec832f0e20e9d780e7561caa' THEN '081' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'delivery_note_try_draft'), 'missing'),
    '037 / 059 before 081, 081 / 081 after (other: stop, 081 refuses to replace it)'
  -- 081's rows below read tables of 029 to 059 through query_to_xml, so the preflight still runs on an older database (the rehearsal's 013 base).
  UNION ALL SELECT 21, '081: jobs by flow status (In progress, of them put back; Finished; Complete), worked out as 081''s flow_status(job) does',
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'jobs' AND column_name = 'inspected_at') THEN 'n/a (029 not applied)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT 'in progress ' || count(*) FILTER (WHERE stage IS NOT DISTINCT FROM 'rework' OR (inspected_at IS NULL AND finished_at IS NULL))
              || ' (put back ' || count(*) FILTER (WHERE stage IS NOT DISTINCT FROM 'rework') || '), finished '
              || count(*) FILTER (WHERE stage IS DISTINCT FROM 'rework' AND inspected_at IS NULL AND finished_at IS NOT NULL)
              || ', complete ' || count(*) FILTER (WHERE stage IS DISTINCT FROM 'rework' AND inspected_at IS NOT NULL) AS n FROM public.jobs$q$, FALSE, TRUE, '')))[1]::TEXT, '') END,
    'informational: Done on the board is Complete, Awaiting inspection is Finished, Rework is In progress put back; the same counts after 081'
  UNION ALL SELECT 22, '081: draft invoices for a job that isn''t Complete (they can be issued once it passes, or an admin releases it early)',
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'jobs' AND column_name = 'inspected_at') THEN 'n/a (029 not applied)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) || ' (' || coalesce(string_agg(j.job_no, ', ' ORDER BY j.job_no), '') || ')' AS n
              FROM public.invoices i JOIN public.jobs j ON j.id = i.job_id
              WHERE lower(coalesce(i.status, 'draft')) = 'draft' AND (j.inspected_at IS NULL OR j.stage IS NOT DISTINCT FROM 'rework')$q$, FALSE, TRUE, '')))[1]::TEXT, '0') END,
    'informational before 081 (each such draft waits for its job); the same after'
  UNION ALL SELECT 23, '081: delivery notes not sent out yet for a job that isn''t Complete (they can go out once it passes, or an admin releases it early)',
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'delivery_notes' AND column_name = 'job_id')
           OR NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'jobs' AND column_name = 'is_internal')
           OR NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'jobs' AND column_name = 'inspected_at') THEN 'n/a (029, 034 or 042 not applied)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) || ' (' || coalesce(string_agg(d.dn_number || ' ' || j.job_no, ', ' ORDER BY d.dn_number), '') || ')' AS n
              FROM public.delivery_notes d JOIN public.jobs j ON j.organization_id = d.organization_id
                AND (j.id = d.job_id OR (d.job_id IS NULL AND j.job_no = nullif(btrim(d.job_ref), '')))
              WHERE coalesce(d.status, '') NOT IN ('despatched', 'delivered', 'signed') AND NOT coalesce(j.is_internal, FALSE)
                AND (j.inspected_at IS NULL OR j.stage IS NOT DISTINCT FROM 'rework')$q$, FALSE, TRUE, '')))[1]::TEXT, '0') END,
    'informational before 081 (JNR: check none is waiting to go today; a part-failed job''s rest now needs an admin''s early release); the same after'
  UNION ALL SELECT 24, '081: jobs with more than one live draft invoice (081 makes no second one; existing ones stay as they are)',
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'invoices' AND column_name = 'job_id') THEN 'n/a'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) || ' (' || coalesce(string_agg(x.job_no, ', ' ORDER BY x.job_no), '') || ')' AS n
              FROM (SELECT j.job_no FROM public.invoices i JOIN public.jobs j ON j.id = i.job_id
                    WHERE lower(coalesce(i.status, 'draft')) = 'draft' GROUP BY j.id, j.job_no HAVING count(*) > 1) x$q$, FALSE, TRUE, '')))[1]::TEXT, '0') END,
    'informational before and after 081'
  UNION ALL SELECT 25, '082: suppliers by status (before 082 every existing supplier starts approved)',
    -- supplier_status is 082's: read through query_to_xml so the preflight still runs before it (and on the rehearsal's 013 base).
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'suppliers' AND column_name = 'supplier_status')
         THEN coalesce((xpath('/row/n/text()', query_to_xml('SELECT count(*) || '' (no status yet)'' AS n FROM public.suppliers', FALSE, TRUE, '')))[1]::TEXT, '0')
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT coalesce(string_agg(supplier_status || ' ' || n, ', ' ORDER BY supplier_status), 'none') AS n
              FROM (SELECT supplier_status, count(*) AS n FROM public.suppliers GROUP BY supplier_status) s$q$, FALSE, TRUE, '')))[1]::TEXT, 'none') END,
    'informational; after 082: approved N (every existing supplier), then as set on the Suppliers page'
  UNION ALL SELECT 30, '083: inspectors list: members ticked as inspectors / active admins not ticked (083 puts them on the list)',
    -- can_inspect (034) and support (036) read through query_to_xml so the preflight still runs on an older database (the rehearsal's 013 base).
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'organization_members' AND column_name = 'can_inspect')
           OR NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'organization_members' AND column_name = 'support') THEN 'n/a (034 or 036 not applied)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) FILTER (WHERE m.can_inspect) || ' / '
                || count(*) FILTER (WHERE m.active AND NOT m.support AND NOT m.can_inspect AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))) AS n
              FROM public.organization_members m$q$, FALSE, TRUE, '')))[1]::TEXT, '0 / 0') END,
    'informational before 083 (after 083 every admin who could record a pass is on the list: the second number is 0); n / 0 after 083'
  UNION ALL SELECT 31, '084: companies connected to an accounting system (084 adds Admin > Integrations; every company starts not connected)',
    -- integration_connections is 084's: read through query_to_xml so the preflight still runs before it (and on the rehearsal's 013 base).
    CASE WHEN to_regclass('public.integration_connections') IS NULL THEN 'n/a (before 084)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) FILTER (WHERE status = 'connected') || ' connected / '
                || count(*) FILTER (WHERE status = 'needs_reconnect') || ' to connect again' AS n FROM public.integration_connections$q$, FALSE, TRUE, '')))[1]::TEXT,
                       '0 connected / 0 to connect again') END,
    'informational; 0 connected / 0 to connect again right after 084 (an admin connects each company; nothing is sent until every VAT rate used is mapped)'
  UNION ALL SELECT 32, '085 needs: public.import_company_data_run is 079''s (or already 085''s); the four credit / delivery note guards 034''s / 037''s (or 085''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'f7c672e961be898619c046d76458680e' THEN '079' WHEN '0a2fec5746b0b1262cb2af6fe792bd7c' THEN '085' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'import_company_data_run'), 'missing')
    || ' / guards ' || (SELECT count(*) FROM fn WHERE nspname = 'public' AND md5(regexp_replace(prosrc, '\s', '', 'g')) IN ('fb8e80d48fc099c48df1e783baf29fc1', 'd044647b5c7768cea71ed0a869b29428', 'd785f434d829cb12f0f3eccbd8c73908', '699da71eb0c6c42410f94ca1e2ccb023'))::TEXT || ' before, '
    || (SELECT count(*) FROM fn WHERE nspname = 'public' AND md5(regexp_replace(prosrc, '\s', '', 'g')) IN ('8e0ff460c60a94bb1164dc39dd77aae1', '369bbaa5c6979d4bb9d70c5cbf68d9bd', '4c57607b1909f060d689df9ea5a99128', '612a2bc924a8ea1916ce1a66101ced97'))::TEXT || ' 085''s',
    '079 / guards 4 before, 0 085''s before 085; 085 / guards 0 before, 4 085''s after (other or fewer: stop, 085 refuses to replace them)'
  UNION ALL SELECT 33, '088: converted sales orders / of them whose value is not their job''s value (088 freezes a converted order''s value and VAT for signed-in users)',
    (SELECT count(*) || ' / ' || count(*) FILTER (WHERE v.job_id IS NOT NULL AND coalesce(so.total_value, 0) <> v.value)
     FROM public.sales_orders so LEFT JOIN public.job_values v ON v.job_id = so.converted_to_job_id
     WHERE so.converted_to_job_id IS NOT NULL),
    'informational, the same before and after 088 (a job''s value can be changed on the job; 088 changes no data)'
  UNION ALL SELECT 34, '089: draft invoices showing a payment, credit, refund, paid date or unverified flag / other invoices whose amount paid is not their recorded payments',
    CASE WHEN to_regclass('public.invoice_credit_allocations') IS NULL THEN 'n/a (before 034)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) FILTER (WHERE coalesce(i.status, 'draft') = 'draft'
                  AND (i.amount_paid <> 0 OR i.paid_at IS NOT NULL OR i.credited_amount <> 0 OR i.refunded_amount <> 0 OR i.payment_unverified))
                || ' / ' || count(*) FILTER (WHERE coalesce(i.status, 'draft') <> 'draft'
                  AND i.amount_paid IS DISTINCT FROM coalesce((SELECT sum(p.amount) FROM public.invoice_payments p WHERE p.invoice_id = i.id), 0)) AS n
                FROM public.invoices i$q$, FALSE, TRUE, '')))[1]::TEXT, '?') END,
    'informational, the same before and after 089 (089 changes no data); expected 0 / 0. A draft in the first figure can''t be issued after 089 until it is checked; the second: Record payment already refuses those'
  UNION ALL SELECT 35, '091: draft invoices that already carry an invoice number / draft invoices that carry an issue date or issuer',
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'invoices' AND column_name = 'issued_at') THEN 'n/a (before 035)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) FILTER (WHERE coalesce(i.status, 'draft') = 'draft' AND i.invoice_ref IS NOT NULL)
                || ' / ' || count(*) FILTER (WHERE coalesce(i.status, 'draft') = 'draft' AND (i.issued_at IS NOT NULL OR i.issued_by IS NOT NULL)) AS n
                FROM public.invoices i$q$, FALSE, TRUE, '')))[1]::TEXT, '?') END,
    'informational, the same before and after 091 (091 changes no data); expected 0 / 0. After 091 such a draft is issued only with Issue invoice, which gives it the next number in place of the one it carries'
  UNION ALL SELECT 36, '092: open job time sessions on a job whose latest run was ended by an admin''s Release machine (and nothing runs on it now)',
    CASE WHEN to_regclass('public.operator_sessions') IS NULL THEN 'n/a (before 051)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM public.operator_sessions s
                WHERE s.ended_at IS NULL AND s.voided_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.job_id = s.job_id AND r.ended_at IS NULL)
                  AND (SELECT r.end_reason FROM public.machine_runs r WHERE r.job_id = s.job_id AND r.ended_at IS NOT NULL
                       ORDER BY r.ended_at DESC LIMIT 1) = 'admin_released'$q$, FALSE, TRUE, '')))[1]::TEXT, '?') END,
    'informational, the same before and after 092 (092 changes no data and acts only on releases after it); such a session keeps counting until the person stops it or an admin corrects it: report the figure'
  UNION ALL SELECT 37, '093 needs: public.admin_set_company_access and set_member_access are 066''s (or already 093''s); admin_login_is_protected absent (or 093''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'a7f5c794e51fe1dc3c98bace9a5dd11d' THEN '066' WHEN '378818d240f26ff55595ff4168f7a40e' THEN '093' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'admin_set_company_access'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'e0031dfa2d9c89955a26119d3b65b307' THEN '066' WHEN '2fc2a6a96b80cc9f7a7f8baf9b67df04' THEN '093' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'set_member_access'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'a938b2269bd2554f36acf0beaf7bb8f3' THEN '093' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'admin_login_is_protected'), 'absent'),
    '066 / 066 / absent before 093; 093 / 093 / 093 after (other: stop, 093 refuses to replace it)'
  UNION ALL SELECT 38, '093 (informational): support rows whose window is over but still active / platform-owner logins with any support row',
    CASE WHEN to_regclass('security_audit.platform_admins') IS NULL OR NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'organization_members' AND column_name = 'support') THEN 'n/a (before 036)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT (SELECT count(*) FROM public.organization_members m WHERE m.support AND m.active AND m.expires_at <= now())
                || ' / ' || (SELECT count(DISTINCT m.user_id) FROM public.organization_members m JOIN security_audit.platform_admins a ON a.user_id = m.user_id WHERE m.support) AS n$q$,
                FALSE, TRUE, '')))[1]::TEXT, '?') END,
    'informational, the same before and after 093 (093 changes no row: such support rows stay, and from 093 count for nothing in Admin > Users): report the figures'
  UNION ALL SELECT 39, '094 needs: public.org_activity is 080''s (or already 094''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'ae7e2416ce0a54b0d8ccb721aeb2d245' THEN '080' WHEN 'a29b5655c21474b4b40d54760de5a9c4' THEN '094' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'org_activity'), 'missing'),
    '080 before 094, 094 after (other: stop, 094 refuses to replace it)'
  UNION ALL SELECT 40, '095 needs: public.audit_event_allowed is 076''s and write_audit 035''s (or already 095''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '35078684fa2379d7708c06fa7994dcf3' THEN '076' WHEN '7e8d396511ddb056daa61953bfccd12b' THEN '095' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'audit_event_allowed'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '959f759894cd9dbefbf8d25768530197' THEN '035' WHEN 'a6531bb5559ae9936387729bb91071a0' THEN '095' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'write_audit'), 'missing'),
    '076 / 035 before 095, 095 / 095 after (other: stop, 095 refuses to replace it). 39 is 094''s row'
  UNION ALL SELECT 41, '099 needs: invoice_from_delivery_notes_draft 059''s, job_finish_draft_invoice and delivery_note_try_draft 081''s, replace_draft_invoice 073''s (or already 099''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'cff9113a2490bda9b901764974adfa0a' THEN '059' WHEN 'd467a505ab13a1cc1b1fa51cd8922f58' THEN '099' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'invoice_from_delivery_notes_draft'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '492fa39d76311ecfc78ce860a5f1160b' THEN '081' WHEN '8c4d3694cec4ac679916f916afc41985' THEN '099' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'job_finish_draft_invoice'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '52a9771fec832f0e20e9d780e7561caa' THEN '081' WHEN 'c1464c01f419d1866e7143a41076e7d0' THEN '099' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'delivery_note_try_draft'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'bc56dd3aa75000c36f959955b71026ca' THEN '073' WHEN '8e8e4cc70d1cd7ad4c3268c49e52f305' THEN '099' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'replace_draft_invoice'), 'missing'),
    '059 / 081 / 081 / 073 before 099, 099 / 099 / 099 / 099 after (other: stop, 099 refuses to replace it)'
  UNION ALL SELECT 42, '099 (informational): live Job Finish invoices made by 081 (from 099 they count the whole order as invoiced) / all live invoices',
    CASE WHEN to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)') IS NULL THEN 'n/a (before 081)'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT (SELECT count(DISTINCT i.id) FROM security_audit.audit_log a JOIN public.invoices i ON i.id::TEXT = a.metadata ->> 'invoice_id'
                WHERE a.action = 'JOB_DRAFT_INVOICE' AND a.metadata ->> 'outcome' = 'drafted' AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled'))
                || ' / ' || (SELECT count(*) FROM public.invoices i WHERE lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')) AS n$q$,
                FALSE, TRUE, '')))[1]::TEXT, '?') END,
    'informational, the same before and after 099 (099 changes no invoice): report both figures'
  UNION ALL SELECT 43, '100 needs: public.set_archive_state is 028''s (or already 100''s); customers_in_use_guard (082) present',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '4b31a2b95d2c7c52e9c31fe660a7e61b' THEN '028' WHEN '0b3bc80a57f0e0e16e4f0d7f42c5eccf' THEN '100' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'set_archive_state'), 'missing')
    || ' / guard ' || CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customers_in_use_guard') THEN 'present' ELSE 'missing' END,
    '028 / guard present before 100, 100 / guard present after (other or missing: stop, 100 refuses to replace it)'
  UNION ALL SELECT 44, '101 needs: assert_privileged_aal, _session_membership, support_readonly_guard and the audit log (033, 036)',
    (to_regprocedure('public.assert_privileged_aal()') IS NOT NULL AND to_regprocedure('public._session_membership()') IS NOT NULL
     AND to_regprocedure('public.support_readonly_guard()') IS NOT NULL AND to_regclass('security_audit.audit_log') IS NOT NULL)::TEXT,
    'true (101 replaces no existing object; its tables are new)'
  UNION ALL SELECT 45, '102 needs: organization_settings_guard_nav 058''s, user_profiles_guard 012''s (or already 102''s); admin_login_is_protected (093). Needs no 099 or 101 object',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'a3524f981c1f7b122d0935c837408d0d' THEN '058' WHEN '99579bb09f2fcf9458103b3128af20c8' THEN '102' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'organization_settings_guard_nav'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '4dd071f7e70fc10a633ad11f9f5c0180' THEN '012' WHEN '986ea8500279eb9724eae987797281a7' THEN '102' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'user_profiles_guard'), 'missing')
    || ' / ' || CASE WHEN to_regprocedure('public.admin_login_is_protected(uuid)') IS NOT NULL THEN '093 present' ELSE '093 missing' END,
    '058 / 012 / 093 present before 102, 102 / 102 / 093 present after (other or missing: stop, 102 refuses to replace it)'
  UNION ALL SELECT 46, '103 needs: 101 applied; ai_helper_reserve and ai_helper_settle 101''s (or already 103''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '8b9a4ec9293a5b6f0ddc8e505822c84f' THEN '101' WHEN 'c75e470a73e4d0e7508a27125f6f9e9c' THEN '103' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'ai_helper_reserve'), 'missing (101 not applied)')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'cd5ac6d43f9a5ade20815a82ed123717' THEN '101' WHEN 'ca5166191666584107491f95ccce4702' THEN '103' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'ai_helper_settle'), 'missing (101 not applied)'),
    '101 / 101 before 103, 103 / 103 after (missing: apply 101 first; other: stop, 103 refuses to replace it)'
  UNION ALL SELECT 47, '113 needs: public.reopen_job is 081''s (113 calls it for every reopen and replaces nothing)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '2fca7e7164a55f9f9e0744f8a0c6b50e' THEN '081' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'reopen_job'), 'missing'),
    '081 before and after 113 (other or missing: stop and report)'
  UNION ALL SELECT 48, '107 needs: the integrations layer (084) and is_platform_admin / assert_platform_aal (036)',
    (to_regclass('public.integration_connections') IS NOT NULL AND to_regprocedure('public.integration_oauth_consume(uuid,uuid,text,text)') IS NOT NULL
     AND to_regprocedure('public.is_platform_admin()') IS NOT NULL AND to_regprocedure('public.assert_platform_aal()') IS NOT NULL)::TEXT,
    'true (107 replaces no existing function; it widens three provider checks to add microsoft and adds two tables)'
  UNION ALL SELECT 49, '119 needs: public.session_is_active is 017''s and _session_membership 036''s (or already 119''s); may read auth.users.banned_until',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '19fe21959a87cd880feb0fb0190980eb' THEN '017' WHEN 'af6457cae4d8b89cd34b5963574fbe58' THEN '119' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'session_is_active'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'a15c6833cefc4b752ceafce0a10730b2' THEN '036' WHEN 'dd70574344856582b9819431b45e6c5c' THEN '119' WHEN '4fa415c7b3222def6c37e93353e804c2' THEN '121' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = '_session_membership'), 'missing')
    || ' / ' || CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'banned_until')
                     THEN has_column_privilege(current_user, 'auth.users', 'banned_until', 'SELECT')::TEXT ELSE 'no banned_until column' END,
    '017 / 036 / true before 119, 119 / 119 / true after (119 / 121 / true once 121 is applied; other: stop, 119 refuses to replace it)'
  UNION ALL SELECT 50, '119 (informational): logins banned now that still hold an active membership (their open tokens stop working when 119 is applied)',
    CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'banned_until') THEN 'n/a'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(DISTINCT u.id) AS n FROM auth.users u JOIN public.organization_members m ON m.user_id = u.id
                WHERE u.banned_until > now() AND m.active$q$, FALSE, TRUE, '')))[1]::TEXT, '?') END,
    'informational: report the figure (119 changes no row; those people already cannot sign in)'
  UNION ALL SELECT 51, '105 (informational): issued invoices now written off / write-offs with no WRITE_OFF_INVOICE audit row (made by a direct update before 105, or imported)',
    CASE WHEN NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'invoices' AND column_name = 'status') THEN 'n/a'
         ELSE coalesce((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) || ' / ' || count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM security_audit.audit_log a
                WHERE a.action = 'WRITE_OFF_INVOICE' AND a.entity_table = 'invoices' AND a.entity_id = i.id::TEXT)) AS n
                FROM public.invoices i WHERE lower(regexp_replace(coalesce(i.status, ''), '[^[:alpha:]]', '', 'g')) = 'writtenoff'$q$, FALSE, TRUE, '')))[1]::TEXT, '?') END,
    'informational, the same before and after 105 (105 changes no invoice): report both figures; from 105 a write-off is made only with Write off'
  UNION ALL SELECT 52, '121 needs: public._session_membership is 119''s (or already 121''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'dd70574344856582b9819431b45e6c5c' THEN '119' WHEN '4fa415c7b3222def6c37e93353e804c2' THEN '121' WHEN 'a15c6833cefc4b752ceafce0a10730b2' THEN '036' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = '_session_membership'), 'missing'),
    '119 before 121, 121 after (036: apply 119 first; other: stop, 121 refuses to replace it)'
  UNION ALL SELECT 53, '123 needs: quote_lifecycle_guard 076''s, create_sales_order_from_quote and revise_quote 068''s (or already 123''s)',
    coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '7aa38f2a95943427d522712998d84050' THEN '076' WHEN '3c01d528076221cdac11c72f7327ab02' THEN '123' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'quote_lifecycle_guard'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'ded57529317279dae221103631fe149a' THEN '068' WHEN 'a5371d31fde32e60ed7b2a23f40f1935' THEN '123' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'create_sales_order_from_quote'), 'missing')
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN 'd8e9f57c47c98731e57d66b699f7273c' THEN '068' WHEN 'dd78b559c44bf1effdc7e61109e1500c' THEN '123' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'revise_quote'), 'missing'),
    '076 / 068 / 068 before 123, 123 / 123 / 123 after (other: stop, 123 refuses to replace it)'
  UNION ALL SELECT 54, '124 needs: purchase_orders, quotes, jobs and enforce_same_org_parent; public.purchase_order_issue_lock is 076''s (or already 124''s)',
    (to_regclass('public.purchase_orders') IS NOT NULL AND to_regclass('public.quotes') IS NOT NULL AND to_regclass('public.jobs') IS NOT NULL
     AND to_regprocedure('public.enforce_same_org_parent()') IS NOT NULL)::TEXT
    || ' / ' || coalesce((SELECT CASE md5(regexp_replace(prosrc, '\s', '', 'g')) WHEN '27924815917836092f18d3dd58d87c23' THEN '076' WHEN '9f903e888bca6d55322cc877488c1019' THEN '124' ELSE 'other' END
              FROM fn WHERE nspname = 'public' AND proname = 'purchase_order_issue_lock'), 'missing'),
    'true / 076 before 124, true / 124 after (other: stop, 124 refuses to replace it)'
  UNION ALL SELECT 100 + row_number() OVER (), 'marker ' || migration, CASE WHEN present THEN 'applied' ELSE 'not applied' END,
    'before the release: 013 applied, 014 onwards as recorded in the sign-off; after: all applied'
  FROM markers
)
SELECT check_name AS "check", value, expected FROM checks ORDER BY n;
