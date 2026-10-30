-- Migration 115 (the browser error alert budget). Read only: every row should be TRUE (5).
SELECT 'table_closed' AS check_name,
  to_regclass('security_audit.browser_error_alerts') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.table_schema = 'security_audit' AND g.table_name = 'browser_error_alerts'
                  AND g.grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')) AS ok
UNION ALL SELECT 'table_columns',
  (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'security_audit' AND table_name = 'browser_error_alerts')
    = 'claimed_at,company_id,fingerprint,id,user_id'
UNION ALL SELECT 'function_definer_service_role_only',
  coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('service_role', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.claim_browser_error_alert(text,uuid,uuid)')), FALSE)
UNION ALL SELECT 'budgets_are_5_10_20',
  coalesce((SELECT position('>= 5 THEN' IN prosrc) > 0 AND position('>= 10 THEN' IN prosrc) > 0 AND position('>= 20 THEN' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.claim_browser_error_alert(text,uuid,uuid)')), FALSE)
-- Server and cron alerts are still 033's: the one-argument function is there, service role only, and still counts only its own table.
UNION ALL SELECT 'server_alert_function_untouched',
  coalesce((SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   AND position('security_audit.error_alerts' IN p.prosrc) > 0 AND position('browser_error_alerts' IN p.prosrc) = 0
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.claim_error_alert(text)')), FALSE);
