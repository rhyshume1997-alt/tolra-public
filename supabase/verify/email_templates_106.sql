-- Migration 106 (company e-mail templates and the finance check's per-company switch). Read only: every row should be TRUE (8).
WITH p AS (
  SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_templates'
)
-- The table exists with row level security on.
SELECT 'email_templates_rls_on' AS check_name,
  coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.email_templates')), FALSE) AS ok
-- One template per company per key; the eight keys only.
UNION ALL SELECT 'one_row_per_company_key',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.email_templates') AND conname = 'email_templates_org_key' AND contype = 'u')
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.email_templates') AND conname = 'email_templates_key' AND contype = 'c')
-- Members of the company read; admin and office write; one policy per command, none FOR ALL.
UNION ALL SELECT 'policies_member_read_office_write',
  (SELECT count(*) = 4 FROM p)
  AND EXISTS (SELECT 1 FROM p WHERE cmd = 'SELECT' AND qual LIKE '%current_user_organization_id()%' AND qual NOT LIKE '%has_org_role%')
  AND (SELECT count(*) = 3 FROM p WHERE cmd IN ('INSERT', 'UPDATE', 'DELETE')
         AND coalesce(qual, with_check) LIKE '%current_user_organization_id()%' AND coalesce(qual, with_check) LIKE '%admin%office%')
-- Signed-in users only; anon nothing.
UNION ALL SELECT 'grants',
  CASE WHEN to_regclass('public.email_templates') IS NULL THEN FALSE ELSE
    has_table_privilege('authenticated', 'public.email_templates', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('anon', 'public.email_templates', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.email_templates', 'TRUNCATE') END
-- Stamp, row audit, support read-only and admin second step.
UNION ALL SELECT 'triggers',
  (SELECT count(*) = 4 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.email_templates') AND NOT t.tgisinternal
     AND t.tgname IN ('email_templates_stamp', 'audit_email_templates_changes', 'support_read_only', 'admin_mfa'))
-- The finance check switch: off by default, never NULL.
UNION ALL SELECT 'finance_check_enabled_off_by_default',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings'
          AND column_name = 'finance_check_enabled' AND is_nullable = 'NO' AND column_default = 'false')
-- ai_helper_settings still has no write grant (only the functions write).
UNION ALL SELECT 'ai_helper_settings_still_select_only',
  NOT has_table_privilege('authenticated', 'public.ai_helper_settings', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.ai_helper_settings', 'UPDATE')
-- The admin's switch function: definer, pinned search_path, signed-in only.
UNION ALL SELECT 'set_finance_check_definer_signed_in_only',
  coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p
            WHERE p.oid = to_regprocedure('public.ai_helper_set_finance_check(boolean)')), FALSE)
  AND CASE WHEN to_regprocedure('public.ai_helper_set_finance_check(boolean)') IS NULL THEN FALSE ELSE
    has_function_privilege('authenticated', 'public.ai_helper_set_finance_check(boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.ai_helper_set_finance_check(boolean)', 'EXECUTE') END;
