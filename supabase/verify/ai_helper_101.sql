-- Migration 101 (the AI admin helper's tables and functions). Read only: every row should be TRUE (12).
WITH t AS (
  SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('ai_helper_settings', 'ai_helper_secrets', 'ai_helper_usage', 'ai_helper_requests')
), f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.ai_helper_status()'), to_regprocedure('public.ai_helper_save_settings(boolean,boolean,integer)'),
                  to_regprocedure('public.ai_helper_set_key(text,text)'), to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'),
                  to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)'), to_regprocedure('public.ai_helper_decide(uuid,text,uuid)'))
)
-- The four tables exist, each with row level security on.
SELECT 'four_tables_rls_on' AS check_name, (SELECT count(*) = 4 AND bool_and(relrowsecurity) FROM t) AS ok
-- Signed-in users may only read settings, usage and requests; the secrets table grants nothing; anon nothing anywhere.
UNION ALL SELECT 'grants_select_only',
  has_table_privilege('authenticated', 'public.ai_helper_settings', 'SELECT') AND has_table_privilege('authenticated', 'public.ai_helper_usage', 'SELECT')
  AND has_table_privilege('authenticated', 'public.ai_helper_requests', 'SELECT')
  AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name LIKE 'ai\_helper\_%'
                  AND (g.grantee = 'anon' OR (g.grantee = 'authenticated' AND g.privilege_type <> 'SELECT')))
-- The secrets table: no grant and no policy at all.
UNION ALL SELECT 'secrets_closed',
  NOT has_table_privilege('authenticated', 'public.ai_helper_secrets', 'SELECT')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_helper_secrets')
-- One SELECT policy each on the three readable tables: the caller's company, admin or office.
UNION ALL SELECT 'select_policies_company_admin_office',
  (SELECT count(*) = 3 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('ai_helper_settings', 'ai_helper_usage', 'ai_helper_requests')
     AND cmd = 'SELECT' AND qual LIKE '%current_user_organization_id()%' AND qual LIKE '%admin%office%')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'ai\_helper\_%' AND cmd <> 'SELECT')
-- Both features off and no cap by default.
UNION ALL SELECT 'off_by_default',
  (SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings'
     AND ((column_name IN ('roundup_enabled', 'rfq_enabled') AND column_default = 'false') OR (column_name = 'monthly_cap_pence' AND column_default = '0')))
-- The cap ledger: one row per company per month, neither figure below zero.
UNION ALL SELECT 'usage_month_key_and_checks',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ai_helper_usage'::regclass AND contype = 'p')
  AND (SELECT count(*) = 3 FROM pg_constraint WHERE conrelid = 'public.ai_helper_usage'::regclass AND contype = 'c')
-- Every table carries the support read-only and admin second-step guards, and nothing else (no row audit: no ciphertext in the log).
UNION ALL SELECT 'guards_on_every_table',
  (SELECT count(*) = 8 FROM pg_trigger tg JOIN t ON t.oid = tg.tgrelid WHERE NOT tg.tgisinternal AND tg.tgname IN ('support_read_only', 'admin_mfa'))
  AND (SELECT count(*) = 8 FROM pg_trigger tg JOIN t ON t.oid = tg.tgrelid WHERE NOT tg.tgisinternal)
-- The six app functions: definer, pinned search_path, signed-in only. From 102, ai_helper_settle is the server's (service role) only:
-- either form passes here; supabase/verify/security_guards_102.sql checks 102's.
UNION ALL SELECT 'functions_definer_signed_in_only',
  (SELECT count(*) = 6 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                                    AND (has_function_privilege('authenticated', oid, 'EXECUTE')
                                         OR (proname = 'ai_helper_settle' AND has_function_privilege('service_role', oid, 'EXECUTE')))) FROM f)
-- The two internal helpers: callable by no signed-in user.
UNION ALL SELECT 'internal_helpers_closed',
  to_regprocedure('public._ai_helper_audit(uuid,text,text,text,jsonb)') IS NOT NULL AND to_regprocedure('public._ai_helper_caller(text[])') IS NOT NULL
  AND NOT has_function_privilege('authenticated', 'public._ai_helper_audit(uuid,text,text,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public._ai_helper_caller(text[])', 'EXECUTE')
-- The reserve is one guarded UPDATE against the cap.
UNION ALL SELECT 'reserve_checks_cap',
  coalesce((SELECT position('u.reserved_pence + u.spent_pence + p_estimate_pence' IN prosrc) > 0 AND position('monthly_cap_pence' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)')), FALSE)
-- The audit log's own functions are untouched by 101 (095's bodies) and the log keeps its append-only guard.
UNION ALL SELECT 'audit_functions_still_095',
  coalesce((SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '7e8d396511ddb056daa61953bfccd12b' FROM pg_proc WHERE oid = to_regprocedure('public.audit_event_allowed(text,text)')), FALSE)
  AND coalesce((SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = 'a6531bb5559ae9936387729bb91071a0' FROM pg_proc WHERE oid = to_regprocedure('public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)')), FALSE)
UNION ALL SELECT 'audit_log_append_only',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'security_audit.audit_log'::regclass AND tgname = 'audit_log_prevent_mutation' AND tgenabled = 'O');
