-- Migration 133 (the AI helper before it is switched on: E9 Q4 cap, Q6 retention). Read only: every row should be TRUE (5).
-- Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'), to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)'),
                  to_regprocedure('public.ai_helper_purge_requests(integer)'))
)
-- Q4: reserve is 133's (the stale sweep charges in full), its answer still carries no 'key_enc' (103); definer, pinned, signed-in users only.
SELECT 'reserve_is_133' AS check_name,
  coalesce((SELECT body = '972540e833a42bbb35ac5b670c56daa8' AND position('''key_enc''' IN prosrc) = 0 AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            FROM fn WHERE proname = 'ai_helper_reserve'), FALSE) AS ok
-- Q4: settle is 133's (a swept request's charge stands) and still the service role's only.
UNION ALL SELECT 'settle_is_133_service_role_only',
  coalesce((SELECT body = '7e04d0ab645ec24dc0f0acb78c222702' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('service_role', oid, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = 'ai_helper_settle'), FALSE)
-- Q6: the purge is 133's and the service role's only (not authenticated, anon or PUBLIC).
UNION ALL SELECT 'purge_service_role_only',
  coalesce((SELECT body = 'c4b0d7f39cec1f23c6bd1d5e31e59fa9' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('service_role', oid, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = 'ai_helper_purge_requests'), FALSE)
-- Q6: nobody signed in may delete a request directly (only the purge deletes); the table's row rules are 101's (select only).
UNION ALL SELECT 'requests_not_deletable_by_users',
  NOT has_table_privilege('authenticated', 'public.ai_helper_requests', 'DELETE') AND NOT has_table_privilege('anon', 'public.ai_helper_requests', 'DELETE')
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_helper_requests'::regclass)
  AND (SELECT count(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_helper_requests' AND cmd = 'SELECT')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_helper_requests' AND cmd <> 'SELECT')
-- The ledger's own limits are 101's: reserved and spent never below zero.
UNION ALL SELECT 'ledger_constraints_unchanged',
  (SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'public.ai_helper_usage'::regclass AND conname IN ('ai_helper_usage_reserved', 'ai_helper_usage_spent'));
