-- READ ONLY. Migration 033 (pre-go-live hardening): run in a read-only transaction AFTER applying 033 on a hosted project.
-- Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (check | value | expected). All "true" except the two counts (checks 5 and 10), which are listed after the check:
WITH
fn AS (SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'security_audit')),
trg AS (SELECT t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal)
SELECT * FROM (VALUES
  (1, 'Storage session check policy exists (revoked sessions lose file access)',
      (SELECT to_regclass('storage.objects') IS NULL OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'storage requires active session' AND permissive = 'RESTRICTIVE'))::text, 'true'),
  (2, 'Invoices, quotes and purchase orders can only be created as drafts by the API roles',
      (SELECT count(*) = 3 FROM trg WHERE tgname IN ('invoices_start_as_drafts', 'quotes_start_as_drafts', 'purchase_orders_start_as_drafts'))::text, 'true'),
  (3, 'Job e-mail outcome functions exist',
      (SELECT count(DISTINCT proname) = 3 FROM fn WHERE proname IN ('complete_job_email', 'resolve_job_email', 'expire_stale_job_emails'))::text, 'true'),
  (4, 'Job e-mail ledger has outcomes (status column)',
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'security_audit' AND table_name = 'email_send_ledger' AND column_name = 'status')::text, 'true'),
  (5, 'Admin two-step rule exists, and is OFF by default (companies requiring it: expected 0 until admins have enrolled)',
      (SELECT count(*) FROM public.organizations WHERE require_admin_mfa)::text, '0'),
  (6, 'Admin two-step rule is enforced inside the database: the check function exists, 16 tables carry the admin_mfa trigger and 14 privileged functions call the check',
      -- Named, not counted, so the check still answers 'true' after later migrations add the rule to more tables and functions.
      ((SELECT count(DISTINCT t.tgrelid) = 16 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'admin_mfa' AND t.tgrelid IN (
          'public.invoices'::regclass, 'public.invoice_line_items'::regclass, 'public.invoice_payments'::regclass, 'public.quotes'::regclass,
          'public.quote_line_items'::regclass, 'public.purchase_orders'::regclass, 'public.sales_orders'::regclass, 'public.organization_settings'::regclass,
          'public.organization_members'::regclass, 'public.user_profiles'::regclass, 'public.organizations'::regclass, 'public.email_history'::regclass,
          'public.inbound_emails'::regclass, 'public.mail_poll_state'::regclass, 'security_audit.email_send_ledger'::regclass, 'security_audit.mail_send_ledger'::regclass))
        AND EXISTS (SELECT 1 FROM fn WHERE proname = 'assert_privileged_aal')
        AND (SELECT count(DISTINCT p.proname) = 14 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosrc LIKE '%assert_privileged_aal()%'
             AND p.proname IN ('record_invoice_payment', 'reverse_invoice_payment', 'confirm_invoice_payments', 'issue_invoice', 'convert_sales_order', 'set_member_access',
                               'reserve_mail_send', 'complete_mail_send', 'resolve_mail_send', 'save_mail_poll_state', 'record_inbound_email', 'reserve_job_email',
                               'complete_job_email', 'resolve_job_email')))::text, 'true'),
  (7, 'Invoice tax point column exists',
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'tax_point')::text, 'true'),
  (8, 'Error alert budget function exists, callable by the service role only',
      (EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'claim_error_alert' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')))::text, 'true'),
  (9, 'Convert-order function takes the per-company job number lock',
      (SELECT position('job-no:' IN pg_get_functiondef(p.oid)) > 0 FROM pg_proc p WHERE p.proname = 'convert_sales_order')::text, 'true'),
  (10, 'Job e-mails still marked sending after the migration (expected 0; they become unknown after ten minutes)',
      (SELECT count(*) FROM security_audit.email_send_ledger WHERE status = 'sending')::text, '0'),
  (11, 'Job e-mail ledger keeps one row per attempt (attempt and retry_of columns, one row per key and attempt)',
      ((SELECT count(*) = 2 FROM information_schema.columns WHERE table_schema = 'security_audit' AND table_name = 'email_send_ledger' AND column_name IN ('attempt', 'retry_of'))
        AND to_regclass('security_audit.email_send_ledger_key_attempt') IS NOT NULL)::text, 'true')
) AS v(n, check_name, value, expected)
ORDER BY n;
