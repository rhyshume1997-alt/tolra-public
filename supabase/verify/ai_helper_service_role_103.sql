-- Migration 103 (the AI helper's key and settle are the server's). Read only: every row should be TRUE (4). Bodies are compared with
-- every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'), to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)'))
)
-- S2: ai_helper_reserve is 103's (101's without the key in its answer); still definer, pinned and signed-in only.
SELECT 'reserve_returns_no_key' AS check_name,
  coalesce((SELECT body = 'c75e470a73e4d0e7508a27125f6f9e9c' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            FROM fn WHERE proname = 'ai_helper_reserve'), FALSE)
-- S3: ai_helper_settle is 103's and callable by the service role only (not authenticated, anon or PUBLIC).
UNION ALL SELECT 'settle_service_role_only',
  coalesce((SELECT body = 'ca5166191666584107491f95ccce4702' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('service_role', oid, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = 'ai_helper_settle'), FALSE)
-- The key table: readable by the service role (the server), by no signed-in role; still no policy at all.
UNION ALL SELECT 'secrets_service_role_only',
  has_table_privilege('service_role', 'public.ai_helper_secrets', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.ai_helper_secrets', 'SELECT') AND NOT has_table_privilege('anon', 'public.ai_helper_secrets', 'SELECT')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_helper_secrets')
-- 101's other four app functions are untouched: still signed-in only.
UNION ALL SELECT 'other_app_functions_signed_in_only',
  (SELECT count(*) = 4 AND bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.ai_helper_status()'), to_regprocedure('public.ai_helper_save_settings(boolean,boolean,integer)'),
                                  to_regprocedure('public.ai_helper_set_key(text,text)'), to_regprocedure('public.ai_helper_decide(uuid,text,uuid)')));
